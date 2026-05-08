/**
 * Token estimation for context-window governance.
 * Ported 1:1 from nanobot/utils/helpers.py.
 *
 * Uses character-based heuristics as the primary estimator.
 * For production use, swap in js-tiktoken or a provider-side token counter.
 */

// ---- Constants ----

export const SNIP_SAFETY_BUFFER = 1024

// ---- estimateMessageTokens ----

export function estimateMessageTokens(message: Record<string, unknown>): number {
  const content = message.content
  const parts: string[] = []

  if (typeof content === 'string') {
    parts.push(content)
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (
        typeof part === 'object' &&
        part !== null &&
        (part as Record<string, unknown>).type === 'text'
      ) {
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string' && text) {
          parts.push(text)
        }
      } else {
        parts.push(JSON.stringify(part))
      }
    }
  } else if (content !== null && content !== undefined) {
    parts.push(JSON.stringify(content))
  }

  for (const key of ['name', 'tool_call_id']) {
    const value = message[key]
    if (typeof value === 'string' && value) {
      parts.push(value)
    }
  }

  if (message.tool_calls) {
    parts.push(JSON.stringify(message.tool_calls))
  }

  const rc = message.reasoning_content
  if (typeof rc === 'string' && rc) {
    parts.push(rc)
  }

  const payload = parts.join('\n')
  if (!payload) return 4
  // Character-based estimate: ~4 chars per token is a common heuristic
  return Math.max(4, Math.ceil(payload.length / 4) + 4)
}

// ---- estimatePromptTokens ----

export function estimatePromptTokens(
  messages: Record<string, unknown>[],
  tools?: Record<string, unknown>[] | null,
): number {
  const parts: string[] = []

  for (const msg of messages) {
    const content = msg.content
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          (part as Record<string, unknown>).type === 'text'
        ) {
          const txt = (part as Record<string, unknown>).text
          if (typeof txt === 'string' && txt) {
            parts.push(txt)
          }
        }
      }
    }

    const tc = msg.tool_calls
    if (tc) {
      parts.push(JSON.stringify(tc))
    }

    const rc = msg.reasoning_content
    if (typeof rc === 'string' && rc) {
      parts.push(rc)
    }

    for (const key of ['name', 'tool_call_id']) {
      const value = msg[key]
      if (typeof value === 'string' && value) {
        parts.push(value)
      }
    }
  }

  if (tools) {
    parts.push(JSON.stringify(tools))
  }

  const perMessageOverhead = messages.length * 4
  return Math.ceil(parts.join('\n').length / 4) + perMessageOverhead
}

// ---- estimatePromptTokensChain ----

export function estimatePromptTokensChain(
  messages: Record<string, unknown>[],
  tools?: Record<string, unknown>[] | null,
): { tokens: number; source: string } {
  const estimated = estimatePromptTokens(messages, tools)
  if (estimated > 0) return { tokens: estimated, source: 'char-heuristic' }
  return { tokens: 0, source: 'none' }
}
