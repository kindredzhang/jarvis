/** LLM 对话质量评估 */
export async function evaluateConversation(provider: { generate: Function }, messages: Record<string, unknown>[]): Promise<string | null> {
  try {
    const response = await provider.generate([
      { role: 'system', content: 'Evaluate this conversation. Rate helpfulness 1-5. Output one line only.' },
      ...messages.slice(-10),
    ])
    return response.content?.trim() ?? null
  } catch { return null }
}
