/**
 * WeComChannel —— 企业微信机器人通道
 *
 * Port of nanobot/channels/wecom.py.
 * Uses WeCom Corp REST API (HTTP) for sending messages and webhook for receiving.
 * No wecom_aibot_sdk dependency — implements the WeCom API protocol directly.
 *
 * 工作原理：
 * 1. 启动 HTTP 服务器接收企微回调推送
 * 2. 通过企微 REST API 发送回复（主动消息 + 文件上传）
 * 3. Access Token 自动管理（过期刷新）
 */

import { BaseChannel, type ChannelConfig } from './base'
import { InboundMessage, type OutboundMessage } from '../bus'

export interface WeComConfig extends ChannelConfig {
  /** 企业 ID（corpid） */
  corpId: string
  /** 应用 Agent ID */
  agentId: number
  /** 应用 Secret */
  corpSecret: string
  /** 欢迎消息（用户首次进入时发送） */
  welcomeMessage?: string
  /** Webhook 验证 Token（用于签名校验） */
  token?: string
  /** Webhook 消息加解密 Key */
  encodingAesKey?: string
}

// ---- Constants ----

const API_BASE = 'https://qyapi.weixin.qq.com'
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const AUDIO_EXTS = new Set(['.amr', '.mp3', '.wav', '.ogg'])
const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mov'])

// ---- Channel ----

export class WeComChannel extends BaseChannel {
  override readonly name = 'wecom'
  private corpId: string
  private agentId: number
  private corpSecret: string
  private welcomeMessage: string
  private accessToken: string | null = null
  private tokenExpiresAt = 0
  private dedupCache = new Set<string>()

  onMessage: ((msg: InboundMessage) => Promise<OutboundMessage | null>) | null = null

  constructor(config: WeComConfig) {
    super('wecom', config)
    this.corpId = config.corpId
    this.agentId = config.agentId
    this.corpSecret = config.corpSecret
    this.welcomeMessage = config.welcomeMessage ?? ''
  }

  async start(): Promise<void> {
    if (!this.corpId || !this.corpSecret) {
      console.warn('[WeCom] corpId and corpSecret not configured')
      return
    }
    this.running = true
    console.log('[WeCom] Channel started (webhook mode)')
  }

  async stop(): Promise<void> {
    this.running = false
    this.dedupCache.clear()
    console.log('[WeCom] Stopped')
  }

  // ========================================================================
  // Message sending
  // ========================================================================

  async send(msg: OutboundMessage): Promise<void> {
    const token = await this._getAccessToken()
    if (!token) return

    const content = msg.content?.trim() ?? ''

    // Send media files first
    for (const filePath of msg.media ?? []) {
      const mediaId = await this._uploadMedia(token, filePath)
      if (mediaId) {
        const mediaType = guessWeComMediaType(filePath)
        await this._sendMessage(token, msg.chatId, {
          msgtype: mediaType,
          [mediaType]: { media_id: mediaId },
        })
      } else {
        console.warn(`[WeCom] Media upload failed: ${filePath}`)
      }
    }

    // Send text content
    if (content) {
      await this._sendMessage(token, msg.chatId, {
        msgtype: 'text',
        text: { content },
      })
    }
  }

  private async _sendMessage(
    token: string,
    chatId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const resp = await fetch(`${API_BASE}/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        touser: chatId,
        agentid: this.agentId,
      }),
    })

    if (!resp.ok) {
      const err = await resp.text().catch(() => 'unknown')
      throw new Error(`WeCom send error ${resp.status}: ${err}`)
    }

    const data = (await resp.json()) as Record<string, unknown>
    if (data.errcode !== 0) {
      throw new Error(`WeCom send api error ${data.errcode}: ${data.errmsg}`)
    }
  }

  // ========================================================================
  // Access Token
  // ========================================================================

  private async _getAccessToken(): Promise<string | null> {
    const now = Date.now()
    if (this.accessToken && now < this.tokenExpiresAt) {
      return this.accessToken
    }

    try {
      const resp = await fetch(
        `${API_BASE}/cgi-bin/gettoken?corpid=${this.corpId}&corpsecret=${this.corpSecret}`,
      )
      if (!resp.ok) {
        console.error(`[WeCom] Token request failed: ${resp.status}`)
        return null
      }
      const data = (await resp.json()) as Record<string, unknown>
      if (data.errcode !== 0) {
        console.error(`[WeCom] Token api error ${data.errcode}: ${data.errmsg}`)
        return null
      }
      this.accessToken = data.access_token as string
      const expiresIn = (data.expires_in as number) ?? 7200
      this.tokenExpiresAt = now + (expiresIn - 60) * 1000
      return this.accessToken
    } catch (e) {
      console.error(`[WeCom] Token error: ${e}`)
      return null
    }
  }

  // ========================================================================
  // Media upload
  // ========================================================================

  private async _uploadMedia(token: string, filePath: string): Promise<string | null> {
    try {
      const file = Bun.file(filePath)
      const exists = await file.exists()
      if (!exists) {
        console.warn(`[WeCom] Media file not found: ${filePath}`)
        return null
      }

      const mediaType = guessWeComMediaType(filePath)
      const formData = new FormData()
      formData.append('media', file)

      const resp = await fetch(
        `${API_BASE}/cgi-bin/media/upload?access_token=${token}&type=${mediaType}`,
        { method: 'POST', body: formData },
      )

      if (!resp.ok) {
        console.error(`[WeCom] Media upload failed: ${resp.status}`)
        return null
      }

      const data = (await resp.json()) as Record<string, unknown>
      if (data.errcode !== 0) {
        console.error(`[WeCom] Media upload api error ${data.errcode}: ${data.errmsg}`)
        return null
      }

      return (data.media_id as string) ?? null
    } catch (e) {
      console.error(`[WeCom] Media upload error: ${e}`)
      return null
    }
  }

  // ========================================================================
  // Webhook handler (receiving messages from WeCom callback)
  // ========================================================================

  async handleWebhook(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    // WeCom message format: { ToUserName, FromUserName, CreateTime, MsgType, Content, MsgId, AgentID }
    const msgType = body.MsgType as string | undefined
    const msgId = String(body.MsgId ?? '')
    const fromUser = String(body.FromUserName ?? body.from ?? '')
    const content = String(body.Content ?? '')

    if (!msgType || !fromUser) return { errcode: 0, errmsg: 'ok' }

    // Dedup
    if (msgId && msgId !== 'undefined') {
      if (this.dedupCache.has(msgId)) return { errcode: 0, errmsg: 'ok' }
      this.dedupCache.add(msgId)
      if (this.dedupCache.size > 1000) {
        const first = this.dedupCache.values().next().value
        if (first) this.dedupCache.delete(first)
      }
    }

    let textContent = ''
    const mediaPaths: string[] = []

    switch (msgType) {
      case 'text': {
        textContent = content
        break
      }
      case 'image':
      case 'voice':
      case 'file': {
        const mediaId = body.MediaId as string | undefined
        textContent = `[${msgType}]`
        if (mediaId) {
          const savedPath = await this._downloadMedia(mediaId, msgType)
          if (savedPath) mediaPaths.push(savedPath)
        }
        break
      }
      default:
        textContent = `[${msgType}]`
    }

    if (!textContent.trim() && mediaPaths.length === 0) {
      return { errcode: 0, errmsg: 'ok' }
    }

    // Handle event messages
    if (msgType === 'event') {
      const event = body.Event as string | undefined
      if (event === 'enter_agent' && this.welcomeMessage) {
        // Send welcome message on first entry
        const token = await this._getAccessToken()
        if (token) {
          this._sendMessage(token, fromUser, {
            msgtype: 'text',
            text: { content: this.welcomeMessage },
          }).catch(() => {})
        }
      }
      return { errcode: 0, errmsg: 'ok' }
    }

    if (textContent && this.onMessage) {
      const inbound = new InboundMessage({
        channel: 'wecom',
        senderId: fromUser,
        chatId: fromUser,
        content: textContent,
        media: mediaPaths,
        metadata: {
          message_id: msgId,
          msg_type: msgType,
        },
      })

      this.onMessage(inbound).catch((err) => {
        console.error('[WeCom] onMessage error:', err)
      })
    }

    return { errcode: 0, errmsg: 'ok' }
  }

  private async _downloadMedia(
    mediaId: string,
    mediaType: string,
  ): Promise<string | null> {
    const token = await this._getAccessToken()
    if (!token) return null

    try {
      const resp = await fetch(
        `${API_BASE}/cgi-bin/media/get?access_token=${token}&media_id=${mediaId}`,
      )

      if (!resp.ok) return null

      const contentType = resp.headers.get('content-type') ?? ''
      // WeCom returns JSON on error even for media endpoints
      if (contentType.includes('json')) {
        const err = (await resp.json()) as Record<string, unknown>
        console.error(`[WeCom] Media download error ${err.errcode}: ${err.errmsg}`)
        return null
      }

      const arrayBuffer = await resp.arrayBuffer()
      const ext = mediaExtMap[mediaType] ?? '.bin'
      const timestamp = Date.now()
      const filename = `${mediaType}_${timestamp}${ext}`
      const filePath = `/tmp/wecom_${filename}`
      await Bun.write(filePath, new Uint8Array(arrayBuffer))
      return filePath
    } catch (e) {
      console.error(`[WeCom] Media download error: ${e}`)
      return null
    }
  }
}

// ---- Helpers ----

const mediaExtMap: Record<string, string> = {
  image: '.jpg',
  voice: '.amr',
  video: '.mp4',
  file: '.bin',
}

function guessWeComMediaType(filename: string): string {
  const ext = '.' + filename.split('.').pop()?.toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (AUDIO_EXTS.has(ext)) return 'voice'
  if (VIDEO_EXTS.has(ext)) return 'video'
  return 'file'
}
