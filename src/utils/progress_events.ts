/**
 * Structured progress-event helpers shared by agent runtimes.
 *
 * Port of original Python utils/progress_events.py.
 */

/**
 * Check if an onProgress callback accepts toolEvents.
 */
export function onProgressAcceptsToolEvents(
  cb: (...args: any[]) => any,
): boolean {
  // Check for rest parameter (...kwargs) — accepts anything
  const cbStr = cb.toString()
  if (cbStr.includes('...')) return true
  // Check for explicit tool_events parameter (underscore or camelCase)
  return cbStr.includes('tool_events') || cbStr.includes('toolEvents')
}

/**
 * Invoke an onProgress callback with appropriate arguments.
 */
export async function invokeOnProgress(
  onProgress: (content: string, opts?: { toolHint?: boolean; toolEvents?: Record<string, unknown>[] }) => Promise<void>,
  content: string,
  opts?: { toolHint?: boolean; toolEvents?: Record<string, unknown>[] },
): Promise<void> {
  if (opts?.toolEvents && onProgressAcceptsToolEvents(onProgress)) {
    await onProgress(content, opts)
    return
  }
  await onProgress(content, { toolHint: opts?.toolHint })
}

/**
 * Build a tool event start payload.
 */
export function buildToolEventStartPayload(toolCall: {
  id?: string
  name?: string
  arguments?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    version: 1,
    phase: 'start',
    call_id: toolCall.id ?? '',
    name: toolCall.name ?? '',
    arguments: toolCall.arguments ?? {},
    result: null,
    error: null,
    files: [],
    embeds: [],
  }
}

/**
 * Extract files and embeds from a tool result.
 */
export function toolEventResultExtras(result: unknown): [unknown[], unknown[]] {
  if (!result || typeof result !== 'object') return [[], []]
  const r = result as Record<string, unknown>
  const files = Array.isArray(r.files) ? r.files : []
  const embeds = Array.isArray(r.embeds) ? r.embeds : []
  return [files, embeds]
}

/**
 * Build tool event finish payloads from AgentHookContext data.
 */
export function buildToolEventFinishPayloads(context: {
  toolCalls: any[]
  toolResults: any[]
  toolEvents: any[]
}): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = []
  const count = Math.min(context.toolCalls.length, context.toolResults.length, context.toolEvents.length)

  for (let i = 0; i < count; i++) {
    const toolCall = context.toolCalls[i] ?? {}
    const result = context.toolResults[i]
    const event = (context.toolEvents[i] as Record<string, unknown>) ?? {}
    const status = event.status as string
    const phase = status === 'ok' ? 'end' : 'error'
    const [files, embeds] = toolEventResultExtras(result)

    const payload: Record<string, unknown> = {
      version: 1,
      phase,
      call_id: toolCall.id ?? '',
      name: toolCall.name ?? '',
      arguments: toolCall.arguments ?? {},
      result: phase === 'end' ? result : null,
      error: null,
      files,
      embeds,
    }

    if (phase === 'error') {
      if (typeof result === 'string' && result.trim()) {
        payload.error = result.trim()
      } else {
        payload.error = (event.detail as string) || 'Tool execution failed'
      }
    }

    payloads.push(payload)
  }

  return payloads
}
