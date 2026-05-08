/**
 * BaseChannel —— 聊天通道抽象基类
 *
 * 所有通道（Feishu / WhatsApp / Telegram / Discord 等）应实现此接口。
 *
 * ========= TODO: 其他通道 =========
 * 以下通道在 nanobot/channels/ 中存在，暂未移植：
 * - Telegram: Bot API webhook + polling
 * - Discord: Discord Gateway + REST API
 * - Slack: Event API + Web API
 * - DingTalk: 钉钉机器人 webhook
 * - WeCom: 企微机器人 webhook
 * - WeChat: 微信公众号/个人号
 * - Matrix: Matrix 协议
 * - QQ: QQ机器人
 * - Email: IMAP/SMTP
 * - WebSocket: 通用 WebSocket 通道
 * - MSteams: Microsoft Teams
 * - MoChat: 摩卡
 */

import type { InboundMessage, OutboundMessage } from '../bus'

export interface ChannelConfig {
  /** 是否启用 */
  enabled: boolean
  /** 允许的发送者列表（["*"] 表示全部允许） */
  allowFrom?: string[]
  /** 群组策略：open（全部回复）/ mention（仅 @ 时回复） */
  groupPolicy?: 'open' | 'mention' | 'allowlist'
  /** 流式输出支持 */
  streaming?: boolean
}

export abstract class BaseChannel {
  readonly name: string
  protected config: ChannelConfig
  protected running = false

  constructor(name: string, config: ChannelConfig) {
    this.name = name
    this.config = { ...config }
  }

  /** 启动通道连接 / HTTP 服务器 */
  abstract start(): Promise<void>

  /** 停止通道 */
  abstract stop(): Promise<void>

  /** 发送出站消息 */
  abstract send(msg: OutboundMessage): Promise<void>

  /** 权限检查 */
  isAllowed(senderId: string): boolean {
    const allow = this.config.allowFrom
    if (!allow || allow.length === 0) return false
    if (allow.includes('*')) return true
    return allow.includes(senderId)
  }

  get isRunning(): boolean {
    return this.running
  }
}
