/**
 * Convert Chat Completions messages/tools to Responses API format.
 *
 * Port of original Python providers/openai_responses/converters.py.
 */

export function convertMessages(
  messages: Record<string, unknown>[],
): [string, Record<string, unknown>[]] {
  let systemPrompt = ''
  const inputItems: Record<string, unknown>[] = []

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx]!
    const role = msg.role as string
    const content = msg.content

    if (role === 'system') {
      systemPrompt = typeof content === 'string' ? content : ''
      continue
    }

    if (role === 'user') {
      inputItems.push(convertUserMessage(content))
      continue
    }

    if (role === 'assistant') {
      if (typeof content === 'string' && content) {
        inputItems.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: content }],
          status: 'completed',
          id: `msg_${idx}`,
        })
      }
      const toolCalls = (msg.tool_calls as Record<string, unknown>[]) ?? []
      for (const tc of toolCalls) {
        const fn = (tc.function as Record<string, unknown>) ?? {}
        const [callId, itemId] = splitToolCallId(tc.id as string)
        inputItems.push({
          type: 'function_call',
          id: itemId ?? `fc_${idx}`,
          call_id: callId ?? `call_${idx}`,
          name: fn.name,
          arguments: (fn.arguments as string) ?? '{}',
        })
      }
      continue
    }

    if (role === 'tool') {
      const [callId] = splitToolCallId(msg.tool_call_id as string)
      const outputText = typeof content === 'string'
        ? content
        : JSON.stringify(content, null, 0)
      inputItems.push({
        type: 'function_call_output',
        call_id: callId,
        output: outputText,
      })
    }
  }

  return [systemPrompt, inputItems]
}

export function convertUserMessage(content: unknown): Record<string, unknown> {
  if (typeof content === 'string') {
    return { role: 'user', content: [{ type: 'input_text', text: content }] }
  }

  if (Array.isArray(content)) {
    const converted: Record<string, unknown>[] = []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const it = item as Record<string, unknown>
      if (it.type === 'text') {
        converted.push({ type: 'input_text', text: it.text ?? '' })
      } else if (it.type === 'image_url') {
        const url = (it.image_url as Record<string, unknown>)?.url as string | undefined
        if (url) {
          converted.push({ type: 'input_image', image_url: url, detail: 'auto' })
        }
      }
    }
    if (converted.length > 0) {
      return { role: 'user', content: converted }
    }
  }

  return { role: 'user', content: [{ type: 'input_text', text: '' }] }
}

export function convertTools(
  tools: Record<string, unknown>[],
): Record<string, unknown>[] {
  const converted: Record<string, unknown>[] = []
  for (const tool of tools) {
    const fn = tool.type === 'function'
      ? (tool.function as Record<string, unknown>) ?? {}
      : tool
    const name = fn.name as string | undefined
    if (!name) continue
    const params = (fn.parameters as Record<string, unknown>) ?? {}
    converted.push({
      type: 'function',
      name,
      description: (fn.description as string) ?? '',
      parameters: typeof params === 'object' && !Array.isArray(params) ? params : {},
    })
  }
  return converted
}

export function splitToolCallId(
  toolCallId: unknown,
): [string, string | null] {
  if (typeof toolCallId === 'string' && toolCallId) {
    const idx = toolCallId.indexOf('|')
    if (idx !== -1) {
      return [toolCallId.slice(0, idx), toolCallId.slice(idx + 1) || null]
    }
    return [toolCallId, null]
  }
  return ['call_0', null]
}
