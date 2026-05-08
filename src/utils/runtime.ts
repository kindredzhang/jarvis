/** 空响应占位消息 */
export const EMPTY_FINAL_RESPONSE_MESSAGE = '(I have nothing more to add.)'

/** 构建 assistant 消息 */
export function buildAssistantMessage(content: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { role: 'assistant', content, ...extra }
}
