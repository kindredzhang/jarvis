/** 搜索用量查询 */
export async function fetchSearchUsage(provider: string, apiKey?: string): Promise<{ format: () => string }> {
  return { format: () => `Search: ${provider}${apiKey ? ' (configured)' : ' (no API key)'}` }
}
