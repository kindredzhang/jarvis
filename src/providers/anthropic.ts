/**
 * AnthropicProvider —— Anthropic/Claude API 供应商
 *
 * 使用 fetch 直连 Anthropic Messages API。
 * 消息格式与 OpenAI 完全不同：
 * - 内容为 ContentBlock 数组而非字符串
 * - 工具调用是 content 中的 tool_use block
 * - 工具结果是 user 消息中的 tool_result block
 * - system prompt 是独立顶层字段
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * - 流式生成（SSE content_block_delta 解析）
 * - Extended Thinking（thinking block 解析）
 * - Prompt caching（cache_control 标记）
 * - tool_choice 精细化控制
 * - 错误类型分类与重试
 * - _merge_consecutive 同角色消息合并
 * - 图片 block 转换（image_url → image source）
 * - _handle_error 精细化错误处理
 */

import { LLMProvider } from './base'
import type { Message, LLMResponse, LLMResponseChunk, GenerationSettings, ToolCallRequest } from './types'
import type { ToolDefinition } from '../agent/tools/base'

export interface AnthropicConfig {
  apiKey: string
  model?: string
  baseUrl?: string
  maxTokens?: number
}

// ---- Anthropic 内容块类型 ----

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

interface AnthropicToolDef {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_MAX_TOKENS = 4096

export class AnthropicProvider extends LLMProvider {
  readonly model: string
  private apiKey: string
  private baseUrl: string
  private maxTokens: number

  constructor(config: AnthropicConfig) {
    super()
    this.apiKey = config.apiKey
    this.model = config.model ?? 'claude-sonnet-4-20250514'
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  }

  async generate(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
  ): Promise<LLMResponse> {
    const body = this.buildRequestBody(messages, options)
    const data = await this.post(body)
    return this.parseResponse(data)
  }

  async *generateStream(
    _messages: Message[],
    _options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
  ): AsyncIterable<LLMResponseChunk> {
    // TODO: implement SSE streaming with content_block_delta parsing
    throw new Error('Streaming not yet implemented for Anthropic')
  }

  // ---- 内部方法 ----

  private buildRequestBody(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
    _stream = false,
  ): Record<string, unknown> {
    const { tools, settings } = options ?? {}

    const { system, anthropicMessages } = this.convertMessages(messages)

    const body: Record<string, unknown> = {
      model: this.model,
      messages: anthropicMessages,
      max_tokens: settings?.maxTokens ?? this.maxTokens,
    }

    if (system) {
      body.system = typeof system === 'string' ? system : system
    }

    const anthropicTools = this.convertTools(tools)
    if (anthropicTools) {
      body.tools = anthropicTools
    }

    if (settings?.temperature !== undefined) {
      body.temperature = settings.temperature
    }

    return body
  }

  /** 转换 messages 为 Anthropic 格式：提取 system，转换 role/content */
  convertMessages(
    messages: Message[],
  ): { system: string; anthropicMessages: AnthropicMessage[] } {
    let system = ''
    const raw: { role: 'user' | 'assistant'; content: ContentBlock[] }[] = []

    for (const msg of messages) {
      const role = msg.role as string
      const content = msg.content
      const contentStr = typeof content === 'string' ? content : ''

      if (role === 'system') {
        system = contentStr
        continue
      }

      if (role === 'tool') {
        // tool 消息 → tool_result block，嵌入 user 消息中
        const block: ContentBlock = {
          type: 'tool_result',
          tool_use_id: (msg as any).tool_call_id ?? msg.toolCallId ?? '',
          content: contentStr,
        }
        const last = raw[raw.length - 1]
        if (raw.length > 0 && last && last.role === 'user') {
          (last.content as ContentBlock[]).push(block)
        } else {
          raw.push({ role: 'user', content: [block] })
        }
        continue
      }

      if (role === 'assistant') {
        raw.push({
          role: 'assistant',
          content: this.assistantBlocks(msg),
        })
        continue
      }

      if (role === 'user') {
        raw.push({
          role: 'user',
          content: [{ type: 'text', text: contentStr || '(empty)' }],
        })
        continue
      }
    }

    return { system, anthropicMessages: raw }
  }

  /** 构建 assistant 消息的 content blocks */
  private assistantBlocks(msg: Message): ContentBlock[] {
    const blocks: ContentBlock[] = []

    if (msg.content && typeof msg.content === 'string') {
      blocks.push({ type: 'text', text: msg.content })
    }

    const toolCalls = (msg as any).tool_calls ?? msg.toolCalls
    if (toolCalls && Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const func = tc.function ?? {}
        let input: Record<string, unknown> = {}
        try {
          input = typeof func.arguments === 'string' ? JSON.parse(func.arguments) : (func.arguments ?? {})
        } catch {
          input = {}
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: func.name ?? '',
          input,
        })
      }
    }

    return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
  }

  /** 转换工具定义：OpenAI format → Anthropic input_schema */
  private convertTools(tools?: ToolDefinition[]): AnthropicToolDef[] | undefined {
    if (!tools || tools.length === 0) return undefined

    return tools.map((t) => {
      const func = (t as any).function ?? t
      const result: AnthropicToolDef = {
        name: func.name ?? '',
        input_schema: func.parameters ?? { type: 'object', properties: {} },
      }
      if (func.description) {
        result.description = func.description
      }
      return result
    })
  }

  /** 解析 Anthropic API 响应 → LLMResponse */
  private parseResponse(data: any): LLMResponse {
    const contentParts: string[] = []
    const toolCalls: ToolCallRequest[] = []

    const blocks: any[] = data.content ?? []
    for (const block of blocks) {
      if (block.type === 'text') {
        contentParts.push(block.text)
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name ?? '',
            arguments: typeof block.input === 'object' ? JSON.stringify(block.input) : '{}',
          },
        })
      }
    }

    const stopMap: Record<string, 'stop' | 'tool_calls' | 'length' | 'error'> = {
      end_turn: 'stop',
      tool_use: 'tool_calls',
      max_tokens: 'length',
    }
    const finishReason = stopMap[data.stop_reason] ?? 'error'

    const usageData: AnthropicUsage | undefined = data.usage
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
    if (usageData) {
      const inputTokens = usageData.input_tokens
      const cacheCreation = usageData.cache_creation_input_tokens ?? 0
      const cacheRead = usageData.cache_read_input_tokens ?? 0
      const totalPromptTokens = inputTokens + cacheCreation + cacheRead
      usage = {
        promptTokens: totalPromptTokens,
        completionTokens: usageData.output_tokens,
        totalTokens: totalPromptTokens + usageData.output_tokens,
      }
    }

    return {
      content: contentParts.join('') || null,
      finishReason,
      toolCalls,
      usage,
    }
  }

  /** POST 请求 */
  private async post(body: Record<string, unknown>): Promise<any> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown error')
      throw new Error(`Anthropic API error ${response.status}: ${errText}`)
    }

    return response.json()
  }
}
