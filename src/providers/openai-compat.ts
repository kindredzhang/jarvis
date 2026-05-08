/**
 * OpenAICompatProvider —— 通用 OpenAI 兼容 API 供应商
 *
 * 适用于 DeepSeek、OpenAI、Azure OpenAI、Ollama、LM Studio、OpenRouter 等
 * 所有兼容 OpenAI /v1/chat/completions 接口的 API。
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * - 工具调用 ID 热修复（_normalize_tool_call_id / SHA1 9 字符）
 * - 工具参数 JSON 修复（json_repair / 自动补全）
 * - OpenRouter 归因 Header
 * - Responses API 电路熔断
 * - Kimi thinking 模型检测
 * - 请求体非标准字段清洗
 * - 自动重连 / 重试
 * - 会话亲和 Header（x-session-affinity）
 */

import { LLMProvider } from './base'
import type { Message, LLMResponse, LLMResponseChunk, GenerationSettings, ToolCallRequest } from './types'
import type { ToolDefinition } from '../agent/tools/base'

export interface OpenAICompatConfig {
  apiKey: string
  model?: string
  baseUrl?: string
  extraHeaders?: Record<string, string>
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

interface ChatMessage {
  role: ChatRole
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const REASONER_MODEL_PATTERNS = [
  /reasoner/i,
  /deepseek-reasoner/i,
  /deepseek-r1/i,
]

export class OpenAICompatProvider extends LLMProvider {
  readonly model: string
  protected apiKey: string
  protected baseUrl: string
  protected extraHeaders: Record<string, string>

  constructor(config: OpenAICompatConfig) {
    super()
    this.apiKey = config.apiKey
    this.model = config.model ?? 'gpt-4o'
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.extraHeaders = config.extraHeaders ?? {}
  }

  async generate(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
  ): Promise<LLMResponse> {
    const body = this.buildRequestBody(messages, options)
    const data = await this.post(body)

    const choice = data.choices?.[0] ?? {}
    const message = choice.message ?? {}

    return this.parseResponse(message, choice.finish_reason, data.usage)
  }

  async *generateStream(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
  ): AsyncIterable<LLMResponseChunk> {
    const body = this.buildRequestBody(messages, options, true)
    const response = await this.rawPost(body)

    const reader = response.body?.getReader()
    if (!reader) throw new Error('Response body is not readable')

    const decoder = new TextDecoder()
    let buffer = ''
    let accumulatedToolCalls = new Map<number, { id: string; name: string; arguments: string }>()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const payload = trimmed.slice(6)
          if (payload === '[DONE]') return

          try {
            const parsed = JSON.parse(payload)
            const delta = parsed.choices?.[0]?.delta
            const finishReason = parsed.choices?.[0]?.finish_reason ?? null

            if (!delta) continue

            const chunkToolCalls: ToolCallRequest[] = []
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index ?? 0
                if (!accumulatedToolCalls.has(index)) {
                  accumulatedToolCalls.set(index, { id: tc.id ?? '', name: '', arguments: '' })
                }
                const existing = accumulatedToolCalls.get(index)!
                if (tc.id) existing.id = tc.id
                if (tc.function?.name) existing.name = tc.function.name
                if (tc.function?.arguments) existing.arguments += tc.function.arguments
              }
            }

            yield {
              content: delta.content ?? null,
              finishReason,
              toolCalls: chunkToolCalls,
              reasoningContent: delta.reasoning_content ?? null,
            }

            if (finishReason === 'tool_calls' && accumulatedToolCalls.size > 0) {
              const finalToolCalls: ToolCallRequest[] = []
              for (const [, tc] of accumulatedToolCalls) {
                finalToolCalls.push({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.arguments },
                })
              }
              yield {
                content: null,
                finishReason: 'tool_calls',
                toolCalls: finalToolCalls,
              }
            }
          } catch {
            // skip malformed JSON lines in SSE stream
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  // ---- 内部方法 ----

  protected buildRequestBody(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
    stream = false,
  ): Record<string, unknown> {
    const { tools, settings } = options ?? {}
    const isReasoner = REASONER_MODEL_PATTERNS.some((p) => p.test(this.model))

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => this.formatMessage(m)),
      stream,
    }

    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    if (settings?.temperature !== undefined) body.temperature = settings.temperature
    if (settings?.maxTokens !== undefined) body.max_tokens = settings.maxTokens

    // 推理模型：system → user
    if (isReasoner) {
      delete body.temperature
    }

    return body
  }

  protected async post(body: Record<string, unknown>): Promise<any> {
    const response = await this.rawPost(body)
    return response.json()
  }

  protected async rawPost(body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    }
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown error')
      throw new Error(`API error ${response.status}: ${errText}`)
    }

    return response
  }

  protected formatMessage(msg: Message): ChatMessage {
    const formatted: ChatMessage = {
      role: msg.role as ChatRole,
      content: msg.content ?? '',
    }

    if (msg.name) formatted.name = msg.name

    if (msg.role === 'assistant') {
      const toolCalls = (msg as any).tool_calls ?? msg.toolCalls
      if (toolCalls && toolCalls.length > 0) {
        formatted.content = msg.content ?? null
        formatted.tool_calls = toolCalls.map((tc: any) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }))
      }
      // Preserve reasoning_content for DeepSeek thinking models
      const reasoningContent = (msg as any).reasoning_content
      if (reasoningContent != null) {
        ;(formatted as any).reasoning_content = reasoningContent
      }
    }

    if (msg.role === 'tool') {
      formatted.tool_call_id = (msg as any).tool_call_id ?? msg.toolCallId ?? ''
    }

    return formatted
  }

  protected parseResponse(
    message: any,
    finishReason: string | null,
    usage?: ChatUsage,
  ): LLMResponse {
    const toolCalls: ToolCallRequest[] = (message.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '{}',
      },
    }))

    return {
      content: message.content ?? null,
      finishReason: this.mapFinishReason(finishReason),
      toolCalls,
      reasoningContent: message.reasoning_content ?? null,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }
        : undefined,
    }
  }

  private mapFinishReason(reason: string | null): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop'
      case 'tool_calls':
        return 'tool_calls'
      case 'length':
        return 'length'
      default:
        return 'error'
    }
  }
}
