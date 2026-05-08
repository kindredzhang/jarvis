/**
 * CommandRouter —— 斜杠命令路由
 *
 * 三级匹配：
 * 1. priority 优先命令（dispatch 锁外处理，如 /stop）
 * 2. exact    精确匹配
 * 3. prefix   最长前缀匹配（如 /dream-log <sha>）
 */

import type { OutboundMessage } from '../bus'

/** 命令上下文——每个 handler 收到此对象 */
export interface CommandContext {
  /** 原始命令文本（不含前导空格） */
  raw: string
  /** 命令参数（prefix 匹配时自动提取） */
  args: string
  /** 会话 Key */
  sessionKey: string
  /** 通道名 */
  channel: string
  /** 聊天 ID */
  chatId: string
  /** 消息元数据 */
  metadata: Record<string, unknown>
}

/** Handler 签名 */
export type CommandHandler = (ctx: CommandContext) => Promise<OutboundMessage | null>

export class CommandRouter {
  private priority = new Map<string, CommandHandler>()
  private exact = new Map<string, CommandHandler>()
  private prefix: { pfx: string; handler: CommandHandler }[] = []

  /** 注册优先命令（dispatch 锁外处理） */
  priorityCmd(cmd: string, handler: CommandHandler): void {
    this.priority.set(cmd.toLowerCase(), handler)
  }

  /** 注册精确匹配命令 */
  exactCmd(cmd: string, handler: CommandHandler): void {
    this.exact.set(cmd.toLowerCase(), handler)
  }

  /** 注册前缀匹配命令（如 /dream-log → /dream-log <sha>） */
  prefixCmd(pfx: string, handler: CommandHandler): void {
    const lower = pfx.toLowerCase()
    this.prefix.push({ pfx: lower, handler })
    this.prefix.sort((a, b) => b.pfx.length - a.pfx.length)
  }

  /** 判断文本是否为优先命令 */
  isPriority(text: string): boolean {
    return this.priority.has(text.trim().toLowerCase())
  }

  /** 判断文本是否匹配任一非优先命令 */
  isDispatchableCommand(text: string): boolean {
    const cmd = text.trim().toLowerCase()
    if (this.exact.has(cmd)) return true
    return this.prefix.some((p) => cmd.startsWith(p.pfx))
  }

  /** 分发优先命令 */
  async dispatchPriority(ctx: CommandContext): Promise<OutboundMessage | null> {
    const handler = this.priority.get(ctx.raw.toLowerCase())
    return handler ? handler(ctx) : null
  }

  /** 分发命令：exact → prefix */
  async dispatch(ctx: CommandContext): Promise<OutboundMessage | null> {
    const cmd = ctx.raw.toLowerCase()

    const handler = this.exact.get(cmd)
    if (handler) return handler(ctx)

    for (const { pfx, handler } of this.prefix) {
      if (cmd.startsWith(pfx)) {
        ctx.args = ctx.raw.slice(pfx.length)
        return handler(ctx)
      }
    }

    return null
  }
}
