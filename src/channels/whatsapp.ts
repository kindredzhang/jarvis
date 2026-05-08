/**
 * WhatsAppChannel —— WhatsApp Cloud API 通道
 *
 * 基于 Meta WhatsApp Cloud API（Webhook + REST）。
 *
 * 工作原理：
 * 1. 启动 HTTP 服务器接收 WhatsApp Webhook 回调
 * 2. Meta POST /webhook/whatsapp 推送消息事件
 * 3. 解析消息 → InboundMessage → AgentLoop.processMessage
 * 4. 通过 WhatsApp Cloud API 发送回复
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * - 无 Node.js WebSocket bridge（直接 REST API）
 * - 无图片/音频/文档媒体消息处理
 * - 无位置/联系人/按钮交互消息
 * - 无群组消息支持
 * - 无消息模板
 * - 无反应/已读标记
 * - 无自动重连
 */

import { BaseChannel, type ChannelConfig } from './base'
import { InboundMessage, type OutboundMessage } from '../bus'

export interface WhatsAppConfig extends ChannelConfig {
  /** WhatsApp Business Phone Number ID */
  phoneNumberId: string
  /** WhatsApp Cloud API Access Token */
  accessToken: string
  /** Webhook Verify Token（用于 Meta Webhook 验证） */
  verifyToken: string
  /** API 版本（默认 v20.0） */
  apiVersion?: string
}

const DEFAULT_API_VERSION = 'v20.0'
const WHATSAPP_API = 'https://graph.facebook.com'

export class WhatsAppChannel extends BaseChannel {
  override readonly name = 'whatsapp'
  private phoneNumberId: string
  private accessToken: string
  private verifyToken: string
  private apiVersion: string

  /** 消息处理回调 */
  onMessage: ((msg: InboundMessage) => Promise<OutboundMessage | null>) | null = null

  constructor(config: WhatsAppConfig) {
    super('whatsapp', config)
    this.phoneNumberId = config.phoneNumberId
    this.accessToken = config.accessToken
    this.verifyToken = config.verifyToken
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION
  }

  async start(): Promise<void> {
    this.running = true
    console.log('[WhatsApp] Channel started (webhook mode)')
  }

  async stop(): Promise<void> {
    this.running = false
    console.log('[WhatsApp] Channel stopped')
  }

  async send(msg: OutboundMessage): Promise<void> {
    const content = msg.content
    if (!content) return

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: msg.chatId,
      type: 'text',
      text: { preview_url: false, body: content },
    }

    const response = await fetch(
      `${WHATSAPP_API}/${this.apiVersion}/${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      },
    )

    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown')
      throw new Error(`WhatsApp send error ${response.status}: ${err}`)
    }
  }

  /** 处理 WhatsApp Webhook GET 请求（Meta 验证端点） */
  handleVerify(mode: string | null, token: string | null, challenge: string | null): string | null {
    if (mode === 'subscribe' && token === this.verifyToken) {
      return challenge
    }
    return null
  }

  /** 处理 WhatsApp Webhook POST 请求 */
  async handleWebhook(body: Record<string, unknown>): Promise<void> {
    const entries = body.entry as Record<string, unknown>[] | undefined
    if (!entries) return

    for (const entry of entries) {
      const changes = entry.changes as Record<string, unknown>[] | undefined
      if (!changes) continue

      for (const change of changes) {
        const value = change.value as Record<string, unknown> | undefined
        if (!value) continue

        const messages = value.messages as Record<string, unknown>[] | undefined
        if (!messages) continue

        for (const msg of messages) {
          await this._processMessage(msg, value)
        }
      }
    }
  }

  private async _processMessage(
    msg: Record<string, unknown>,
    value: Record<string, unknown>,
  ): Promise<void> {
    const msgType = msg.type as string
    if (msgType !== 'text') return

    const text = (msg.text as Record<string, string>)?.body ?? ''
    if (!text.trim()) return

    const from = msg.from as string
    const msgId = msg.id as string
    const metadata = value.metadata as Record<string, unknown> | undefined
    const phoneNumberId = metadata?.phone_number_id as string ?? this.phoneNumberId

    if (!this.isAllowed(from)) {
      console.warn(`[WhatsApp] Access denied for ${from}`)
      return
    }

    if (this.onMessage) {
      const inbound = new InboundMessage({
        channel: 'whatsapp',
        senderId: from,
        chatId: from,
        content: text,
        metadata: {
          message_id: msgId,
          phone_number_id: phoneNumberId,
        },
      })

      this.onMessage(inbound).then((response) => {
        if (response) {
          // 设置正确的 chatId（发送方手机号）
          response.chatId = from
          this.send(response)
        }
      })
    }
  }
}
