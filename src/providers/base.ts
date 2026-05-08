/**
 * LLMProvider —— LLM 供应商抽象基类
 *
 * Ported from Python original providers/base.py core interface.
 */

import type { Message, LLMResponse, LLMResponseChunk, GenerationSettings } from './types'
import type { ToolDefinition } from '../agent/tools/base'

// ---- 重试策略常量 ----

const CHAT_RETRY_DELAYS = [1, 2, 4]
const PERSISTENT_MAX_DELAY = 60
const PERSISTENT_IDENTICAL_ERROR_LIMIT = 10
const RETRY_HEARTBEAT_CHUNK = 30

const TRANSIENT_ERROR_MARKERS = [
  '429', 'rate limit', '500', '502', '503', '504',
  'overloaded', 'timeout', 'timed out', 'connection',
  'server error', 'temporarily unavailable',
] as const

const RETRYABLE_STATUS_CODES = new Set([408, 409, 429])

const TRANSIENT_ERROR_KINDS = new Set(['timeout', 'connection'])

const NON_RETRYABLE_429_ERROR_TOKENS = new Set([
  'insufficient_quota', 'quota_exceeded', 'quota_exhausted',
  'billing_hard_limit_reached', 'insufficient_balance',
  'credit_balance_too_low', 'billing_not_active', 'payment_required',
])

const RETRYABLE_429_ERROR_TOKENS = new Set([
  'rate_limit_exceeded', 'rate_limit_error', 'too_many_requests',
  'request_limit_exceeded', 'requests_limit_exceeded', 'overloaded_error',
])

const NON_RETRYABLE_429_TEXT_MARKERS = [
  'insufficient_quota', 'insufficient quota', 'quota exceeded',
  'quota exhausted', 'billing hard limit', 'billing_hard_limit_reached',
  'billing not active', 'insufficient balance', 'insufficient_balance',
  'credit balance too low', 'payment required', 'out of credits',
  'out of quota', 'exceeded your current quota',
]

const RETRYABLE_429_TEXT_MARKERS = [
  'rate limit', 'rate_limit', 'too many requests',
  'retry after', 'try again in', 'temporarily unavailable',
  'overloaded', 'concurrency limit',
]

const SYNTHETIC_USER_CONTENT = '(conversation continued)'

export abstract class LLMProvider {
  /** 模型名称 */
  abstract readonly model: string

  /**
   * 非流式生成
   */
  abstract generate(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
  ): Promise<LLMResponse>

  /**
   * 流式生成
   */
  abstract generateStream(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
  ): AsyncIterable<LLMResponseChunk>

  // ==================================================================
  // 消息清洗
  // ==================================================================

  /** Sanitize message content: fix empty blocks, strip internal _meta fields. */
  static sanitizeEmptyContent(messages: Record<string, unknown>[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = []
    for (const msg of messages) {
      const content = msg.content

      // Empty string content
      if (typeof content === 'string' && !content) {
        const clean = { ...msg }
        if (msg.role === 'assistant' && msg.tool_calls) {
          clean.content = null
        } else {
          clean.content = '(empty)'
        }
        result.push(clean)
        continue
      }

      // Content is an array
      if (Array.isArray(content)) {
        const newItems: Record<string, unknown>[] = []
        let changed = false
        for (const item of content) {
          if (
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Record<string, unknown>).type === 'string' &&
            ['text', 'input_text', 'output_text'].includes((item as Record<string, unknown>).type as string) &&
            !(item as Record<string, unknown>).text
          ) {
            changed = true
            continue
          }
          if (typeof item === 'object' && item !== null && '_meta' in (item as Record<string, unknown>)) {
            const { _meta, ...rest } = item as Record<string, unknown>
            newItems.push(rest)
            changed = true
          } else {
            newItems.push(item as Record<string, unknown>)
          }
        }
        if (changed) {
          const clean = { ...msg }
          if (newItems.length > 0) {
            clean.content = newItems
          } else if (msg.role === 'assistant' && msg.tool_calls) {
            clean.content = null
          } else {
            clean.content = '(empty)'
          }
          result.push(clean)
          continue
        }
      }

      // Dict content → wrap in array
      if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
        const clean = { ...msg }
        clean.content = [content]
        result.push(clean)
        continue
      }

      result.push(msg)
    }
    return result
  }

  /** Merge consecutive same-role messages and drop trailing assistant messages. */
  static enforceRoleAlternation(messages: Record<string, unknown>[]): Record<string, unknown>[] {
    if (messages.length === 0) return messages

    const merged: Record<string, unknown>[] = []
    for (const msg of messages) {
      const role = msg.role as string
      if (
        merged.length > 0 &&
        role !== 'system' &&
        role !== 'tool' &&
        merged[merged.length - 1]!.role === role &&
        (role === 'user' || role === 'assistant')
      ) {
        const prev = merged[merged.length - 1]!
        if (role === 'assistant') {
          const prevHasTools = !!(prev.tool_calls as unknown[])
          const currHasTools = !!(msg.tool_calls as unknown[])
          if (currHasTools) {
            merged[merged.length - 1] = { ...msg }
            continue
          }
          if (prevHasTools) continue
        }
        const prevContent = (prev.content as string) ?? ''
        const currContent = (msg.content as string) ?? ''
        if (typeof prev.content === 'string' && typeof msg.content === 'string') {
          prev.content = (prevContent + '\n\n' + currContent).trim()
        } else {
          merged[merged.length - 1] = { ...msg }
        }
      } else {
        merged.push({ ...msg })
      }
    }

    // Strip trailing assistant messages
    let lastPopped: Record<string, unknown> | null = null
    while (merged.length > 0 && merged[merged.length - 1]!.role === 'assistant') {
      lastPopped = merged.pop()!
    }

    // Recover: convert last popped assistant to user if only system messages remain
    if (
      merged.length > 0 &&
      lastPopped !== null &&
      !merged.some((m) => m.role === 'user' || m.role === 'tool')
    ) {
      const recovered = { ...lastPopped }
      recovered.role = 'user'
      merged.push(recovered)
    }

    // Safety net: ensure first non-system message is not a bare assistant
    for (let i = 0; i < merged.length; i++) {
      if (merged[i]!.role !== 'system') {
        if (merged[i]!.role === 'assistant' && !(merged[i]!.tool_calls as unknown[])) {
          merged.splice(i, 0, { role: 'user', content: SYNTHETIC_USER_CONTENT })
        }
        break
      }
    }

    return merged
  }

  // ==================================================================
  // 瞬态错误检测
  // ==================================================================

  static isTransientError(content: string | null | undefined): boolean {
    const err = (content ?? '').toLowerCase()
    return (TRANSIENT_ERROR_MARKERS as readonly string[]).some((marker) => err.includes(marker))
  }

  static isTransientResponse(response: LLMResponse): boolean {
    if (response.errorShouldRetry !== null && response.errorShouldRetry !== undefined) {
      return !!response.errorShouldRetry
    }

    if (response.errorStatus !== null && response.errorStatus !== undefined) {
      const status = response.errorStatus
      if (status === 429) return LLMProvider.isRetryable429Response(response)
      if (RETRYABLE_STATUS_CODES.has(status) || status >= 500) return true
    }

    const kind = (response.errorKind ?? '').trim().toLowerCase()
    if (TRANSIENT_ERROR_KINDS.has(kind)) return true

    return LLMProvider.isTransientError(response.content)
  }

  static normalizeErrorToken(value: unknown): string | null {
    if (value === null || value === undefined) return null
    const token = String(value).trim().toLowerCase()
    return token || null
  }

  static extractErrorTypeCode(payload: unknown): [string | null, string | null] {
    let data: Record<string, unknown> | null = null
    if (typeof payload === 'object' && payload !== null) {
      data = payload as Record<string, unknown>
    } else if (typeof payload === 'string') {
      const text = payload.trim()
      if (text) {
        try {
          const parsed = JSON.parse(text)
          if (typeof parsed === 'object' && parsed !== null) data = parsed
        } catch {
          // not JSON
        }
      }
    }
    if (!data) return [null, null]

    const errorObj = data.error as Record<string, unknown> | undefined
    let typeValue = data.type as string | undefined
    let codeValue = data.code as string | undefined
    if (errorObj) {
      typeValue = (errorObj.type as string) ?? typeValue
      codeValue = (errorObj.code as string) ?? codeValue
    }

    return [LLMProvider.normalizeErrorToken(typeValue), LLMProvider.normalizeErrorToken(codeValue)]
  }

  static isRetryable429Response(response: LLMResponse): boolean {
    const typeToken = LLMProvider.normalizeErrorToken(response.errorType)
    const codeToken = LLMProvider.normalizeErrorToken(response.errorCode)
    const semanticTokens = new Set([typeToken, codeToken].filter((t): t is string => t !== null))

    for (const token of semanticTokens) {
      if (NON_RETRYABLE_429_ERROR_TOKENS.has(token)) return false
    }

    const content = (response.content ?? '').toLowerCase()
    for (const marker of NON_RETRYABLE_429_TEXT_MARKERS) {
      if (content.includes(marker)) return false
    }

    for (const token of semanticTokens) {
      if (RETRYABLE_429_ERROR_TOKENS.has(token)) return true
    }
    for (const marker of RETRYABLE_429_TEXT_MARKERS) {
      if (content.includes(marker)) return true
    }
    return true
  }

  // ==================================================================
  // Retry after 解析
  // ==================================================================

  static extractRetryAfter(content: string | null | undefined): number | null {
    const text = (content ?? '').toLowerCase()
    const patterns = [
      /retry after\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)?/,
      /try again in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)/,
      /wait\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)\s*before retry/,
      /retry[_-]?after["'\s:=]+(\d+(?:\.\d+)?)/,
    ]
    for (let idx = 0; idx < patterns.length; idx++) {
      const match = patterns[idx]!.exec(text)
      if (!match) continue
      const value = parseFloat(match[1]!)
      const unit = idx < 3 ? (match[2] ?? 's') : 's'
      return LLMProvider.toRetrySeconds(value, unit)
    }
    return null
  }

  static toRetrySeconds(value: number, unit?: string | null): number {
    const u = (unit ?? 's').toLowerCase()
    if (u === 'ms' || u === 'milliseconds') return Math.max(0.1, value / 1000)
    if (u === 'm' || u === 'min' || u === 'minutes') return Math.max(0.1, value * 60)
    return Math.max(0.1, value)
  }

  static extractRetryAfterFromHeaders(headers: Record<string, string> | null | undefined): number | null {
    if (!headers) return null

    // retry-after-ms
    const retryMs = headers['retry-after-ms']
    if (retryMs !== undefined) {
      const value = parseFloat(retryMs) / 1000
      if (value > 0) return value
    }

    const retryAfter = headers['retry-after'] ?? headers['Retry-After']
    if (retryAfter === undefined || retryAfter === null) return null
    const text = String(retryAfter).trim()
    if (!text) return null

    if (/^\d+(?:\.\d+)?$/.test(text)) {
      return LLMProvider.toRetrySeconds(parseFloat(text), 's')
    }

    // HTTP-date format
    const ms = Date.parse(text)
    if (!isNaN(ms)) {
      const remaining = (ms - Date.now()) / 1000
      return Math.max(0.1, remaining)
    }

    return null
  }

  static extractRetryAfterFromResponse(response: LLMResponse): number | null {
    if (response.errorRetryAfterS !== null && response.errorRetryAfterS !== undefined && response.errorRetryAfterS > 0) {
      return response.errorRetryAfterS
    }
    if (response.retryAfter !== null && response.retryAfter !== undefined && response.retryAfter > 0) {
      return response.retryAfter
    }
    return LLMProvider.extractRetryAfter(response.content)
  }
}
