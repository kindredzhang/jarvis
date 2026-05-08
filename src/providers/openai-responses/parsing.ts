/**
 * Parse Responses API SSE streams and SDK response objects.
 *
 * Port of original Python providers/openai_responses/parsing.py.
 */

export interface ResponseToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ParsedResponse {
  content: string | null
  toolCalls: ResponseToolCall[]
  finishReason: string
  usage?: Record<string, number>
  reasoningContent?: string | null
}

const FINISH_REASON_MAP: Record<string, string> = {
  completed: 'stop',
  incomplete: 'length',
  failed: 'error',
  cancelled: 'error',
}

function mapFinishReason(status: string | null): string {
  return FINISH_REASON_MAP[status ?? 'completed'] ?? 'stop'
}

/**
 * Consume a Responses API SSE text/event-stream and produce structured output.
 */
export async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  onContentDelta?: (delta: string) => Promise<void>,
): Promise<[string | null, ResponseToolCall[], string]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const toolCalls: ResponseToolCall[] = []
  const toolCallBuffers: Record<string, { id: string; name: string; arguments: string }> = {}
  let finishReason = 'stop'

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Parse SSE events from buffer
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''

    for (const event of events) {
      if (!event.trim()) continue
      const parsed = parseSSEEvent(event)
      if (!parsed) continue

      const eventType = parsed.type as string
      if (eventType === 'response.output_item.added') {
        const item = (parsed.item as Record<string, unknown>) ?? {}
        if (item.type === 'function_call') {
          const callId = item.call_id as string
          if (callId) {
            toolCallBuffers[callId] = {
              id: (item.id as string) ?? 'fc_0',
              name: (item.name as string) ?? '',
              arguments: (item.arguments as string) ?? '',
            }
          }
        }
      } else if (eventType === 'response.output_text.delta') {
        const delta = (parsed.delta as string) ?? ''
        if (delta) {
          content += delta
          if (onContentDelta) await onContentDelta(delta)
        }
      } else if (eventType === 'response.function_call_arguments.delta') {
        const callId = parsed.call_id as string
        if (callId && toolCallBuffers[callId]) {
          toolCallBuffers[callId].arguments += (parsed.delta as string) ?? ''
        }
      } else if (eventType === 'response.function_call_arguments.done') {
        const callId = parsed.call_id as string
        if (callId && toolCallBuffers[callId]) {
          toolCallBuffers[callId].arguments = (parsed.arguments as string) ?? ''
        }
      } else if (eventType === 'response.output_item.done') {
        const item = (parsed.item as Record<string, unknown>) ?? {}
        if (item.type === 'function_call') {
          const callId = item.call_id as string
          if (!callId) continue
          const buf = toolCallBuffers[callId]
          const argsRaw = buf?.arguments ?? (item.arguments as string) ?? '{}'
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(argsRaw)
          } catch {
            args = { raw: argsRaw }
          }
          toolCalls.push({
            id: `${callId}|${buf?.id ?? (item.id as string) ?? 'fc_0'}`,
            name: buf?.name ?? (item.name as string) ?? '',
            arguments: args,
          })
        }
      } else if (eventType === 'response.completed') {
        const resp = (parsed.response as Record<string, unknown>) ?? {}
        finishReason = mapFinishReason(resp.status as string | null)
      } else if (eventType === 'error' || eventType === 'response.failed') {
        const detail = parsed.error ?? parsed.message ?? parsed
        throw new Error(`Response failed: ${JSON.stringify(detail).slice(0, 500)}`)
      }
    }
  }

  return [content || null, toolCalls, finishReason]
}

/**
 * Parse a Responses API SDK response object.
 */
export function parseResponseOutput(response: Record<string, unknown>): ParsedResponse {
  const output = (response.output as Record<string, unknown>[]) ?? []
  const contentParts: string[] = []
  const toolCalls: ResponseToolCall[] = []
  let reasoningContent: string | null = null

  for (const item of output) {
    const itemType = item.type as string

    if (itemType === 'message') {
      const blocks = (item.content as Record<string, unknown>[]) ?? []
      for (const block of blocks) {
        if (block.type === 'output_text') {
          contentParts.push((block.text as string) ?? '')
        }
      }
    } else if (itemType === 'reasoning') {
      const summaries = (item.summary as Record<string, unknown>[]) ?? []
      for (const s of summaries) {
        if (s.type === 'summary_text' && s.text) {
          reasoningContent = (reasoningContent ?? '') + (s.text as string)
        }
      }
    } else if (itemType === 'function_call') {
      const callId = (item.call_id as string) ?? ''
      const itemId = (item.id as string) ?? 'fc_0'
      const argsRaw = (item.arguments as string) ?? '{}'
      let args: Record<string, unknown> = {}
      try {
        args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : (argsRaw as Record<string, unknown>)
      } catch {
        args = { raw: argsRaw }
      }
      toolCalls.push({
        id: `${callId}|${itemId}`,
        name: (item.name as string) ?? '',
        arguments: args,
      })
    }
  }

  const usageRaw = (response.usage as Record<string, unknown>) ?? {}
  const usage: Record<string, number> = {}
  if (usageRaw && Object.keys(usageRaw).length > 0) {
    usage.promptTokens = Number(usageRaw.input_tokens ?? usageRaw.inputTokens ?? 0)
    usage.completionTokens = Number(usageRaw.output_tokens ?? usageRaw.outputTokens ?? 0)
    usage.totalTokens = Number(usageRaw.total_tokens ?? usageRaw.totalTokens ?? 0)
  }

  const status = response.status as string | null
  const finishReason = mapFinishReason(status)

  return {
    content: contentParts.join('') || null,
    toolCalls,
    finishReason,
    usage: Object.keys(usage).length > 0 ? usage : undefined,
    reasoningContent,
  }
}

// ---- SSE event parser ----

function parseSSEEvent(eventText: string): Record<string, unknown> | null {
  const lines = eventText.trim().split('\n')
  let data = ''

  for (const line of lines) {
    if (line.startsWith('data:')) {
      const value = line.slice(5).trim()
      if (value === '[DONE]') return null
      data += value
    }
  }

  if (!data) return null
  try {
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    return null
  }
}
