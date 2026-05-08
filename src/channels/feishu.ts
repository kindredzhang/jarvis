/**
 * FeishuChannel —— 飞书通道
 *
 * 基于 Webhook 接收消息 + REST API 发送回复。
 * 使用飞书开放平台的自建应用能力。
 *
 * 工作原理：
 * 1. 启动 HTTP 服务器接收飞书事件回调
 * 2. 飞书 POST /webhook/feishu 推送消息事件
 * 3. 解析消息 → InboundMessage → AgentLoop.processMessage
 * 4. 通过飞书 API 发送回复
 *
 * ========= TODO: 与 Python 原版差异标注 =========
 * - 无 WebSocket 长连接（使用 Webhook）
 * - 无 lark-oapi SDK（直接 fetch API）
 * - 无 CardKit 流式卡片（当前纯文本回复）
 * - 无 emoji 反应（react_emoji / done_emoji）
 * - 无 @ 提及解析（_resolve_mentions）
 * - 无富文本 post 消息解析（仅纯文本 text 消息）
 * - 无图片/文件/音频下载
 * - 无群组策略（group_policy）
 * - 无消息去重缓存
 * - 无自动重连
 */

import { BaseChannel, type ChannelConfig } from './base'
import { InboundMessage, type OutboundMessage } from '../bus'

export interface FeishuConfig extends ChannelConfig {
  /** 飞书应用 App ID */
  appId: string
  /** 飞书应用 App Secret */
  appSecret: string
  /** Webhook 验证 token */
  verificationToken?: string
}

/** 飞书 API 基础 URL */
const FEISHU_API = 'https://open.feishu.cn/open-apis'

export class FeishuChannel extends BaseChannel {
  override readonly name = 'feishu'
  private appId: string
  private appSecret: string
  private verificationToken: string
  private tenantToken: string | null = null
  private tokenExpiresAt = 0

  /** 消息处理回调 */
  onMessage: ((msg: InboundMessage) => Promise<OutboundMessage | null>) | null = null

  constructor(config: FeishuConfig) {
    super('feishu', config)
    this.appId = config.appId
    this.appSecret = config.appSecret
    this.verificationToken = config.verificationToken ?? ''
  }

  async start(): Promise<void> {
    this.running = true
    console.log('[Feishu] Channel started (webhook mode)')
  }

  async stop(): Promise<void> {
    this.running = false
    console.log('[Feishu] Channel stopped')
  }

  async send(msg: OutboundMessage): Promise<void> {
    const token = await this._ensureToken()
    const content = msg.content

    if (!content) return

    const body = {
      receive_id: msg.chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: content }),
    }

    const response = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=open_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown')
      throw new Error(`Feishu send error ${response.status}: ${err}`)
    }
  }

  /** 处理飞书 Webhook 回调 */
  async handleWebhook(body: Record<string, unknown>): Promise<{ message?: string }> {
    // Challenge 验证
    if (body.type === 'url_verification') {
      return { message: body.challenge as string }
    }

    const header = body.header as Record<string, unknown> | undefined
    if (!header) return {}

    const eventType = header.event_type as string
    if (eventType !== 'im.message.receive_v1') return {}

    const event = body.event as Record<string, unknown> | undefined
    if (!event) return {}

    const message = event.message as Record<string, unknown> | undefined
    if (!message) return {}

    const msgType = message.msg_type as string
    if (msgType !== 'text') return {}

    // 解析 text 内容
    const contentRaw = message.content as string
    let text = ''
    try {
      const parsed = JSON.parse(contentRaw)
      text = (parsed.text as string) ?? ''
    } catch {
      text = contentRaw
    }

    if (!text.trim()) return {}

    const sender = event.sender as Record<string, unknown> | undefined
    const senderId = (sender?.sender_id as Record<string, string> | undefined)?.open_id ?? ''
    const chatId = (message.chat_id as string) ?? ''
    const messageId = (message.message_id as string) ?? ''

    if (!this.isAllowed(senderId)) {
      console.warn(`[Feishu] Access denied for ${senderId}`)
      return {}
    }

    if (this.onMessage) {
      const inbound = new InboundMessage({
        channel: 'feishu',
        senderId,
        chatId,
        content: text,
        metadata: { message_id: messageId },
      })
      // Fire-and-forget: process in background
      this.onMessage(inbound).then((response) => {
        if (response) this.send(response)
      })
    }

    return {}
  }

  private async _ensureToken(): Promise<string> {
    if (this.tenantToken && Date.now() < this.tokenExpiresAt) {
      return this.tenantToken
    }

    const response = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    })

    if (!response.ok) {
      throw new Error(`Failed to get Feishu token: ${response.status}`)
    }

    const data = (await response.json()) as Record<string, unknown>
    this.tenantToken = data.tenant_access_token as string
    this.tokenExpiresAt = Date.now() + ((data.expire as number) ?? 7200) * 1000 - 60_000
    return this.tenantToken!
  }
}
