/**
 * TelegramChannel —— Telegram Bot API 通道
 *
 * 支持 polling（getUpdates）和 webhook 两种模式。
 * 使用 Telegram Bot API 收发消息。
 */
import { BaseChannel, type ChannelConfig } from './base'
import { InboundMessage, type OutboundMessage } from '../bus'

export interface TelegramConfig extends ChannelConfig {
  botToken: string
  /** webhook URL（可选，不设置则使用 polling） */
  webhookUrl?: string
}

const API_BASE = 'https://api.telegram.org/bot'

export class TelegramChannel extends BaseChannel {
  override readonly name = 'telegram'
  private botToken: string
  private webhookUrl?: string
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastUpdateId = 0
  onMessage: ((msg: InboundMessage) => Promise<OutboundMessage | null>) | null = null

  constructor(config: TelegramConfig) {
    super('telegram', config)
    this.botToken = config.botToken
    this.webhookUrl = config.webhookUrl
  }

  async start(): Promise<void> {
    this.running = true
    if (this.webhookUrl) {
      await this._api('setWebhook', { url: this.webhookUrl })
      console.log('[Telegram] Started (webhook mode)')
    } else {
      this._startPolling()
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.pollTimer) clearInterval(this.pollTimer)
    console.log('[Telegram] Stopped')
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this._api('sendMessage', {
      chat_id: parseInt(msg.chatId, 10),
      text: msg.content,
    })
  }

  /** Webhook 处理入口 */
  async handleWebhook(body: Record<string, unknown>): Promise<void> {
    await this._processUpdate(body)
  }

  private _startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        const data = await this._api('getUpdates', {
          offset: this.lastUpdateId + 1,
          timeout: 30,
        })
        const result = data.result as Record<string, unknown>[]
        if (!result) return
        for (const update of result) {
          const id = update.update_id as number
          if (id > this.lastUpdateId) this.lastUpdateId = id
          await this._processUpdate(update)
        }
      } catch { /* polling error */ }
    }, 3000)
  }

  private async _processUpdate(update: Record<string, unknown>): Promise<void> {
    const msg = update.message as Record<string, unknown> | undefined
    if (!msg) return
    const text = msg.text as string | undefined
    if (!text) return
    const chat = msg.chat as Record<string, unknown> | undefined
    if (!chat) return
    const from = msg.from as Record<string, unknown> | undefined
    const chatId = String(chat.id!)
    const senderId = from?.id ? String(from.id) : chatId

    if (!this.isAllowed(senderId)) return

    if (this.onMessage) {
      const inbound = new InboundMessage({
        channel: 'telegram',
        senderId,
        chatId,
        content: text,
        metadata: {},
      })
      this.onMessage(inbound).then((r) => { if (r) this.send(r) })
    }
  }

  private async _api(method: string, params: Record<string, unknown>): Promise<any> {
    const response = await fetch(`${API_BASE}${this.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    if (!response.ok) throw new Error(`Telegram API ${response.status}`)
    return response.json()
  }
}
