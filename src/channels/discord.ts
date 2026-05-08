/**
 * DiscordChannel —— Discord Bot API 通道
 *
 * 使用 Discord REST API 收发消息。
 * 需要 Bot Token（discord.com/developers 注册应用获取）。
 */
import { BaseChannel, type ChannelConfig } from './base'
import { InboundMessage, type OutboundMessage } from '../bus'

export interface DiscordConfig extends ChannelConfig {
  botToken: string
}

const API_BASE = 'https://discord.com/api/v10'

export class DiscordChannel extends BaseChannel {
  override readonly name = 'discord'
  private botToken: string
  onMessage: ((msg: InboundMessage) => Promise<OutboundMessage | null>) | null = null

  constructor(config: DiscordConfig) {
    super('discord', config)
    this.botToken = config.botToken
  }

  async start(): Promise<void> {
    this.running = true
    // Discord 使用 Gateway（WebSocket）接收事件，当前需配合 webhook 使用
    console.log('[Discord] Started (use Interactions Endpoint URL for webhook)')
  }

  async stop(): Promise<void> {
    this.running = false
    console.log('[Discord] Stopped')
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this._api(`/channels/${msg.chatId}/messages`, {
      content: msg.content,
    })
  }

  /** 处理 Discord webhook interaction */
  async handleInteraction(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const type = body.type as number
    // PING (type 1) → PONG
    if (type === 1) return { type: 1 }

    // MESSAGE_CREATE (type 0)
    const message = (body as any).d ?? body.message ?? body
    const content = message.content as string | undefined
    if (!content) return null

    const channelId = (message.channel_id as string) ?? (body.channel_id as string) ?? ''
    const author = message.author as Record<string, unknown> | undefined
    const userId = (author?.id as string) ?? ''

    if (!this.isAllowed(userId)) return null

    if (this.onMessage) {
      const inbound = new InboundMessage({
        channel: 'discord',
        senderId: userId,
        chatId: channelId,
        content,
        metadata: {},
      })
      this.onMessage(inbound).then((r) => { if (r) this.send(r) })
    }
    return null
  }

  private async _api(path: string, body: Record<string, unknown>): Promise<any> {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${this.botToken}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Discord API ${response.status}`)
    return response.json()
  }
}
