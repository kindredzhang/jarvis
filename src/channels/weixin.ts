/**
 * WeixinChannel — Personal WeChat (微信) channel using HTTP long-poll API
 *
 * Port of original Python channels/weixin.py.
 * Uses the ilinkai.weixin.qq.com API for personal WeChat messaging.
 * Protocol reverse-engineered from @tencent-weixin/openclaw-weixin v1.0.3.
 *
 * No WeChat client needed — just HTTP requests with a bot token
 * obtained via QR code login.
 */

import { BaseChannel, type ChannelConfig } from './base'
import { InboundMessage, type OutboundMessage } from '../bus'
import { getMediaDir, getRuntimeSubdir } from '../config/paths'
import { splitMessage } from '../utils/helpers'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ========================================================================
// Config
// ========================================================================

export interface WeixinConfig extends ChannelConfig {
  baseUrl: string
  cdnBaseUrl: string
  routeTag: string | number | null
  token: string
  stateDir: string
  pollTimeout: number
}

// ========================================================================
// Protocol constants
// ========================================================================

// MessageItemType
const ITEM_TEXT = 1
const ITEM_IMAGE = 2
const ITEM_VOICE = 3
const ITEM_FILE = 4
const ITEM_VIDEO = 5

// MessageType (1 = user, 2 = bot)
const MESSAGE_TYPE_BOT = 2

// MessageState
const MESSAGE_STATE_FINISH = 2

const WEIXIN_MAX_MESSAGE_LEN = 4000
const WEIXIN_CHANNEL_VERSION = '2.1.1'
const ILINK_APP_ID = 'bot'
const ILINK_APP_CLIENT_VERSION = 0x020101 // encoded from "2.1.1"

const BASE_INFO = { channel_version: WEIXIN_CHANNEL_VERSION }

const ERRCODE_SESSION_EXPIRED = -14
const SESSION_PAUSE_DURATION_S = 60 * 60

const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_DELAY_S = 30
const RETRY_DELAY_S = 2
const MAX_QR_REFRESH_COUNT = 3
const TYPING_STATUS_TYPING = 1
const TYPING_STATUS_CANCEL = 2
const TYPING_KEEPALIVE_INTERVAL_S = 5
const DEFAULT_LONG_POLL_TIMEOUT_S = 35

// Upload media type codes
const UPLOAD_MEDIA_IMAGE = 1
const UPLOAD_MEDIA_VIDEO = 2
const UPLOAD_MEDIA_FILE = 3
const UPLOAD_MEDIA_VOICE = 4

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.ico', '.svg'])
const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv'])
const VOICE_EXTS = new Set(['.mp3', '.wav', '.amr', '.silk', '.ogg', '.m4a', '.aac', '.flac'])

// ========================================================================
// Helpers
// ========================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchWithTimeout(url: string, options: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const { timeout = 60000, ...rest } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { ...rest, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function hasDownloadableMedia(media: Record<string, unknown> | null | undefined): boolean {
  if (!media || typeof media !== 'object') return false
  return !!(String(media.encrypt_query_param ?? '') || String(media.full_url ?? '').trim())
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUint32BE(0)
  return Buffer.from(String(uint32)).toString('base64')
}

function extForType(mediaType: string): string {
  const map: Record<string, string> = { image: '.jpg', voice: '.silk', video: '.mp4', file: '' }
  return map[mediaType] ?? ''
}

function md5Hex(data: Buffer): string {
  return createHash('md5').update(data).digest('hex')
}

// ========================================================================
// AES-128-ECB helpers
// ========================================================================

function parseAesKey(aesKeyB64: string): Buffer {
  const decoded = Buffer.from(aesKeyB64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]+$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`)
}

function encryptAesEcb(data: Buffer, aesKeyB64: string): Buffer {
  const key = parseAesKey(aesKeyB64)
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

function decryptAesEcb(data: Buffer, aesKeyB64: string): Buffer {
  const key = parseAesKey(aesKeyB64)
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    return Buffer.concat([decipher.update(data), decipher.final()])
  } catch {
    return data
  }
}

// ========================================================================
// Channel
// ========================================================================

export class WeixinChannel extends BaseChannel {
  override readonly name = 'weixin'

  // Config
  private cfg: WeixinConfig

  // State
  private _token = ''
  private _getUpdatesBuf = ''
  private _contextTokens = new Map<string, string>() // from_user_id -> context_token
  private _processedIds: string[] = [] // capped array as ordered set
  private _stateDir: string | null = null
  private _polling = false
  private _nextPollTimeoutS = DEFAULT_LONG_POLL_TIMEOUT_S
  private _sessionPauseUntil = 0
  private _typingAbort = new Map<string, AbortController>()

  onMessage: ((msg: InboundMessage) => Promise<OutboundMessage | null>) | null = null

  constructor(config: WeixinConfig & Record<string, unknown>) {
    super('weixin', config)
    this.cfg = {
      enabled: config.enabled ?? false,
      baseUrl: config.baseUrl ?? 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: config.cdnBaseUrl ?? 'https://novac2c.cdn.weixin.qq.com/c2c',
      routeTag: config.routeTag ?? null,
      token: config.token ?? '',
      stateDir: config.stateDir ?? '',
      pollTimeout: config.pollTimeout ?? DEFAULT_LONG_POLL_TIMEOUT_S,
    }
  }

  // ========================================================================
  // State persistence
  // ========================================================================

  private _getStateDir(): string {
    if (this._stateDir) return this._stateDir
    if (this.cfg.stateDir) {
      this._stateDir = resolve(this.cfg.stateDir)
    } else {
      this._stateDir = getRuntimeSubdir('weixin')
    }
    mkdirSync(this._stateDir, { recursive: true })
    return this._stateDir
  }

  private _loadState(): boolean {
    const stateFile = join(this._getStateDir(), 'account.json')
    if (!existsSync(stateFile)) return false
    try {
      const data = JSON.parse(readFileSync(stateFile, 'utf-8'))
      this._token = data.token ?? ''
      this._getUpdatesBuf = data.get_updates_buf ?? ''
      if (data.context_tokens && typeof data.context_tokens === 'object') {
        for (const [uid, tok] of Object.entries(data.context_tokens)) {
          if (uid && tok) this._contextTokens.set(uid, String(tok))
        }
      }
      if (data.typing_tickets && typeof data.typing_tickets === 'object') {
        // stored for restore but we don't restore typing state in TS port
      }
      if (data.base_url) this.cfg.baseUrl = data.base_url
      return !!this._token
    } catch {
      return false
    }
  }

  private _saveState(): void {
    const stateFile = join(this._getStateDir(), 'account.json')
    try {
      const ctxTokens: Record<string, string> = {}
      for (const [k, v] of this._contextTokens) ctxTokens[k] = v
      const data = {
        token: this._token,
        get_updates_buf: this._getUpdatesBuf,
        context_tokens: ctxTokens,
        typing_tickets: {},
        base_url: this.cfg.baseUrl,
      }
      writeFileSync(stateFile, JSON.stringify(data, null, 2), 'utf-8')
    } catch {
      // best effort
    }
  }

  // ========================================================================
  // HTTP helpers
  // ========================================================================

  private _makeHeaders(auth = true): Record<string, string> {
    const headers: Record<string, string> = {
      'X-WECHAT-UIN': randomWechatUin(),
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    }
    if (auth && this._token) headers['Authorization'] = `Bearer ${this._token}`
    if (this.cfg.routeTag !== null && this.cfg.routeTag !== undefined) {
      headers['SKRouteTag'] = String(this.cfg.routeTag)
    }
    return headers
  }

  private async _apiGet(
    endpoint: string,
    params?: Record<string, string>,
    auth = true,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.cfg.baseUrl}/${endpoint}`)
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const headers = { ...this._makeHeaders(auth), ...extraHeaders }
    const resp = await fetchWithTimeout(url.toString(), { headers, timeout: 60000 })
    if (!resp.ok) throw new Error(`GET ${endpoint} failed: ${resp.status}`)
    return resp.json() as Promise<Record<string, unknown>>
  }

  private async _apiGetWithBase(
    baseUrl: string,
    endpoint: string,
    params?: Record<string, string>,
    auth = true,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${endpoint}`)
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const headers = { ...this._makeHeaders(auth), ...extraHeaders }
    const resp = await fetchWithTimeout(url.toString(), { headers, timeout: 60000 })
    if (!resp.ok) throw new Error(`GET ${endpoint} failed: ${resp.status}`)
    return resp.json() as Promise<Record<string, unknown>>
  }

  private async _apiPost(
    endpoint: string,
    body: Record<string, unknown> = {},
    auth = true,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { ...body }
    if (!payload.base_info) payload.base_info = BASE_INFO
    const resp = await fetchWithTimeout(`${this.cfg.baseUrl}/${endpoint}`, {
      method: 'POST',
      headers: this._makeHeaders(auth),
      body: JSON.stringify(payload),
      timeout: 120000,
    })
    if (!resp.ok) throw new Error(`POST ${endpoint} failed: ${resp.status}`)
    return resp.json() as Promise<Record<string, unknown>>
  }

  // ========================================================================
  // QR Code Login
  // ========================================================================

  private async _fetchQrCode(): Promise<[string, string]> {
    const data = await this._apiGet('ilink/bot/get_bot_qrcode', { bot_type: '3' }, false)
    const qrcodeId = String(data.qrcode ?? '')
    if (!qrcodeId) throw new Error(`Failed to get QR code: ${JSON.stringify(data)}`)
    const qrcodeImg = String(data.qrcode_img_content ?? '')
    return [qrcodeId, qrcodeImg || qrcodeId]
  }

  private _printQrCode(url: string): void {
    console.log(`\n[WeChat] Login URL: ${url}\n`)
  }

  override async login(opts?: { force?: boolean }): Promise<boolean> {
    const force = opts?.force ?? false
    if (force) {
      this._token = ''
      this._getUpdatesBuf = ''
      const stateFile = join(this._getStateDir(), 'account.json')
      if (existsSync(stateFile)) {
        try { readFileSync(stateFile) } catch { /* ignore */ }
      }
    }
    if (this._token || this._loadState()) return true
    return this._qrLogin()
  }

  private async _qrLogin(): Promise<boolean> {
    try {
      let refreshCount = 0
      let qrcodeId: string, scanUrl: string
      ;[qrcodeId, scanUrl] = await this._fetchQrCode()
      this._printQrCode(scanUrl)
      let currentPollBaseUrl = this.cfg.baseUrl

      while (this.running) {
        let statusData: Record<string, unknown>
        try {
          statusData = await this._apiGetWithBase(
            currentPollBaseUrl,
            'ilink/bot/get_qrcode_status',
            { qrcode: qrcodeId },
            false,
          )
        } catch (err) {
          if (this._isRetryableQrError(err)) {
            await sleep(1000)
            continue
          }
          throw err
        }

        if (!statusData || typeof statusData !== 'object') {
          await sleep(1000)
          continue
        }

        const status = String(statusData.status ?? '')

        if (status === 'confirmed') {
          const token = String(statusData.bot_token ?? '')
          const baseUrl = String(statusData.baseurl ?? '')
          if (token) {
            this._token = token
            if (baseUrl) this.cfg.baseUrl = baseUrl
            this._saveState()
            console.log(`[WeChat] Login successful! bot_id=${statusData.ilink_bot_id ?? ''} user_id=${statusData.ilink_user_id ?? ''}`)
            return true
          }
          console.error('[WeChat] Login confirmed but no bot_token')
          return false
        }

        if (status === 'scaned_but_redirect') {
          const redirectHost = String(statusData.redirect_host ?? '').trim()
          if (redirectHost) {
            const redirectedBase = redirectHost.startsWith('http://') || redirectHost.startsWith('https://')
              ? redirectHost
              : `https://${redirectHost}`
            if (redirectedBase !== currentPollBaseUrl) {
              currentPollBaseUrl = redirectedBase
            }
          }
        } else if (status === 'expired') {
          refreshCount++
          if (refreshCount > MAX_QR_REFRESH_COUNT) {
            console.warn(`[WeChat] QR expired too many times (${refreshCount - 1}/${MAX_QR_REFRESH_COUNT})`)
            return false
          }
          ;[qrcodeId, scanUrl] = await this._fetchQrCode()
          currentPollBaseUrl = this.cfg.baseUrl
          this._printQrCode(scanUrl)
          continue
        }

        await sleep(1000)
      }
    } catch (err) {
      console.error('[WeChat] QR login failed:', err)
    }
    return false
  }

  private _isRetryableQrError(err: unknown): boolean {
    if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('fetch failed'))) return true
    return false
  }

  // ========================================================================
  // Channel lifecycle
  // ========================================================================

  async start(): Promise<void> {
    this.running = true
    this._nextPollTimeoutS = this.cfg.pollTimeout

    if (this.cfg.token) {
      this._token = this.cfg.token
    } else if (!this._loadState()) {
      const ok = await this._qrLogin()
      if (!ok) {
        console.error('[WeChat] Login failed. Set token in config or call login() to authenticate.')
        this.running = false
        return
      }
    }

    console.log('[WeChat] Channel starting with long-poll...')
    this._polling = true
    this._pollLoop().catch((err) => {
      console.error('[WeChat] Poll loop error:', err)
    })
  }

  private async _pollLoop(): Promise<void> {
    let consecutiveFailures = 0

    while (this.running && this._polling) {
      try {
        const remaining = this._sessionPauseRemaining()
        if (remaining > 0) {
          await sleep(remaining * 1000)
          continue
        }
        await this._pollOnce()
        consecutiveFailures = 0
      } catch (err) {
        if (!this.running) break
        if (err instanceof Error && err.name === 'AbortError') {
          continue // long-poll timeout, normal
        }
        consecutiveFailures++
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0
          await sleep(BACKOFF_DELAY_S * 1000)
        } else {
          await sleep(RETRY_DELAY_S * 1000)
        }
      }
    }
  }

  private _sessionPauseRemaining(): number {
    const remaining = Math.ceil((this._sessionPauseUntil - Date.now()) / 1000)
    if (remaining <= 0) {
      this._sessionPauseUntil = 0
      return 0
    }
    return remaining
  }

  private async _pollOnce(): Promise<void> {
    const remaining = this._sessionPauseRemaining()
    if (remaining > 0) {
      await sleep(remaining * 1000)
      return
    }

    const body: Record<string, unknown> = {
      get_updates_buf: this._getUpdatesBuf,
      base_info: BASE_INFO,
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), (this._nextPollTimeoutS + 10) * 1000)

    try {
      const resp = await fetch(`${this.cfg.baseUrl}/ilink/bot/getupdates`, {
        method: 'POST',
        headers: this._makeHeaders(true),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!resp.ok) throw new Error(`getUpdates status ${resp.status}`)
      const data = (await resp.json()) as Record<string, unknown>

      // Check API errors
      const ret = data.ret as number | undefined
      const errcode = data.errcode as number | undefined
      const isError = (ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)

      if (isError) {
        if (errcode === ERRCODE_SESSION_EXPIRED || ret === ERRCODE_SESSION_EXPIRED) {
          this._pauseSession()
          const remainingMin = Math.max(Math.ceil(this._sessionPauseRemaining() / 60), 1)
          console.warn(`[WeChat] Session expired. Pausing ${remainingMin} min.`)
          return
        }
        throw new Error(`getUpdates failed: ret=${ret} errcode=${errcode} errmsg=${data.errmsg ?? ''}`)
      }

      // Honour server-suggested poll timeout
      const serverTimeoutMs = data.longpolling_timeout_ms as number | undefined
      if (serverTimeoutMs && serverTimeoutMs > 0) {
        this._nextPollTimeoutS = Math.max(Math.floor(serverTimeoutMs / 1000), 5)
      }

      // Update cursor
      const newBuf = String(data.get_updates_buf ?? '')
      if (newBuf) {
        this._getUpdatesBuf = newBuf
        this._saveState()
      }

      // Process messages
      const msgs = (data.msgs as Record<string, unknown>[]) ?? []
      for (const msg of msgs) {
        try {
          await this._processMessage(msg)
        } catch {
          // per-message error, continue
        }
      }
    } catch (err) {
      clearTimeout(timeoutId)
      throw err
    }
  }

  private _pauseSession(): void {
    this._sessionPauseUntil = Date.now() + SESSION_PAUSE_DURATION_S * 1000
  }

  async stop(): Promise<void> {
    this.running = false
    this._polling = false
    // Stop typing indicators
    for (const [chatId] of this._typingAbort) {
      this._stopTyping(chatId, false)
    }
    this._saveState()
    console.log('[WeChat] Stopped')
  }

  // ========================================================================
  // Inbound message processing
  // ========================================================================

  private async _processMessage(msg: Record<string, unknown>): Promise<void> {
    // Skip bot's own messages
    if (msg.message_type === MESSAGE_TYPE_BOT) return

    // Dedup
    const msgId = String(msg.message_id ?? msg.seq ?? '')
    const dedupKey = msgId || `${msg.from_user_id ?? ''}_${msg.create_time_ms ?? ''}`
    if (this._processedIds.includes(dedupKey)) return
    this._processedIds.push(dedupKey)
    if (this._processedIds.length > 1000) this._processedIds.shift()

    const fromUserId = String(msg.from_user_id ?? '')
    if (!fromUserId) return

    // Cache context_token
    const ctxToken = String(msg.context_token ?? '')
    if (ctxToken) {
      this._contextTokens.set(fromUserId, ctxToken)
      this._saveState()
    }

    // Parse item_list
    const itemList = (msg.item_list as Record<string, unknown>[]) ?? []
    const contentParts: string[] = []
    const mediaPaths: string[] = []
    let hasTopLevelDownloadableMedia = false

    for (const item of itemList) {
      const itemType = item.type as number

      if (itemType === ITEM_TEXT) {
        const textItem = item.text_item as Record<string, unknown> | undefined
        let text = String(textItem?.text ?? '')
        if (text) {
          const ref = item.ref_msg as Record<string, unknown> | undefined
          if (ref) {
            const refItem = ref.message_item as Record<string, unknown> | undefined
            if (refItem && [ITEM_IMAGE, ITEM_VOICE, ITEM_FILE, ITEM_VIDEO].includes(refItem.type as number)) {
              contentParts.push(text)
            } else {
              const parts: string[] = []
              if (ref.title) parts.push(String(ref.title))
              if (refItem) {
                const refText = String((refItem.text_item as Record<string, unknown> | undefined)?.text ?? '')
                if (refText) parts.push(refText)
              }
              if (parts.length > 0) {
                contentParts.push(`[引用: ${parts.join(' | ')}]\n${text}`)
              } else {
                contentParts.push(text)
              }
            }
          } else {
            contentParts.push(text)
          }
        }
      } else if (itemType === ITEM_IMAGE) {
        const imageItem = (item.image_item ?? {}) as Record<string, unknown>
        if (hasDownloadableMedia(imageItem.media as Record<string, unknown>)) {
          hasTopLevelDownloadableMedia = true
        }
        const filePath = await this._downloadMediaItem(imageItem, 'image')
        if (filePath) {
          contentParts.push(`[image]\n[Image: source: ${filePath}]`)
          mediaPaths.push(filePath)
        } else {
          contentParts.push('[image]')
        }
      } else if (itemType === ITEM_VOICE) {
        const voiceItem = (item.voice_item ?? {}) as Record<string, unknown>
        const voiceText = String(voiceItem.text ?? '')
        if (voiceText) {
          contentParts.push(`[voice] ${voiceText}`)
        } else {
          if (hasDownloadableMedia(voiceItem.media as Record<string, unknown>)) {
            hasTopLevelDownloadableMedia = true
          }
          const filePath = await this._downloadMediaItem(voiceItem, 'voice')
          if (filePath) {
            contentParts.push(`[voice]\n[Audio: source: ${filePath}]`)
            mediaPaths.push(filePath)
          } else {
            contentParts.push('[voice]')
          }
        }
      } else if (itemType === ITEM_FILE) {
        const fileItem = (item.file_item ?? {}) as Record<string, unknown>
        if (hasDownloadableMedia(fileItem.media as Record<string, unknown>)) {
          hasTopLevelDownloadableMedia = true
        }
        const fileName = String(fileItem.file_name ?? 'unknown')
        const filePath = await this._downloadMediaItem(fileItem, 'file', fileName)
        if (filePath) {
          contentParts.push(`[file: ${fileName}]\n[File: source: ${filePath}]`)
          mediaPaths.push(filePath)
        } else {
          contentParts.push(`[file: ${fileName}]`)
        }
      } else if (itemType === ITEM_VIDEO) {
        const videoItem = (item.video_item ?? {}) as Record<string, unknown>
        if (hasDownloadableMedia(videoItem.media as Record<string, unknown>)) {
          hasTopLevelDownloadableMedia = true
        }
        const filePath = await this._downloadMediaItem(videoItem, 'video')
        if (filePath) {
          contentParts.push(`[video]\n[Video: source: ${filePath}]`)
          mediaPaths.push(filePath)
        } else {
          contentParts.push('[video]')
        }
      }
    }

    // Fallback: try quoted/referenced media when no direct media was downloaded
    if (mediaPaths.length === 0 && !hasTopLevelDownloadableMedia) {
      for (const item of itemList) {
        if ((item.type as number) !== ITEM_TEXT) continue
        const ref = (item.ref_msg ?? {}) as Record<string, unknown>
        const refItem = (ref.message_item ?? {}) as Record<string, unknown>
        const refType = refItem.type as number | undefined

        if (refType === ITEM_IMAGE) {
          const fp = await this._downloadMediaItem((refItem.image_item ?? {}) as Record<string, unknown>, 'image')
          if (fp) { contentParts.push(`[image]\n[Image: source: ${fp}]`); mediaPaths.push(fp) }
        } else if (refType === ITEM_VOICE) {
          const fp = await this._downloadMediaItem((refItem.voice_item ?? {}) as Record<string, unknown>, 'voice')
          if (fp) { contentParts.push(`[voice]\n[Audio: source: ${fp}]`); mediaPaths.push(fp) }
        } else if (refType === ITEM_FILE) {
          const fn = String((refItem.file_item as Record<string, unknown> | undefined)?.file_name ?? 'unknown')
          const fp = await this._downloadMediaItem((refItem.file_item ?? {}) as Record<string, unknown>, 'file', fn)
          if (fp) { contentParts.push(`[file: ${fn}]\n[File: source: ${fp}]`); mediaPaths.push(fp) }
        } else if (refType === ITEM_VIDEO) {
          const fp = await this._downloadMediaItem((refItem.video_item ?? {}) as Record<string, unknown>, 'video')
          if (fp) { contentParts.push(`[video]\n[Video: source: ${fp}]`); mediaPaths.push(fp) }
        }
        if (mediaPaths.length > 0) break
      }
    }

    const content = contentParts.join('\n')
    if (!content) return

    console.log(`[WeChat] Inbound: from=${fromUserId} items=${itemList.map((i) => String(i.type ?? 0)).join(',')} bodyLen=${content.length}`)

    // Start typing indicator to show bot is processing
    this._startTyping(fromUserId)

    if (this.onMessage) {
      const inbound = new InboundMessage({
        channel: 'weixin',
        senderId: fromUserId,
        chatId: fromUserId,
        content,
        media: mediaPaths,
        metadata: { message_id: msgId },
      })
      this.onMessage(inbound).catch((err) => {
        console.error('[WeChat] onMessage error:', err)
      })
    }
  }

  // ========================================================================
  // Media download
  // ========================================================================

  private async _downloadMediaItem(
    typedItem: Record<string, unknown>,
    mediaType: string,
    filename?: string,
  ): Promise<string | null> {
    try {
      const media = (typedItem.media ?? {}) as Record<string, unknown>
      const encryptQueryParam = String(media.encrypt_query_param ?? '')
      const fullUrl = String(media.full_url ?? '').trim()

      if (!encryptQueryParam && !fullUrl) return null

      // Resolve AES key
      const rawAeskeyHex = String(typedItem.aeskey ?? '')
      const mediaAesKeyB64 = String(media.aes_key ?? '')

      let aesKeyB64 = ''
      if (rawAeskeyHex) {
        aesKeyB64 = Buffer.from(rawAeskeyHex, 'hex').toString('base64')
      } else if (mediaAesKeyB64) {
        aesKeyB64 = mediaAesKeyB64
      }

      if (mediaType !== 'image' && !aesKeyB64) return null

      // Build download URLs
      const fallbackUrl = encryptQueryParam
        ? `${this.cfg.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`
        : ''
      const candidates: { source: string; url: string }[] = []
      if (fullUrl) candidates.push({ source: 'full_url', url: fullUrl })
      if (fallbackUrl && (!fullUrl || fallbackUrl !== fullUrl)) {
        candidates.push({ source: 'encrypt_query_param', url: fallbackUrl })
      }

      let data: Buffer | null = null
      for (const [idx, candidate] of candidates.entries()) {
        try {
          const resp = await fetch(candidate.url)
          if (!resp.ok) {
            if (candidate.source === 'full_url' && idx + 1 < candidates.length && resp.status >= 500) {
              continue
            }
            throw new Error(`download status ${resp.status}`)
          }
          data = Buffer.from(await resp.arrayBuffer())
          break
        } catch (err) {
          if (candidate.source === 'full_url' && idx + 1 < candidates.length) {
            console.warn(`[WeChat] Media download failed via full_url, falling back: ${err}`)
            continue
          }
          throw err
        }
      }

      if (aesKeyB64 && data) {
        data = decryptAesEcb(data, aesKeyB64)
      }

      if (!data) return null

      const mediaDir = getMediaDir('weixin')
      mkdirSync(mediaDir, { recursive: true })
      const ext = extForType(mediaType)
      let safeName: string
      if (filename) {
        safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
      } else {
        const hash = Math.abs(hashStr(encryptQueryParam || fullUrl)) % 100000
        safeName = `${mediaType}_${Date.now()}_${hash}${ext}`
      }
      const filePath = join(mediaDir, safeName)
      writeFileSync(filePath, data)
      return filePath
    } catch (err) {
      console.error('[WeChat] Media download error:', err)
      return null
    }
  }

  // ========================================================================
  // Typing indicator
  // ========================================================================

  private async _getTypingTicket(userId: string, contextToken = ''): Promise<string> {
    const body: Record<string, unknown> = {
      ilink_user_id: userId,
      context_token: contextToken || null,
      base_info: BASE_INFO,
    }
    const data = await this._apiPost('ilink/bot/getconfig', body)

    if ((data.ret as number) === 0) {
      return String(data.typing_ticket ?? '')
    }
    return ''
  }

  private async _sendTyping(userId: string, typingTicket: string, status: number): Promise<void> {
    if (!typingTicket) return
    try {
      const body: Record<string, unknown> = {
        ilink_user_id: userId,
        typing_ticket: typingTicket,
        status,
        base_info: BASE_INFO,
      }
      await this._apiPost('ilink/bot/sendtyping', body)
    } catch {
      // best effort
    }
  }

  private async _startTyping(chatId: string): Promise<void> {
    if (!chatId) return
    this._stopTyping(chatId, false)
    try {
      const ctxToken = this._contextTokens.get(chatId) ?? ''
      const ticket = await this._getTypingTicket(chatId, ctxToken)
      if (!ticket) return
      await this._sendTyping(chatId, ticket, TYPING_STATUS_TYPING)
    } catch {
      return
    }

    const abortController = new AbortController()
    this._typingAbort.set(chatId, abortController)

    // Keepalive loop
    const keepalive = async () => {
      while (!abortController.signal.aborted) {
        await sleep(TYPING_KEEPALIVE_INTERVAL_S * 1000)
        if (abortController.signal.aborted) break
        try {
          const ctxToken = this._contextTokens.get(chatId) ?? ''
          const ticket = await this._getTypingTicket(chatId, ctxToken)
          if (ticket) await this._sendTyping(chatId, ticket, TYPING_STATUS_TYPING)
        } catch {
          // best effort
        }
      }
    }
    keepalive()
  }

  private _stopTyping(chatId: string, clearRemote: boolean): void {
    const abort = this._typingAbort.get(chatId)
    if (abort) {
      abort.abort()
      this._typingAbort.delete(chatId)
    }
    if (clearRemote) {
      this._sendTyping(chatId, '', TYPING_STATUS_CANCEL).catch(() => {})
    }
  }

  // ========================================================================
  // Outbound sending
  // ========================================================================

  async send(msg: OutboundMessage): Promise<void> {
    if (!this._token) {
      console.warn('[WeChat] Not authenticated')
      return
    }

    const isProgress = !!(msg.metadata?._progress)
    if (!isProgress) {
      this._stopTyping(msg.chatId, true)
    }

    const content = msg.content.trim()
    const ctxToken = this._contextTokens.get(msg.chatId) ?? ''
    if (!ctxToken) {
      console.warn(`[WeChat] No context_token for chat_id=${msg.chatId}`)
      return
    }

    // Start typing
    let typingTicket = ''
    try {
      typingTicket = await this._getTypingTicket(msg.chatId, ctxToken)
      if (typingTicket) await this._sendTyping(msg.chatId, typingTicket, TYPING_STATUS_TYPING)
    } catch {
      // best effort
    }

    const typingAbort = new AbortController()
    if (typingTicket) {
      const keepalive = async () => {
        while (!typingAbort.signal.aborted) {
          await sleep(TYPING_KEEPALIVE_INTERVAL_S * 1000)
          if (typingAbort.signal.aborted) break
          try {
            await this._sendTyping(msg.chatId, typingTicket, TYPING_STATUS_TYPING)
          } catch { /* best effort */ }
        }
      }
      keepalive()
    }

    try {
      // Send media files first
      for (const mediaPath of msg.media ?? []) {
        try {
          await this._sendMediaFile(msg.chatId, mediaPath, ctxToken)
        } catch (err) {
          const filename = mediaPath.split('/').pop() || 'attachment'
          console.error(`[WeChat] Failed to send media ${mediaPath}:`, err)
          await this._sendText(msg.chatId, `[Failed to send: ${filename}]`, ctxToken)
        }
      }

      // Send text
      if (!content) return
      const chunks = splitMessage(content, WEIXIN_MAX_MESSAGE_LEN)
      for (const chunk of chunks) {
        await this._sendText(msg.chatId, chunk, ctxToken)
      }
    } finally {
      typingAbort.abort()
      if (typingTicket && !isProgress) {
        try {
          await this._sendTyping(msg.chatId, typingTicket, TYPING_STATUS_CANCEL)
        } catch { /* best effort */ }
      }
    }
  }

  private async _sendText(
    toUserId: string,
    text: string,
    contextToken: string,
  ): Promise<void> {
    const clientId = `jarvis-${randomBytes(6).toString('hex')}`

    const itemList = text ? [{ type: ITEM_TEXT, text_item: { text } }] : []

    const weixinMsg: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
    }
    if (itemList.length > 0) weixinMsg.item_list = itemList
    if (contextToken) weixinMsg.context_token = contextToken

    const data = await this._apiPost('ilink/bot/sendmessage', { msg: weixinMsg })
    const errcode = data.errcode as number | undefined
    if (errcode && errcode !== 0) {
      console.warn(`[WeChat] Send error (code ${errcode}): ${data.errmsg ?? ''}`)
    }
  }

  private async _sendMediaFile(
    toUserId: string,
    mediaPath: string,
    contextToken: string,
  ): Promise<void> {
    if (!existsSync(mediaPath)) throw new Error(`File not found: ${mediaPath}`)

    const rawData = readFileSync(mediaPath)
    const rawSize = rawData.length
    const rawMd5 = md5Hex(rawData)

    const ext = mediaPath.split('.').pop()?.toLowerCase() ?? ''
    const dotExt = '.' + ext
    let uploadType: number, itemType: number, itemKey: string

    if (IMAGE_EXTS.has(dotExt)) {
      uploadType = UPLOAD_MEDIA_IMAGE; itemType = ITEM_IMAGE; itemKey = 'image_item'
    } else if (VIDEO_EXTS.has(dotExt)) {
      uploadType = UPLOAD_MEDIA_VIDEO; itemType = ITEM_VIDEO; itemKey = 'video_item'
    } else if (VOICE_EXTS.has(dotExt)) {
      uploadType = UPLOAD_MEDIA_VOICE; itemType = ITEM_VOICE; itemKey = 'voice_item'
    } else {
      uploadType = UPLOAD_MEDIA_FILE; itemType = ITEM_FILE; itemKey = 'file_item'
    }

    // Generate client-side AES-128 key
    const aesKeyRaw = randomBytes(16)
    const aesKeyHex = aesKeyRaw.toString('hex')

    // PKCS7 padded size
    const paddedSize = Math.ceil((rawSize + 1) / 16) * 16

    // Step 1: Get upload URL
    const fileKey = randomBytes(16).toString('hex')
    const uploadBody: Record<string, unknown> = {
      filekey: fileKey,
      media_type: uploadType,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: paddedSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
    }

    const uploadResp = await this._apiPost('ilink/bot/getuploadurl', uploadBody)
    const uploadFullUrl = String(uploadResp.upload_full_url ?? '').trim()
    const uploadParam = String(uploadResp.upload_param ?? '')

    if (!uploadFullUrl && !uploadParam) {
      throw new Error(`getuploadurl returned no URL: ${JSON.stringify(uploadResp)}`)
    }

    // Step 2: AES-128-ECB encrypt and POST to CDN
    const aesKeyB64 = aesKeyRaw.toString('base64')
    const encryptedData = encryptAesEcb(rawData, aesKeyB64)

    const cdnUploadUrl = uploadFullUrl ||
      `${this.cfg.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`

    const cdnResp = await fetch(cdnUploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encryptedData,
    })

    if (!cdnResp.ok) {
      throw new Error(`CDN upload failed: ${cdnResp.status}`)
    }

    const downloadParam = cdnResp.headers.get('x-encrypted-param')
    if (!downloadParam) {
      throw new Error(`CDN upload missing x-encrypted-param header (status=${cdnResp.status})`)
    }

    // Step 3: Send message with media item
    const cdnAesKeyB64 = Buffer.from(aesKeyHex).toString('base64')

    const mediaItem: Record<string, unknown> = {
      media: {
        encrypt_query_param: downloadParam,
        aes_key: cdnAesKeyB64,
        encrypt_type: 1,
      },
    }

    if (itemType === ITEM_IMAGE) {
      mediaItem.mid_size = paddedSize
    } else if (itemType === ITEM_VIDEO) {
      mediaItem.video_size = paddedSize
    } else if (itemType === ITEM_FILE) {
      mediaItem.file_name = mediaPath.split('/').pop() || 'attachment'
      mediaItem.len = String(rawSize)
    }

    const clientId = `jarvis-${randomBytes(6).toString('hex')}`
    const itemList = [{ type: itemType, [itemKey]: mediaItem }]

    const weixinMsg: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: itemList,
    }
    if (contextToken) weixinMsg.context_token = contextToken

    const data = await this._apiPost('ilink/bot/sendmessage', { msg: weixinMsg })
    const errcode = data.errcode as number | undefined
    if (errcode && errcode !== 0) {
      throw new Error(`WeChat send media error (code ${errcode}): ${data.errmsg ?? ''}`)
    }
  }
}

// ========================================================================
// Helpers
// ========================================================================

function hashStr(s: string): number {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return hash
}
