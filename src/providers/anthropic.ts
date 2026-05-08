/**
 * AnthropicProvider —— Anthropic/Claude API provider
 *
 * Ported from Python original providers/anthropic_provider.py.
 * Uses raw fetch (not SDK) for Messages API with SSE streaming.
 */

import { LLMProvider } from './base'
import type { Message, LLMResponse, LLMResponseChunk, GenerationSettings } from './types'
import type { ToolDefinition } from '../agent/tools/base'

export interface AnthropicConfig {
  apiKey: string
  model?: string
  baseUrl?: string
  maxTokens?: number
  extraHeaders?: Record<string, string>
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_MAX_TOKENS = 4096
const ANTHROPIC_VERSION = '2023-06-01'

// ---- ID generation (mirrors Python's _gen_tool_id) ----

const _ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

function _genToolId(): string {
  let id = 'toolu_'
  for (let i = 0; i < 22; i++) {
    id += _ALNUM[Math.floor(Math.random() * _ALNUM.length)]
  }
  return id
}

// ---- SSE stream parser ----

interface SSEMessage {
  event: string
  data: string
}

async function* parseSSE(response: Response): AsyncGenerator<SSEMessage> {
  const reader = response.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''
  let currentData = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') {
          // Empty line = end of event
          if (currentData) {
            yield { event: currentEvent, data: currentData }
          }
          currentEvent = ''
          currentData = ''
          continue
        }
        if (trimmed.startsWith('event: ')) {
          currentEvent = trimmed.slice(7).trim()
        } else if (trimmed.startsWith('data: ')) {
          currentData = trimmed.slice(6)
        }
      }
    }

    // Flush remaining
    const tail = buffer.trim()
    if (tail) {
      if (tail.startsWith('event: ')) {
        currentEvent = tail.slice(7).trim()
      } else if (tail.startsWith('data: ')) {
        currentData = tail.slice(6)
      }
    }
    if (currentData) {
      yield { event: currentEvent, data: currentData }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---- Content block types ----

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content?: unknown }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'image'; source: { type: string; media_type?: string; data?: string; url?: string } }

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
  cache_control?: Record<string, string>
}

export class AnthropicProvider extends LLMProvider {
  readonly model: string
  private apiKey: string
  private baseUrl: string
  private maxTokens: number
  private extraHeaders: Record<string, string>

  constructor(config: AnthropicConfig) {
    super()
    this.apiKey = config.apiKey
    this.model = config.model ?? 'claude-sonnet-4-20250514'
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
    this.extraHeaders = config.extraHeaders ?? {}
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  async generate(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
  ): Promise<LLMResponse> {
    const kwargs = this._buildKwargs(messages as unknown as Record<string, unknown>[], options as any)
    try {
      const response = await this._post(kwargs, false)
      return this._parseResponse(response)
    } catch (e: unknown) {
      return this._handleError(e)
    }
  }

  async *generateStream(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
  ): AsyncIterable<LLMResponseChunk> {
    const kwargs = this._buildKwargs(messages as unknown as Record<string, unknown>[], options as any, true)
    kwargs.stream = true

    let response: Response
    try {
      response = await this._rawPost(kwargs)
    } catch (e: unknown) {
      // Can't yield error through async generator, emit as chunk
      const msg = e instanceof Error ? e.message : String(e)
      yield { content: `Error calling LLM: ${msg}`, finishReason: 'error', toolCalls: [] }
      return
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown error')
      yield {
        content: `Error: Anthropic API error ${response.status}: ${errText.slice(0, 500)}`,
        finishReason: 'error',
        toolCalls: [],
      }
      return
    }

    // SSE parsing
    let contentPieces: string[] = []
    const toolCalls: { id: string; name: string; args: string; chunk: boolean }[] = []
    let currentToolId: string | null = null
    let currentToolName: string | null = null

    try {
      for await (const sse of parseSSE(response)) {
        if (!sse.data || sse.data === '') continue

        let parsed: any
        try {
          parsed = JSON.parse(sse.data)
        } catch {
          continue
        }

        const type = parsed.type ?? ''
        const index = parsed.index ?? 0

        if (type === 'message_start') {
          // no-op on stream start, usage from message_delta
        } else if (type === 'content_block_start') {
          const block = parsed.content_block ?? {}
          if (block.type === 'tool_use') {
            currentToolId = block.id ?? _genToolId()
            currentToolName = block.name ?? ''
            toolCalls[index] = { id: currentToolId!, name: currentToolName!, args: '', chunk: false }
          }
        } else if (type === 'content_block_delta') {
          const delta = parsed.delta ?? {}
          if (delta.type === 'text_delta' && delta.text) {
            contentPieces[index] = (contentPieces[index] ?? '') + delta.text
            yield { content: delta.text, finishReason: null, toolCalls: [] }
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            if (toolCalls[index]) {
              toolCalls[index]!.args += delta.partial_json
            }
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            contentPieces[index] = (contentPieces[index] ?? '') + delta.thinking
            yield { content: delta.thinking, finishReason: null, toolCalls: [] }
          }
        } else if (type === 'content_block_stop') {
          currentToolId = null
          currentToolName = null
        } else if (type === 'message_delta') {
          // stop_reason and usage available in message_delta, but emitted
          // at the end via tool_calls chunk if present
        } else if (type === 'error') {
          const error = parsed.error ?? {}
          yield {
            content: `Error: ${error.message ?? JSON.stringify(error)}`,
            finishReason: 'error',
            toolCalls: [],
          }
          return
        }
        // message_stop → stream done
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      yield { content: `Error during streaming: ${msg}`, finishReason: 'error', toolCalls: [] }
      return
    }

    // Emit final chunk with tool calls if any
    const resultToolCalls: LLMResponseChunk['toolCalls'] = []
    for (const tc of toolCalls) {
      if (tc) {
        resultToolCalls.push({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: tc.args || '{}',
          },
        })
      }
    }
    if (resultToolCalls.length > 0) {
      yield { content: null, finishReason: 'tool_calls', toolCalls: resultToolCalls }
    }
  }

  // ------------------------------------------------------------------
  // HTTP client
  // ------------------------------------------------------------------

  private async _rawPost(body: Record<string, unknown>): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    })
    return response
  }

  private async _post(body: Record<string, unknown>, _stream = false): Promise<any> {
    const response = await this._rawPost(body)
    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown error')
      // Build a structured error
      const err = new Error(errText) as any
      err.status = response.status
      err.statusCode = response.status
      try {
        err.body = JSON.parse(errText)
      } catch {
        err.body = errText
      }
      err.headers = Object.fromEntries(response.headers.entries())
      throw err
    }
    return response.json()
  }

  // ------------------------------------------------------------------
  // Error handling
  // ------------------------------------------------------------------

  private _handleError(e: unknown): LLMResponse {
    const err = e as Record<string, unknown> | null
    const response = err?.response as Record<string, unknown> | undefined
    const headers = (err?.headers ?? response?.headers ?? {}) as Record<string, string>
    const payload = err?.body ?? err?.doc ?? response?.text ?? null
    const payloadText = typeof payload === 'string' ? payload : payload ? String(payload) : ''
    const msg = payloadText?.trim()
      ? `Error: ${payloadText.slice(0, 500)}`
      : `Error calling LLM: ${err ? String(err.message ?? e) : String(e)}`

    const retryAfter = LLMProvider.extractRetryAfterFromHeaders(headers) ?? LLMProvider.extractRetryAfter(msg)

    const statusCode = (err?.status_code ?? err?.statusCode ?? response?.status_code) as number | undefined

    let shouldRetry: boolean | null = null
    const rawShouldRetry = headers['x-should-retry']
    if (rawShouldRetry) {
      const lowered = String(rawShouldRetry).trim().toLowerCase()
      if (lowered === 'true') shouldRetry = true
      else if (lowered === 'false') shouldRetry = false
    }

    const errorName = String(err?.name ?? err?.constructor?.name ?? '').toLowerCase()
    let errorKind: string | null = null
    if (errorName.includes('timeout')) errorKind = 'timeout'
    else if (errorName.includes('connection')) errorKind = 'connection'
    const [errorType, errorCode] = LLMProvider.extractErrorTypeCode(payload)

    return {
      content: msg,
      finishReason: 'error',
      toolCalls: [],
      retryAfter: retryAfter ?? undefined,
      errorStatus: statusCode ?? undefined,
      errorKind: errorKind ?? undefined,
      errorType: errorType ?? undefined,
      errorCode: errorCode ?? undefined,
      errorRetryAfterS: retryAfter ?? undefined,
      errorShouldRetry: shouldRetry ?? undefined,
    }
  }

  // ------------------------------------------------------------------
  // Build API kwargs
  // ------------------------------------------------------------------

  private _buildKwargs(
    messages: Record<string, unknown>[],
    options?: { tools?: ToolDefinition[]; settings?: Record<string, unknown> },
    _stream = false,
  ): Record<string, unknown> {
    const tools = options?.tools
    const settings = (options?.settings ?? {}) as Record<string, unknown>
    const temperature = settings.temperature as number | undefined
    const maxTokens = (settings.maxTokens as number) ?? this.maxTokens
    const reasoningEffort = settings.reasoningEffort as string | null | undefined
    const toolChoice = settings.tool_choice as string | Record<string, unknown> | null | undefined

    // Sanitize + enforce role alternation
    let cleanMsgs = LLMProvider.sanitizeEmptyContent(messages)
    cleanMsgs = LLMProvider.enforceRoleAlternation(cleanMsgs)

    const { system, anthropicMessages: anthropicMsgs } = this._convertMessages(cleanMsgs)
    const anthropicTools = this._convertTools(tools as any)

    // Prompt caching
    const { system: cachedSystem, anthropicMessages: cachedMsgs, anthropicTools: cachedTools } =
      this._applyCacheControl(system, anthropicMsgs, anthropicTools)

    const modelName = this._stripPrefix(this.model)
    const maxTokensVal = Math.max(1, maxTokens as number)
    const thinkingEnabled = !!reasoningEffort

    // claude-opus-4-7 deprecated the temperature parameter entirely
    const omitTemperature = modelName.includes('opus-4-7')

    const kwargs: Record<string, unknown> = {
      model: modelName,
      messages: cachedMsgs,
      max_tokens: maxTokensVal,
    }

    if (cachedSystem) {
      kwargs.system = cachedSystem
    }

    if (reasoningEffort === 'adaptive') {
      kwargs.thinking = { type: 'adaptive' }
      if (!omitTemperature) kwargs.temperature = 1.0
    } else if (thinkingEnabled) {
      const budgetMap: Record<string, number> = { low: 1024, medium: 4096, high: Math.max(8192, maxTokensVal) }
      const budget = budgetMap[String(reasoningEffort).toLowerCase()] ?? 4096
      kwargs.thinking = { type: 'enabled', budget_tokens: budget }
      kwargs.max_tokens = Math.max(maxTokensVal, budget + 4096)
      if (!omitTemperature) kwargs.temperature = 1.0
    } else if (!omitTemperature) {
      kwargs.temperature = temperature ?? 0.7
    }

    if (cachedTools && cachedTools.length > 0) {
      kwargs.tools = cachedTools
      const tc = this._convertToolChoice(toolChoice as any, thinkingEnabled)
      if (tc) kwargs.tool_choice = tc
    }

    return kwargs
  }

  private _stripPrefix(model: string): string {
    if (model.startsWith('anthropic/')) return model.slice('anthropic/'.length)
    return model
  }

  // ------------------------------------------------------------------
  // Message conversion: OpenAI format → Anthropic Messages API
  // ------------------------------------------------------------------

  private _convertMessages(
    messages: Record<string, unknown>[],
  ): { system: string | Record<string, unknown>[]; anthropicMessages: AnthropicMessage[] } {
    let system: string | Record<string, unknown>[] = ''
    const raw: { role: 'user' | 'assistant'; content: ContentBlock[] }[] = []

    for (const msg of messages) {
      const role = msg.role as string
      const content = msg.content

      if (role === 'system') {
        system = typeof content === 'string' || Array.isArray(content) ? content as any : String(content ?? '')
        continue
      }

      if (role === 'tool') {
        const block = this._toolResultBlock(msg)
        if (raw.length > 0 && raw[raw.length - 1]!.role === 'user') {
          const prevC = raw[raw.length - 1]!.content
          if (Array.isArray(prevC)) {
            ;(prevC as ContentBlock[]).push(block)
          } else {
            raw[raw.length - 1]!.content = [{ type: 'text' as const, text: String(prevC ?? '') }, block]
          }
        } else {
          raw.push({ role: 'user', content: [block] })
        }
        continue
      }

      if (role === 'assistant') {
        raw.push({ role: 'assistant', content: this._assistantBlocks(msg) })
        continue
      }

      if (role === 'user') {
        raw.push({
          role: 'user',
          content: this._convertUserContent(content),
        })
        continue
      }
    }

    return { system, anthropicMessages: this._mergeConsecutive(raw) }
  }

  private _toolResultBlock(msg: Record<string, unknown>): ContentBlock {
    const content = msg.content
    const block: ContentBlock = {
      type: 'tool_result',
      tool_use_id: (msg.tool_call_id as string) ?? (msg.toolCallId as string) ?? '',
    }
    if (Array.isArray(content)) {
      ;(block as any).content = this._convertUserContent(content)
    } else if (typeof content === 'string') {
      ;(block as any).content = content
    } else {
      ;(block as any).content = content ? String(content) : ''
    }
    return block
  }

  private _assistantBlocks(msg: Record<string, unknown>): ContentBlock[] {
    const blocks: ContentBlock[] = []

    // Thinking blocks
    const thinkingBlocks = msg.thinking_blocks as Record<string, unknown>[] | undefined
    if (thinkingBlocks) {
      for (const tb of thinkingBlocks) {
        if (tb.type === 'thinking') {
          blocks.push({
            type: 'thinking',
            thinking: String(tb.thinking ?? ''),
            signature: String(tb.signature ?? ''),
          })
        }
      }
    }

    // Text content
    const content = msg.content
    if (typeof content === 'string' && content) {
      blocks.push({ type: 'text', text: content })
    } else if (Array.isArray(content)) {
      for (const item of content) {
        blocks.push(typeof item === 'object' && item !== null
          ? item as ContentBlock
          : { type: 'text', text: String(item) })
      }
    }

    // Tool calls (accept both snake_case and camelCase)
    const toolCalls = (msg.tool_calls ?? msg.toolCalls) as Record<string, unknown>[] | undefined
    if (toolCalls) {
      for (const tc of toolCalls) {
        if (!tc) continue
        const func = tc.function as Record<string, unknown> | undefined
        let args: Record<string, unknown> = {}
        const rawArgs = func?.arguments
        if (typeof rawArgs === 'string') {
          try { args = JSON.parse(rawArgs) } catch { args = {} }
        } else if (typeof rawArgs === 'object' && rawArgs !== null) {
          args = rawArgs as Record<string, unknown>
        }
        blocks.push({
          type: 'tool_use',
          id: (tc.id as string) ?? _genToolId(),
          name: String(func?.name ?? ''),
          input: args,
        })
      }
    }

    return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
  }

  private _convertUserContent(content: unknown): ContentBlock[] {
    if (typeof content === 'string' || content === null || content === undefined) {
      return [{ type: 'text', text: content ? String(content) : '(empty)' }]
    }
    if (!Array.isArray(content)) {
      return [{ type: 'text', text: String(content) }]
    }

    const result: ContentBlock[] = []
    for (const item of content) {
      if (typeof item !== 'object' || item === null) {
        result.push({ type: 'text', text: String(item) })
        continue
      }
      const block = item as Record<string, unknown>
      if (block.type === 'image_url') {
        const converted = this._convertImageBlock(block)
        if (converted) result.push(converted)
        continue
      }
      result.push(block as ContentBlock)
    }
    return result.length > 0 ? result : [{ type: 'text', text: '(empty)' }]
  }

  private _convertImageBlock(block: Record<string, unknown>): ContentBlock | null {
    const imageUrl = block.image_url as Record<string, unknown> | undefined
    const url = typeof imageUrl?.url === 'string' ? imageUrl.url : ''
    if (!url) return null
    const m = url.match(/^data:(image\/\w+);base64,(.+)$/s)
    if (m) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: m[1]!, data: m[2] },
      }
    }
    return {
      type: 'image',
      source: { type: 'url', url },
    }
  }

  // ------------------------------------------------------------------
  // Message normalization
  // ------------------------------------------------------------------

  private _hasToolUse(msg: { role: string; content: ContentBlock[] }): boolean {
    const content = msg.content
    if (!Array.isArray(content)) return false
    return content.some((block) => block.type === 'tool_use')
  }

  private _mergeConsecutive(msgs: AnthropicMessage[]): AnthropicMessage[] {
    const merged: AnthropicMessage[] = []
    for (const msg of msgs) {
      if (merged.length > 0 && merged[merged.length - 1]!.role === msg.role) {
        const prev = merged[merged.length - 1]!
        const prevC = prev.content
        const curC = msg.content

        // Both content arrays
        for (const block of curC) {
          ;(prevC as ContentBlock[]).push(block)
        }
      } else {
        merged.push({ ...msg, content: [...msg.content] })
      }
    }

    // Strip trailing assistant turns
    let lastPopped: AnthropicMessage | null = null
    while (merged.length > 0 && merged[merged.length - 1]!.role === 'assistant') {
      lastPopped = merged.pop()!
    }

    // Recovery: if stripping left no messages, reroute last popped assistant as user
    if (merged.length === 0 && lastPopped !== null && !this._hasToolUse(lastPopped)) {
      merged.push({ role: 'user', content: lastPopped.content })
    }

    // Safety net: synthetic opener if first non-system message is assistant
    if (merged.length > 0 && merged[0]!.role === 'assistant' && !this._hasToolUse(merged[0]!)) {
      merged.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation continued)' }] })
    }

    return merged
  }

  // ------------------------------------------------------------------
  // Tool definition conversion
  // ------------------------------------------------------------------

  private _convertTools(tools?: ToolDefinition[]): AnthropicToolDef[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map((t) => {
      const func = (t as any).function ?? t
      const entry: AnthropicToolDef = {
        name: func.name ?? '',
        input_schema: func.parameters ?? { type: 'object', properties: {} },
      }
      if (func.description) entry.description = func.description
      return entry
    })
  }

  private _convertToolChoice(
    toolChoice: string | Record<string, unknown> | null | undefined,
    thinkingEnabled = false,
  ): Record<string, unknown> | null {
    if (thinkingEnabled) return { type: 'auto' }
    if (toolChoice === null || toolChoice === undefined || toolChoice === 'auto') return { type: 'auto' }
    if (toolChoice === 'required') return { type: 'any' }
    if (toolChoice === 'none') return null
    if (typeof toolChoice === 'object') {
      const fn = (toolChoice as Record<string, unknown>).function as Record<string, unknown> | undefined
      const name = typeof fn?.name === 'string' ? fn.name : undefined
      if (name) return { type: 'tool', name }
    }
    return { type: 'auto' }
  }

  // ------------------------------------------------------------------
  // Prompt caching
  // ------------------------------------------------------------------

  private _applyCacheControl(
    system: string | Record<string, unknown>[],
    messages: AnthropicMessage[],
    tools: AnthropicToolDef[] | undefined,
  ): { system: string | Record<string, unknown>[]; anthropicMessages: AnthropicMessage[]; anthropicTools: AnthropicToolDef[] | undefined } {
    const marker = { type: 'ephemeral' as const }

    // System → wrap in list with cache_control
    let newSystem: string | Record<string, unknown>[] = system
    if (typeof system === 'string' && system) {
      newSystem = [{ type: 'text', text: system, cache_control: marker }]
    } else if (Array.isArray(system) && system.length > 0) {
      newSystem = [...system]
      const last = { ...(newSystem[newSystem.length - 1] as Record<string, unknown>) }
      last.cache_control = marker
      newSystem[newSystem.length - 1] = last
    }

    // Messages: add cache_control to 3rd from last message
    const newMsgs = messages.map((m) => ({ ...m, content: [...m.content] }))
    if (newMsgs.length >= 3) {
      const targetIdx = newMsgs.length - 2
      const target = newMsgs[targetIdx]!
      const c = target.content
      if (c.length > 0) {
        const lastBlock = { ...c[c.length - 1] } as Record<string, unknown>
        lastBlock.cache_control = marker
        ;(c as Record<string, unknown>[])[c.length - 1] = lastBlock as ContentBlock
      }
    }

    // Tools: cache_control on builtin/MCP boundary and tail
    let newTools = tools
    if (tools && tools.length > 0) {
      newTools = tools.map((t) => ({ ...t }))
      const tailIdx = newTools.length - 1
      let lastBuiltinIdx: number | null = null
      for (let i = tailIdx; i >= 0; i--) {
        if (!newTools[i]!.name.startsWith('mcp_')) {
          lastBuiltinIdx = i
          break
        }
      }
      const indices = new Set<number>()
      if (lastBuiltinIdx !== null) indices.add(lastBuiltinIdx)
      indices.add(tailIdx)
      for (const idx of indices) {
        newTools[idx] = { ...newTools[idx]!, cache_control: { type: 'ephemeral' } }
      }
    }

    return { system: newSystem, anthropicMessages: newMsgs, anthropicTools: newTools }
  }

  // ------------------------------------------------------------------
  // Response parsing
  // ------------------------------------------------------------------

  private _parseResponse(data: any): LLMResponse {
    const contentParts: string[] = []
    const toolCalls: LLMResponse['toolCalls'] = []
    const thinkingBlocks: Record<string, unknown>[] = []

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
      } else if (block.type === 'thinking') {
        thinkingBlocks.push({
          type: 'thinking',
          thinking: block.thinking,
          signature: block.signature ?? '',
        })
      }
    }

    const stopMap: Record<string, 'stop' | 'tool_calls' | 'length' | 'error'> = {
      end_turn: 'stop',
      tool_use: 'tool_calls',
      max_tokens: 'length',
    }
    const finishReason = stopMap[data.stop_reason] ?? 'stop'

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
      thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
    }
  }
}
