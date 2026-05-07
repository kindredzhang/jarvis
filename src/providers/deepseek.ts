/**
 * DeepSeekProvider —— DeepSeek API 供应商实现
 *
 * 使用 fetch 直连 DeepSeek API，兼容 OpenAI 接口格式。
 * 支持:
 * - 非流式生成 (generate)
 * - 流式生成 (generateStream)
 * - 函数/工具调用
 * - DeepSeek-R1 思考过程提取
 * ========= 注意事项 =========
 *
 * 不要在 `function` 字段中传入中文字段（包括 description），否则 DeepSeek 可能会报错。
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * 以下功能在 nanobot/providers/openai_compat_provider.py 中存在，本文件暂未实现：
 * - 工具调用 ID 规范化：_normalize_tool_call_id (SHA1 哈希 9 字符)
 * - 工具调用参数规范化：_normalize_tool_call_arguments (json_repair)
 * - 环境变量配置：_setup_env (根据 ProviderSpec 注入 API key/base)
 * - 会话亲和 Header：x-session-affinity
 * - OpenRouter 归因 Header
 * - Responses API 电路熔断：_responses_failures / _responses_tripped_at
 * - Kimi thinking 模型检测：_is_kimi_thinking_model
 * - 请求体非标准字段清洗：_ALLOWED_MSG_KEYS 过滤
 * - 流式 SSE 连接级错误处理与自动重连
 */
import { LLMProvider } from './base'
import type { Message, LLMResponse, LLMResponseChunk, GenerationSettings, ToolCallRequest } from './types'
import type { ToolDefinition } from '../agent/tools/base'

export interface DeepSeekConfig {
  apiKey: string
  model?: string
  baseUrl?: string
}

type DeepSeekRole = 'system' | 'user' | 'assistant' | 'tool'

interface DeepSeekMessage {
  role: DeepSeekRole
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

interface DeepSeekUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

type DeepSeekFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | null

export class DeepSeekProvider extends LLMProvider {
  readonly model: string
  private apiKey: string
  private baseUrl: string

  constructor(config: DeepSeekConfig) {
    super()
    this.apiKey = config.apiKey
    this.model = config.model ?? 'deepseek-chat'
    this.baseUrl = (config.baseUrl ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '')
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
    let accumulatedToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()

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

            // 处理工具调用增量
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
            }

            // 最后一个块：补充完整的 tool_calls
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
            // 跳过格式错误的 JSON 行
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  // ---- 内部方法 ----

  private buildRequestBody(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
    stream = false,
  ): Record<string, unknown> {
    const { tools, settings } = options ?? {}
    const hasReasoner = this.model.includes('reasoner')

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

    // DeepSeek-R1 等推理模型需要特殊处理
    if (hasReasoner) {
      // 推理模型不支持 system 消息，转成 user
      // 不支持 temperature 等参数
      delete body.temperature
    }

    return body
  }

  private async post(body: Record<string, unknown>): Promise<any> {
    const response = await this.rawPost(body)
    return response.json()
  }

  private async rawPost(body: Record<string, unknown>): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown error')
      throw new Error(`DeepSeek API error ${response.status}: ${errText}`)
    }

    return response
  }

  private formatMessage(msg: Message): DeepSeekMessage {
    const formatted: DeepSeekMessage = {
      role: msg.role as DeepSeekRole,
      content: msg.content ?? '',
    }

    if (msg.name) formatted.name = msg.name

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      formatted.content = msg.content ?? null
      formatted.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }))
    }

    if (msg.role === 'tool' && msg.toolCallId) {
      formatted.tool_call_id = msg.toolCallId
    }

    return formatted
  }

  private parseResponse(
    message: any,
    finishReason: string | null,
    usage?: DeepSeekUsage,
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
