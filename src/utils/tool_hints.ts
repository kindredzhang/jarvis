/** 工具调用提示格式化 */
export function formatToolHints(toolCalls: { name: string; arguments?: string }[]): string {
  return toolCalls.map((tc) => {
    try {
      const args = tc.arguments ? JSON.parse(tc.arguments) : {}
      const entries = Object.entries(args).map(([k, v]) => `${k}=${String(v).slice(0, 50)}`).join(', ')
      return `Using ${tc.name}(${entries})`
    } catch {
      return `Using ${tc.name}`
    }
  }).join('\n')
}
