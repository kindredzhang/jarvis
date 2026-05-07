/** 消息总线事件类型 */

/**
 * 入站消息 —— 来自聊天通道的消息
 */
export class InboundMessage {
  /** 通道标识（如 feishu, discord） */
  readonly channel: string
  /** 用户标识 */
  readonly senderId: string
  /** 聊天/频道 ID */
  readonly chatId: string
  /** 消息文本 */
  readonly content: string
  /** 消息时间戳 */
  readonly timestamp: Date
  /** 媒体文件 URL 列表 */
  readonly media: string[]
  /** 通道特定元数据 */
  readonly metadata: Record<string, unknown>
  /** 会话 Key 覆盖（用于线程作用域会话） */
  readonly sessionKeyOverride?: string

  constructor(params: {
    channel: string
    senderId: string
    chatId: string
    content: string
    timestamp?: Date
    media?: string[]
    metadata?: Record<string, unknown>
    sessionKeyOverride?: string
  }) {
    this.channel = params.channel
    this.senderId = params.senderId
    this.chatId = params.chatId
    this.content = params.content
    this.timestamp = params.timestamp ?? new Date()
    this.media = params.media ?? []
    this.metadata = params.metadata ?? {}
    this.sessionKeyOverride = params.sessionKeyOverride
  }

  /** 会话标识 Key（用于会话管理） */
  get sessionKey(): string {
    return this.sessionKeyOverride ?? `${this.channel}:${this.chatId}`
  }
}

/**
 * 出站消息 —— 发送到聊天通道的响应
 */
export interface OutboundMessage {
  /** 通道标识 */
  channel: string
  /** 聊天/频道 ID */
  chatId: string
  /** 消息内容 */
  content: string
  /** 回复目标消息 ID */
  replyTo?: string
  /** 媒体文件 URL 列表 */
  media: string[]
  /** 通道特定元数据 */
  metadata: Record<string, unknown>
  /** 按钮矩阵 */
  buttons: string[][]
}
