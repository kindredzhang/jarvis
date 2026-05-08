/**
 * DingTalkChannel —— 钉钉机器人通道
 *
 * Port of original Python channels/dingtalk.py.
 * Uses DingTalk REST API (HTTP) for sending messages.
 * Receives via webhook endpoint when using outgoing bot mode.
 *
 * No dingtalk-stream SDK dependency — implements the REST API directly.
 */

import { BaseChannel, type ChannelConfig } from './base'
import { InboundMessage, type OutboundMessage } from '../bus'

export interface DingTalkConfig extends ChannelConfig {
  /** AppKey / Client ID */
  clientId: string
  /** AppSecret */
  clientSecret: string
}

// ---- Constants ----

const OAPI_BASE = 'https://oapi.dingtalk.com'
const API_BASE = 'https://api.dingtalk.com'
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'])
const AUDIO_EXTS = new Set(['.amr', '.mp3', '.wav', '.ogg', '.m4a', '.aac'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm'])
const ZIP_BEFORE_UPLOAD_EXTS = new Set(['.htm', '.html'])
const TOKEN_EXPIRY_SKEW_S = 60

// ---- Channel ----

export class DingTalkChannel extends BaseChannel {
  override readonly name = 'dingtalk'
  private clientId: string
  private clientSecret: string
  private accessToken: string | null = null
  private tokenExpiresAt = 0

  onMessage: ((msg: InboundMessage) => Promise<OutboundMessage | null>) | null = null

  constructor(config: DingTalkConfig) {
    super('dingtalk', config)
    this.clientId = config.clientId
    this.clientSecret = config.clientSecret
  }

  async start(): Promise<void> {
    if (!this.clientId || !this.clientSecret) {
      console.warn('[DingTalk] clientId and clientSecret not configured')
      return
    }
    this.running = true
    console.log('[DingTalk] Channel started (webhook/receive mode)')
  }

  async stop(): Promise<void> {
    this.running = false
    console.log('[DingTalk] Stopped')
  }

  // ========================================================================
  // Message sending
  // ========================================================================

  async send(msg: OutboundMessage): Promise<void> {
    const token = await this._getAccessToken()
    if (!token) return

    if (msg.content?.trim()) {
      await this._sendMarkdown(token, msg.chatId, msg.content.trim())
    }

    for (const mediaRef of msg.media ?? []) {
      const ok = await this._sendMediaRef(token, msg.chatId, mediaRef)
      if (!ok) {
        console.error(`[DingTalk] Media send failed: ${mediaRef}`)
        const fname = guessFilename(mediaRef, guessUploadType(mediaRef))
        await this._sendMarkdown(token, msg.chatId, `[Attachment send failed: ${fname}]`)
      }
    }
  }

  private async _sendMarkdown(token: string, chatId: string, content: string): Promise<boolean> {
    return this._sendBatchMessage(token, chatId, 'sampleMarkdown', {
      text: content,
      title: 'Jarvis Reply',
    })
  }

  private async _sendBatchMessage(
    token: string,
    chatId: string,
    msgKey: string,
    msgParam: Record<string, string>,
  ): Promise<boolean> {
    const headers = { 'x-acs-dingtalk-access-token': token }

    if (chatId.startsWith('group:')) {
      const conversationId = chatId.slice(6)
      const resp = await fetch(`${API_BASE}/v1.0/robot/groupMessages/send`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          robotCode: this.clientId,
          openConversationId: conversationId,
          msgKey,
          msgParam: JSON.stringify(msgParam),
        }),
      })
      return resp.ok
    }

    // Private chat
    const resp = await fetch(`${API_BASE}/v1.0/robot/oToMessages/batchSend`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        robotCode: this.clientId,
        userIds: [chatId],
        msgKey,
        msgParam: JSON.stringify(msgParam),
      }),
    })
    return resp.ok
  }

  private async _sendMediaRef(token: string, chatId: string, mediaRef: string): Promise<boolean> {
    const ref = mediaRef.trim()
    if (!ref) return true

    const uploadType = guessUploadType(ref)

    // Direct URL for images
    if (uploadType === 'image' && isHttpUrl(ref)) {
      const ok = await this._sendBatchMessage(token, chatId, 'sampleImageMsg', {
        photoURL: ref,
      })
      if (ok) return true
      console.warn(`[DingTalk] Image URL send failed, trying upload: ${ref}`)
    }

    // Read file bytes
    const { data, filename, contentType } = await this._readMediaBytes(ref)
    if (!data) {
      console.error(`[DingTalk] Media read failed: ${ref}`)
      return false
    }

    let uploadData = data
    let uploadFilename = filename ?? guessFilename(ref, uploadType)
    let uploadContentType = contentType

    // Zip HTML files (DingTalk doesn't accept raw HTML)
    const ext = '.' + uploadFilename.split('.').pop()?.toLowerCase()
    if (ZIP_BEFORE_UPLOAD_EXTS.has(ext) || contentType === 'text/html') {
      console.log(`[DingTalk] Zipping ${uploadFilename} before upload`)
      const zipped = zipFile(uploadFilename, data)
      uploadData = zipped.data
      uploadFilename = zipped.name
      uploadContentType = 'application/zip'
    }

    let fileType = uploadFilename.split('.').pop()?.toLowerCase() ?? 'bin'
    if (fileType === 'jpeg') fileType = 'jpg'

    const mediaId = await this._uploadMedia(token, uploadData, uploadType, uploadFilename, uploadContentType)
    if (!mediaId) return false

    // Try image message first, fall back to file
    if (uploadType === 'image') {
      const ok = await this._sendBatchMessage(token, chatId, 'sampleImageMsg', {
        photoURL: mediaId,
      })
      if (ok) return true
      console.warn(`[DingTalk] Image media_id send failed, falling back to file: ${ref}`)
    }

    return this._sendBatchMessage(token, chatId, 'sampleFile', {
      mediaId,
      fileName: uploadFilename,
      fileType,
    })
  }

  // ========================================================================
  // Access Token management
  // ========================================================================

  private async _getAccessToken(): Promise<string | null> {
    const now = Date.now() / 1000
    if (this.accessToken && now < this.tokenExpiresAt) {
      return this.accessToken
    }

    try {
      const resp = await fetch(`${API_BASE}/v1.0/oauth2/accessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appKey: this.clientId,
          appSecret: this.clientSecret,
        }),
      })
      if (!resp.ok) {
        console.error(`[DingTalk] Token request failed: ${resp.status}`)
        return null
      }
      const data = (await resp.json()) as Record<string, unknown>
      this.accessToken = (data.accessToken as string) ?? null
      const expireIn = (data.expireIn as number) ?? 7200
      this.tokenExpiresAt = now + expireIn - TOKEN_EXPIRY_SKEW_S
      return this.accessToken
    } catch (e) {
      console.error(`[DingTalk] Token error: ${e}`)
      return null
    }
  }

  // ========================================================================
  // Media upload
  // ========================================================================

  private async _uploadMedia(
    token: string,
    data: Uint8Array,
    mediaType: string,
    filename: string,
    contentType: string | null,
  ): Promise<string | null> {
    const formData = new FormData()
    const blob = new Blob([data.slice(0)], { type: contentType ?? 'application/octet-stream' })
    formData.append('media', blob, filename)

    const url = `${OAPI_BASE}/media/upload?access_token=${token}&type=${mediaType}`

    try {
      const resp = await fetch(url, { method: 'POST', body: formData })
      const text = await resp.text()
      const result = safeJsonParse(text)
      const errcode = result?.errcode ?? 0
      if (errcode !== 0) {
        console.error(`[DingTalk] Media upload error code=${errcode} type=${mediaType}`)
        return null
      }
      const sub = (result?.result ?? {}) as Record<string, unknown>
      const mediaId = (result?.media_id ?? result?.mediaId ?? sub.media_id ?? sub.mediaId) as string | undefined
      if (!mediaId) {
        console.error(`[DingTalk] Media upload missing media_id`)
        return null
      }
      return mediaId
    } catch (e) {
      console.error(`[DingTalk] Media upload network error: ${e}`)
      return null
    }
  }

  // ========================================================================
  // Media file reading
  // ========================================================================

  private async _readMediaBytes(
    ref: string,
  ): Promise<{ data: Uint8Array | null; filename: string | null; contentType: string | null }> {
    if (!ref) return { data: null, filename: null, contentType: null }

    try {
      if (isHttpUrl(ref)) {
        const resp = await fetch(ref)
        if (!resp.ok) {
          console.warn(`[DingTalk] Media download failed status=${resp.status} ref=${ref}`)
          return { data: null, filename: null, contentType: null }
        }
        const arrayBuffer = await resp.arrayBuffer()
        const contentType = resp.headers.get('content-type')?.split(';')[0]?.trim() ?? null
        const filename = guessFilename(ref, guessUploadType(ref))
        return { data: new Uint8Array(arrayBuffer), filename, contentType }
      }

      // Local file
      const filePath = ref.startsWith('file://') ? ref.slice(7) : ref
      const file = Bun.file(filePath)
      const exists = await file.exists()
      if (!exists) {
        console.warn(`[DingTalk] Media file not found: ${filePath}`)
        return { data: null, filename: null, contentType: null }
      }
      const arrayBuffer = await file.arrayBuffer()
      const contentType = file.type || null
      return { data: new Uint8Array(arrayBuffer), filename: filePath.split('/').pop() ?? null, contentType }
    } catch (e) {
      console.error(`[DingTalk] Media read error ref=${ref} err=${e}`)
      return { data: null, filename: null, contentType: null }
    }
  }

  // ========================================================================
  // Webhook handler (called by HTTP server for receiving incoming messages)
  // ========================================================================

  async handleWebhook(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const content = extractMessageContent(body)
    if (!content) return { msg: 'ok' }

    const senderId = String((body.senderStaffId ?? body.senderId as string) || 'unknown')
    const senderNick = String(body.senderNick ?? 'Unknown')
    const conversationType = String(body.conversationType ?? '')
    const conversationId = String(body.conversationId ?? body.openConversationId ?? '')

    if (!conversationId) return { msg: 'ok' }

    const isGroup = conversationType === '2'
    const chatId = isGroup ? `group:${conversationId}` : senderId

    if (this.onMessage) {
      const inbound = new InboundMessage({
        channel: 'dingtalk',
        senderId,
        chatId,
        content,
        metadata: {
          sender_name: senderNick,
          platform: 'dingtalk',
          conversation_type: conversationType,
        },
      })
      this.onMessage(inbound).catch((err) => {
        console.error('[DingTalk] onMessage error:', err)
      })
    }

    return { msg: 'ok' }
  }
}

// ---- Helpers ----

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function guessUploadType(mediaRef: string): string {
  let path: string
  try {
    path = new URL(mediaRef).pathname
  } catch {
    path = mediaRef
  }
  const ext = path.split('.').pop()?.toLowerCase()
  const fullExt = '.' + ext
  if (IMAGE_EXTS.has(fullExt)) return 'image'
  if (AUDIO_EXTS.has(fullExt)) return 'voice'
  if (VIDEO_EXTS.has(fullExt)) return 'video'
  return 'file'
}

function guessFilename(mediaRef: string, uploadType: string): string {
  let path: string
  try {
    const url = new URL(mediaRef)
    path = url.pathname
  } catch {
    path = mediaRef
  }
  const name = path.split('/').pop() || ''
  if (name) return name
  const defaults: Record<string, string> = { image: 'image.jpg', voice: 'audio.amr', video: 'video.mp4' }
  return defaults[uploadType] ?? 'file.bin'
}

function extractMessageContent(body: Record<string, unknown>): string {
  // Try standard text content
  const text = (body.text as Record<string, unknown> | undefined)?.content as string | undefined
  if (text?.trim()) return text.trim()

  // Try recognition (voice)
  const content = body.content as Record<string, unknown> | undefined
  if (content?.recognition) return String(content.recognition).trim()

  return ''
}

function zipFile(filename: string, data: Uint8Array): { data: Uint8Array; name: string } {
  const stem = filename.split('.').slice(0, -1).join('.') || 'attachment'
  const zipName = `${stem}.zip`

  // Minimal ZIP construction: local file header + data descriptor
  // Using a simple approach: create a ZIP with deflate (store method = 0)
  const crc = crc32(data)
  const size = data.length

  // Local file header
  const header = new Uint8Array(30)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x04034b50, true) // signature
  view.setUint16(4, 20, true) // version needed
  view.setUint16(6, 0, true) // flags
  view.setUint16(8, 0, true) // compression: store
  view.setUint16(10, 0, true) // mod time
  view.setUint16(12, 0, true) // mod date
  view.setUint32(14, crc, true) // crc32
  view.setUint32(18, size, true) // compressed size
  view.setUint32(22, size, true) // uncompressed size
  view.setUint16(26, filename.length, true) // filename length
  view.setUint16(28, 0, true) // extra field length

  const encoder = new TextEncoder()
  const nameBytes = encoder.encode(filename)

  // Central directory entry
  const cdOffset = 30 + nameBytes.length
  const cd = new Uint8Array(46)
  const cdView = new DataView(cd.buffer)
  cdView.setUint32(0, 0x02014b50, true) // signature
  cdView.setUint16(4, 20, true) // version made by
  cdView.setUint16(6, 20, true) // version needed
  cdView.setUint16(8, 0, true) // flags
  cdView.setUint16(10, 0, true) // compression
  cdView.setUint16(12, 0, true) // mod time
  cdView.setUint16(14, 0, true) // mod date
  cdView.setUint32(16, crc, true) // crc32
  cdView.setUint32(20, size, true) // compressed size
  cdView.setUint32(24, size, true) // uncompressed size
  cdView.setUint16(28, filename.length, true) // filename length
  cdView.setUint16(30, 0, true) // extra field length
  cdView.setUint16(32, 0, true) // file comment length
  cdView.setUint16(34, 0, true) // disk number
  cdView.setUint16(36, 0, true) // internal attrs
  cdView.setUint32(38, 0, true) // external attrs
  cdView.setUint32(42, 0, true) // relative offset

  // End of central directory
  const eocdOffset = cdOffset + 46
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true) // signature
  eocdView.setUint16(4, 0, true) // disk number
  eocdView.setUint16(6, 0, true) // disk with central dir
  eocdView.setUint16(8, 1, true) // entries on disk
  eocdView.setUint16(10, 1, true) // total entries
  eocdView.setUint32(12, 46, true) // size of central dir
  eocdView.setUint32(16, cdOffset, true) // offset of central dir
  eocdView.setUint16(20, 0, true) // comment length

  // Concatenate: local header + name + file data + central dir + eocd
  const totalSize = 30 + nameBytes.length + size + 46 + 22
  const result = new Uint8Array(totalSize)
  result.set(header, 0)
  result.set(nameBytes, 30)
  result.set(data, 30 + nameBytes.length)
  result.set(cd, cdOffset)
  result.set(eocd, eocdOffset)

  return { data: result, name: zipName }
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!
    crc ^= byte
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}
