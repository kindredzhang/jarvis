/**
 * FeishuChannel — 飞书/Lark 通道
 *
 * 使用 @larksuiteoapi/node-sdk 实现 WebSocket 长连接接收消息。
 * 支持多格式发送（text/post/interactive 卡片）、CardKit 流式输出、
 * emoji 反应、@提及解析、富文本消息解析、媒体下载/上传。
 *
 * 从 Python 原版 feishu.py 完整移植。
 */

import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { BaseChannel, type ChannelConfig } from './base'
import { InboundMessage, type OutboundMessage } from '../bus'

// ---- Feishu Config ----

export interface FeishuConfig extends ChannelConfig {
  appId: string
  appSecret: string
  encryptKey?: string
  verificationToken?: string
  reactEmoji?: string
  doneEmoji?: string | null
  toolHintPrefix?: string
  domain?: 'feishu' | 'lark'
  replyToMessage?: boolean
}

const DEFAULT_CONFIG: Required<FeishuConfig> = {
  enabled: false,
  appId: '',
  appSecret: '',
  encryptKey: '',
  verificationToken: '',
  allowFrom: ['*'],
  groupPolicy: 'mention',
  streaming: true,
  reactEmoji: 'THUMBSUP',
  doneEmoji: null,
  toolHintPrefix: '🔧',
  domain: 'feishu',
  replyToMessage: false,
}

// ---- Stream Buffer ----

const STREAM_ELEMENT_ID = 'streaming_md'
const STREAM_EDIT_INTERVAL_MS = 500

interface StreamBuf {
  text: string
  cardId: string | null
  sequence: number
  lastEdit: number
}

// ---- Media constants ----

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif'])
const AUDIO_EXTS = new Set(['.opus'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi'])
const FILE_TYPE_MAP: Record<string, string> = {
  '.opus': 'opus', '.mp4': 'mp4', '.pdf': 'pdf',
  '.doc': 'doc', '.docx': 'doc', '.xls': 'xls',
  '.xlsx': 'xls', '.ppt': 'ppt', '.pptx': 'ppt',
}

const MSG_TYPE_MAP: Record<string, string> = {
  image: '[image]', audio: '[audio]', file: '[file]', sticker: '[sticker]',
}

const REPLY_CONTEXT_MAX_LEN = 200

// ---- Content extraction utilities ----

function extractInteractiveContent(content: unknown): string[] {
  const parts: string[] = []
  if (typeof content === 'string') {
    try { content = JSON.parse(content as string) } catch { const s = (content as string).trim(); return s ? [s] : [] }
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return parts
  const c = content as Record<string, unknown>

  if ('title' in c) {
    const title = c.title
    if (typeof title === 'object' && title !== null) {
      const tc = (title as Record<string, unknown>).content || (title as Record<string, unknown>).text
      if (tc) parts.push(`title: ${tc}`)
    } else if (typeof title === 'string') {
      parts.push(`title: ${title}`)
    }
  }

  const elements = c.elements
  if (Array.isArray(elements)) {
    for (const el of elements) parts.push(...extractElementContent(el))
  }

  if (c.card) parts.push(...extractInteractiveContent(c.card))
  if (c.header) {
    const headerTitle = (c.header as Record<string, unknown>).title
    if (headerTitle && typeof headerTitle === 'object') {
      const ht = (headerTitle as Record<string, unknown>).content || (headerTitle as Record<string, unknown>).text
      if (ht) parts.push(`title: ${ht}`)
    }
  }
  return parts
}

function extractElementContent(element: unknown): string[] {
  const parts: string[] = []
  if (!element || typeof element !== 'object' || Array.isArray(element)) return parts
  const el = element as Record<string, unknown>
  const tag = (el.tag as string) || ''

  if (tag === 'markdown' || tag === 'lark_md') {
    if (el.content) parts.push(String(el.content))
  } else if (tag === 'div') {
    const text = el.text
    if (typeof text === 'object' && text !== null) {
      const tc = (text as Record<string, unknown>).content || (text as Record<string, unknown>).text
      if (tc) parts.push(String(tc))
    } else if (typeof text === 'string') {
      parts.push(text)
    }
    for (const field of (el.fields as unknown[]) || []) {
      if (field && typeof field === 'object') {
        const ft = (field as Record<string, unknown>).text
        if (ft && typeof ft === 'object') {
          const fc = (ft as Record<string, unknown>).content
          if (fc) parts.push(String(fc))
        }
      }
    }
  } else if (tag === 'a') {
    if (el.href) parts.push(`link: ${el.href}`)
    if (el.text) parts.push(String(el.text))
  } else if (tag === 'button') {
    const text = el.text
    if (typeof text === 'object' && text !== null) {
      const tc = (text as Record<string, unknown>).content
      if (tc) parts.push(String(tc))
    }
    const url = el.url || (el.multi_url as Record<string, unknown>)?.url
    if (url) parts.push(`link: ${url}`)
  } else if (tag === 'img') {
    const alt = el.alt
    parts.push(typeof alt === 'object' && alt !== null ? String((alt as Record<string, unknown>).content || '[image]') : '[image]')
  } else if (tag === 'note') {
    for (const ne of (el.elements as unknown[]) || []) parts.push(...extractElementContent(ne))
  } else if (tag === 'column_set') {
    for (const col of (el.columns as unknown[]) || []) {
      for (const ce of ((col as Record<string, unknown>).elements as unknown[]) || []) {
        parts.push(...extractElementContent(ce))
      }
    }
  } else if (tag === 'plain_text') {
    if (el.content) parts.push(String(el.content))
  } else {
    for (const ne of (el.elements as unknown[]) || []) parts.push(...extractElementContent(ne))
  }
  return parts
}

function extractShareCardContent(contentJson: Record<string, unknown>, msgType: string): string {
  const parts: string[] = []
  if (msgType === 'share_chat') {
    parts.push(`[shared chat: ${contentJson.chat_id || ''}]`)
  } else if (msgType === 'share_user') {
    parts.push(`[shared user: ${contentJson.user_id || ''}]`)
  } else if (msgType === 'interactive') {
    parts.push(...extractInteractiveContent(contentJson))
  } else if (msgType === 'share_calendar_event') {
    parts.push(`[shared calendar event: ${contentJson.event_key || ''}]`)
  } else if (msgType === 'system') {
    parts.push('[system message]')
  } else if (msgType === 'merge_forward') {
    parts.push('[merged forward messages]')
  }
  return parts.join('\n') || `[${msgType}]`
}

interface PostContentResult { text: string; images: string[] }

function extractPostContent(contentJson: unknown): PostContentResult {
  function parseBlock(block: Record<string, unknown>): PostContentResult {
    const content = block.content
    if (!Array.isArray(content)) return { text: '', images: [] }
    const texts: string[] = []
    const images: string[] = []
    if (block.title) texts.push(String(block.title))
    for (const row of content) {
      if (!Array.isArray(row)) continue
      for (const el of row) {
        if (!el || typeof el !== 'object') continue
        const tag = (el as Record<string, unknown>).tag
        if (tag === 'text' || tag === 'a') {
          texts.push(String((el as Record<string, unknown>).text || ''))
        } else if (tag === 'at') {
          texts.push(`@${(el as Record<string, unknown>).user_name || 'user'}`)
        } else if (tag === 'code_block') {
          const lang = (el as Record<string, unknown>).language || ''
          const codeText = (el as Record<string, unknown>).text || ''
          texts.push(`\n\`\`\`${lang}\n${codeText}\n\`\`\`\n`)
        } else if (tag === 'img') {
          const key = (el as Record<string, unknown>).image_key
          if (key) images.push(String(key))
        }
      }
    }
    return { text: texts.join(' ').trim(), images }
  }

  if (!contentJson || typeof contentJson !== 'object') return { text: '', images: [] }
  let root = contentJson as Record<string, unknown>
  if (root.post && typeof root.post === 'object') root = root.post as Record<string, unknown>

  if ('content' in root) {
    const result = parseBlock(root)
    if (result.text || result.images.length) return result
  }

  for (const key of ['zh_cn', 'en_us', 'ja_jp']) {
    if (root[key] && typeof root[key] === 'object') {
      const result = parseBlock(root[key] as Record<string, unknown>)
      if (result.text || result.images.length) return result
    }
  }
  for (const val of Object.values(root)) {
    if (val && typeof val === 'object') {
      const result = parseBlock(val as Record<string, unknown>)
      if (result.text || result.images.length) return result
    }
  }
  return { text: '', images: [] }
}

// ---- Markdown → Feishu format conversion ----

const TABLE_RE = /((?:^[ \t]*\|.+\|[ \t]*\n)(?:^[ \t]*\|[-:\s|]+\|[ \t]*\n)(?:^[ \t]*\|.+\|[ \t]*\n?)+)/gm
const HEADING_RE = /^(#{1,6})\s+(.+)$/gm
const CODE_BLOCK_RE = /(```[\s\S]*?```)/gm
const MD_BOLD_RE = /\*\*(.+?)\*\*/g
const MD_BOLD_UNDERSCORE_RE = /__(.+?)__/g
const MD_ITALIC_RE = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g
const MD_STRIKE_RE = /~~(.+?)~~/g
const COMPLEX_MD_RE = /```|^\|.+\|.*\n\s*\|[-:\s|]+\||^#{1,6}\s+/m
const SIMPLE_MD_RE = /\*\*.+?\*\*|__.+?__|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|~~.+?~~/
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
const LIST_RE = /^[\s]*[-*+]\s+/m
const OLIST_RE = /^[\s]*\d+\.\s+/m

function stripMdFormatting(text: string): string {
  return text
    .replace(MD_BOLD_RE, '$1')
    .replace(MD_BOLD_UNDERSCORE_RE, '$1')
    .replace(MD_ITALIC_RE, '$1')
    .replace(MD_STRIKE_RE, '$1')
}

function parseMdTable(tableText: string): Record<string, unknown> | null {
  const lines = tableText.trim().split('\n').filter(l => l.trim())
  if (lines.length < 3) return null
  const split = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
  const headers = split(lines[0]!).map(stripMdFormatting)
  const rows = lines.slice(2).map(split).map(r => r.map(stripMdFormatting))
  const columns = headers.map((h, i) => ({ tag: 'column', name: `c${i}`, display_name: h, width: 'auto' }))
  return {
    tag: 'table',
    page_size: rows.length + 1,
    columns,
    rows: rows.map(r => {
      const row: Record<string, string> = {}
      headers.forEach((_, i) => { row[`c${i}`] = r[i] || '' })
      return row
    }),
  }
}

function splitHeadings(content: string): Record<string, unknown>[] {
  const codeBlocks: string[] = []
  let protected_ = content
  for (const m of content.matchAll(CODE_BLOCK_RE)) {
    codeBlocks.push(m[0])
    protected_ = protected_.replace(m[0], `\x00CODE${codeBlocks.length - 1}\x00`)
  }

  const elements: Record<string, unknown>[] = []
  let lastEnd = 0
  for (const m of protected_.matchAll(HEADING_RE)) {
    const before = protected_.slice(lastEnd, m.index).trim()
    if (before) elements.push({ tag: 'markdown', content: before })
    const text = stripMdFormatting(m[2]!.trim())
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: text ? `**${text}**` : '' } })
    lastEnd = (m.index ?? 0) + m[0].length
  }
  const remaining = protected_.slice(lastEnd).trim()
  if (remaining) elements.push({ tag: 'markdown', content: remaining })

  for (const el of elements) {
    if (el.tag === 'markdown' && typeof el.content === 'string') {
      let c = el.content
      codeBlocks.forEach((cb, i) => { c = c.replace(`\x00CODE${i}\x00`, cb) })
      el.content = c
    }
  }
  return elements.length ? elements : [{ tag: 'markdown', content }]
}

function buildCardElements(content: string): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = []
  let lastEnd = 0
  for (const m of content.matchAll(TABLE_RE)) {
    const before = content.slice(lastEnd, m.index).trim()
    if (before) elements.push(...splitHeadings(before))
    const table = parseMdTable(m[0])
    elements.push(table || { tag: 'markdown', content: m[0] })
    lastEnd = (m.index ?? 0) + m[0].length
  }
  const remaining = content.slice(lastEnd).trim()
  if (remaining) elements.push(...splitHeadings(remaining))
  return elements.length ? elements : [{ tag: 'markdown', content }]
}

function splitElementsByTableLimit(elements: Record<string, unknown>[], maxTables = 1): Record<string, unknown>[][] {
  if (!elements.length) return [[]]
  const groups: Record<string, unknown>[][] = []
  let current: Record<string, unknown>[] = []
  let tableCount = 0
  for (const el of elements) {
    if (el.tag === 'table') {
      if (tableCount >= maxTables) {
        if (current.length) groups.push(current)
        current = []
        tableCount = 0
      }
      current.push(el)
      tableCount++
    } else {
      current.push(el)
    }
  }
  if (current.length) groups.push(current)
  return groups.length ? groups : [[]]
}

function detectMsgFormat(content: string): 'text' | 'post' | 'interactive' {
  const stripped = content.trim()
  if (COMPLEX_MD_RE.test(stripped)) return 'interactive'
  if (stripped.length > 2000) return 'interactive'
  if (SIMPLE_MD_RE.test(stripped)) return 'interactive'
  if (LIST_RE.test(stripped) || OLIST_RE.test(stripped)) return 'interactive'
  if (MD_LINK_RE.test(stripped)) return 'post'
  if (stripped.length <= 200) return 'text'
  return 'post'
}

function markdownToPost(content: string): string {
  const lines = content.trim().split('\n')
  const paragraphs: Record<string, unknown>[][] = []
  for (const line of lines) {
    const elements: Record<string, unknown>[] = []
    let lastEnd = 0
    for (const m of line.matchAll(MD_LINK_RE)) {
      const before = line.slice(lastEnd, m.index!)
      if (before) elements.push({ tag: 'text', text: before })
      elements.push({ tag: 'a', text: m[1], href: m[2] })
      lastEnd = (m.index ?? 0) + m[0].length
    }
    const remaining = line.slice(lastEnd)
    if (remaining) elements.push({ tag: 'text', text: remaining })
    if (!elements.length) elements.push({ tag: 'text', text: '' })
    paragraphs.push(elements)
  }
  return JSON.stringify({ zh_cn: { content: paragraphs } })
}

function formatToolHintLines(toolHint: string): string {
  const parts: string[] = []
  const buf: string[] = []
  let depth = 0
  let inString = false
  let quoteChar = ''
  let escaped = false

  for (let i = 0; i < toolHint.length; i++) {
    const ch = toolHint[i]!
    buf.push(ch)
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === quoteChar) inString = false
      continue
    }
    if (ch === '"' || ch === "'") { inString = true; quoteChar = ch; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')' && depth > 0) { depth--; continue }
    if (ch === ',' && depth === 0) {
      const next = toolHint[i + 1]
      if (next === ' ') {
        parts.push(buf.join('').trimEnd())
        buf.length = 0
      }
    }
  }
  if (buf.length) parts.push(buf.join('').trim())
  return parts.filter(p => p).join('\n')
}

// ---- FeishuChannel ----

export class FeishuChannel extends BaseChannel {
  override readonly name = 'feishu'
  static readonly displayName = 'Feishu'

  private appId: string
  private appSecret: string
  private encryptKey: string
  private verificationToken: string
  private reactEmoji: string
  private doneEmoji: string | null
  private toolHintPrefix: string
  private domain: 'feishu' | 'lark'
  private replyToMessageFlag: boolean

  private _client: unknown = null
  private _wsClient: any = null
  private _processedMessageIds: Map<string, number> = new Map()
  private _streamBufs: Map<string, StreamBuf> = new Map()
  private _botOpenId: string | null = null
  private _sdkAvailable = false

  onMessage: ((msg: InboundMessage) => Promise<OutboundMessage | null>) | null = null

  constructor(config: FeishuConfig) {
    const merged = { ...DEFAULT_CONFIG, ...config }
    super('feishu', merged)
    this.appId = merged.appId
    this.appSecret = merged.appSecret
    this.encryptKey = merged.encryptKey
    this.verificationToken = merged.verificationToken
    this.reactEmoji = merged.reactEmoji
    this.doneEmoji = merged.doneEmoji
    this.toolHintPrefix = merged.toolHintPrefix
    this.domain = merged.domain
    this.replyToMessageFlag = merged.replyToMessage
    this.config.groupPolicy = merged.groupPolicy ?? 'mention'
  }

  // ---- Login ----

  override async login(_opts?: { force?: boolean }): Promise<boolean> {
    if (!this.appId || !this.appSecret) {
      console.log('Feishu login requires appId and appSecret.')
      console.log('Configure them in ~/.jarvis/config.json under channels.feishu:')
      console.log('  { "appId": "cli_xxx", "appSecret": "xxx" }')
      console.log()
      console.log('Get these from: https://open.feishu.cn/app')
      return false
    }

    try {
      const token = await this._fetchTenantToken()
      if (!token) {
        console.error('Login failed: could not obtain tenant access token')
        return false
      }

      const apiBase = this.domain === 'lark' ? 'https://open.larksuite.com/open-apis' : 'https://open.feishu.cn/open-apis'
      const res = await fetch(`${apiBase}/bot/v3/info`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        console.error(`Login failed: HTTP ${res.status}`)
        return false
      }

      const data = await res.json() as Record<string, unknown>
      if (data.code !== 0) {
        console.error(`Login failed: code=${data.code}, msg=${data.msg}`)
        return false
      }

      const bot = (data.bot || {}) as Record<string, unknown>
      console.log(`✓ Logged in as: ${bot.app_name || bot.name || 'Feishu Bot'}`)
      return true
    } catch (err) {
      console.error(`Login error: ${err}`)
      return false
    }
  }

  // ---- Lifecycle ----

  async start(): Promise<void> {
    await this._ensureSDK()
    if (!this._sdkAvailable) {
      console.error('[Feishu] SDK not available. Run: bun add @larksuiteoapi/node-sdk')
      return
    }
    if (!this.appId || !this.appSecret) {
      console.error('[Feishu] appId and appSecret not configured')
      return
    }

    const lark = await import('@larksuiteoapi/node-sdk')
    this.running = true

    const domain = this.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu
    const client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
      domain,
    })
    this._client = client

    // Fetch bot open_id
    const apiBase = this.domain === 'lark' ? 'https://open.larksuite.com/open-apis' : 'https://open.feishu.cn/open-apis'
    try {
      const token = await this._fetchTenantToken()
      if (token) {
        const res = await fetch(`${apiBase}/bot/v3/info`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data = await res.json() as Record<string, unknown>
          if (data.code === 0) {
            const bot = (data.bot || {}) as Record<string, unknown>
            this._botOpenId = (bot.open_id as string) || null
            if (this._botOpenId) console.log(`[Feishu] Bot open_id: ${this._botOpenId}`)
          }
        }
      }
    } catch (e) {
      console.warn('[Feishu] Could not fetch bot open_id:', e)
    }

    // Build event dispatcher with all event handlers
    const eventDispatcher = new lark.EventDispatcher({
      encryptKey: this.encryptKey || undefined,
    }).register({
      'im.message.receive_v1': (data: unknown) => {
        this._onMessageSync(data)
      },
      'im.message.reaction.created_v1': () => {},
      'im.message.reaction.deleted_v1': () => {},
      'im.message.message_read_v1': () => {},
      'im.chat.access_event.bot_p2p_chat_entered_v1': () => {},
    })

    // Start WebSocket long connection
    this._wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain,
    })

    ;(this._wsClient as any).start({ eventDispatcher })
    console.log('[Feishu] Bot started with WebSocket long connection (no public IP required)')
  }

  async stop(): Promise<void> {
    this.running = false
    try {
      if (this._wsClient && typeof this._wsClient.stop === 'function') this._wsClient.stop()
    } catch (e) {
      console.warn('[Feishu] Error stopping WS client:', e)
    }
    console.log('[Feishu] Channel stopped')
  }

  // ---- Message receiving ----

  private _onMessageSync(data: unknown): void {
    this._onMessage(data).catch(err => {
      console.error('[Feishu] Error processing message:', err)
    })
  }

  private async _onMessage(data: unknown): Promise<void> {
    try {
      const d = data as Record<string, unknown>
      // EventDispatcher unwraps the outer "event" envelope (decrypts if needed)
      const event = (d.event as Record<string, unknown> | undefined) ?? d
      if (!event || event === d && !event.message) return

      const message = event.message as Record<string, unknown> | undefined
      const sender = event.sender as Record<string, unknown> | undefined
      if (!message || !sender) return

      const messageId = message.message_id as string
      const chatId = message.chat_id as string
      const chatType = message.chat_type as string || 'p2p'
      const msgType = message.message_type as string || 'text'

      // Dedup
      if (messageId && this._processedMessageIds.has(messageId)) return
      if (messageId) {
        this._processedMessageIds.set(messageId, Date.now())
        if (this._processedMessageIds.size > 1000) {
          const first = this._processedMessageIds.keys().next().value
          if (first) this._processedMessageIds.delete(first)
        }
      }

      // Skip bot messages
      if (sender.sender_type === 'bot') return

      const senderObj = (sender.sender_id || {}) as Record<string, unknown>
      const senderId = (senderObj.open_id as string) || 'unknown'

      // Group policy check
      if (chatType === 'group' && !this._isGroupMessageForBot(message)) {
        return
      }

      // Add processing reaction
      let reactionId: string | null = null
      if (messageId) {
        reactionId = await this._addReaction(messageId, this.reactEmoji)
      }

      // Parse content
      const contentParts: string[] = []
      const mediaPaths: string[] = []

      let contentJson: Record<string, unknown> = {}
      try {
        contentJson = message.content ? JSON.parse(message.content as string) : {}
      } catch { /* ignore */ }

      if (msgType === 'text') {
        let text = (contentJson.text as string) || ''
        if (text) {
          const mentions = message.mentions as unknown[]
          text = this._resolveMentions(text, mentions)
          contentParts.push(text)
        }
      } else if (msgType === 'post') {
        const { text, images } = extractPostContent(contentJson)
        if (text) contentParts.push(text)
        for (const imgKey of images) {
          const result = await this._downloadAndSaveMedia('image', { image_key: imgKey }, messageId)
          if (result.path) mediaPaths.push(result.path)
          contentParts.push(result.text)
        }
      } else if (msgType === 'image' || msgType === 'audio' || msgType === 'file' || msgType === 'media') {
        const result = await this._downloadAndSaveMedia(msgType, contentJson, messageId)
        if (result.path) mediaPaths.push(result.path)
        if (msgType === 'audio' && result.path) {
          const transcription = await this._transcribeAudio(result.path)
          if (transcription) {
            contentParts.push(`[transcription: ${transcription}]`)
          } else {
            contentParts.push(result.text)
          }
        } else {
          contentParts.push(result.text)
        }
      } else if (['share_chat', 'share_user', 'interactive', 'share_calendar_event', 'system', 'merge_forward'].includes(msgType)) {
        const text = extractShareCardContent(contentJson, msgType)
        if (text) contentParts.push(text)
      } else {
        contentParts.push(MSG_TYPE_MAP[msgType] || `[${msgType}]`)
      }

      // Reply context
      const parentId = (message.parent_id as string) || null
      const rootId = (message.root_id as string) || null
      const threadId = (message.thread_id as string) || null

      if (parentId && this._client) {
        const replyCtx = await this._getMessageContent(parentId)
        if (replyCtx) contentParts.unshift(replyCtx)
      }

      const content = contentParts.join('\n')
      if (!content && !mediaPaths.length) return

      // Forward to message handler
      const replyTo = chatType === 'group' ? chatId : senderId
      if (this.onMessage) {
        const inbound = new InboundMessage({
          channel: 'feishu',
          senderId,
          chatId: replyTo,
          content,
          metadata: {
            message_id: messageId,
            reaction_id: reactionId,
            chat_type: chatType,
            msg_type: msgType,
            parent_id: parentId,
            root_id: rootId,
            thread_id: threadId,
          },
        })
        try {
          const response = await this.onMessage(inbound)
          if (response) {
            // Attach reaction metadata for cleanup in send
            response.metadata = {
              ...(response.metadata || {}),
              message_id: messageId,
              reaction_id: reactionId,
            }
            await this.send(response)
          }
        } catch (e) {
          console.error('[Feishu] Error handling message:', e)
        }
      }
    } catch (e) {
      console.error('[Feishu] Error processing message:', e)
    }
  }

  // ---- @mention resolution ----

  private _resolveMentions(text: string, mentions: unknown[] | null | undefined): string {
    if (!mentions || !text) return text
    for (const mention of mentions) {
      const m = mention as Record<string, unknown>
      const key = m.key as string
      if (!key || !text.includes(key)) continue
      const id = m.id as Record<string, unknown> | undefined
      if (!id) continue
      const openId = id.open_id as string
      const userId = id.user_id as string
      const name = (m.name as string) || key
      let replacement: string
      if (openId && userId) replacement = `@${name} (${openId}, user id: ${userId})`
      else if (openId) replacement = `@${name} (${openId})`
      else replacement = `@${name}`
      text = text.replace(key, replacement)
    }
    return text
  }

  private _isBotMentioned(message: Record<string, unknown>): boolean {
    const rawContent = (message.content as string) || ''
    if (rawContent.includes('@_all')) return true
    const mentions = message.mentions as Record<string, unknown>[] | undefined
    if (!mentions) return false
    for (const mention of mentions) {
      const id = mention.id as Record<string, unknown> | undefined
      if (!id) continue
      const openId = (id.open_id as string) || ''
      if (this._botOpenId) {
        if (openId === this._botOpenId) return true
      } else {
        if (!id.user_id && openId.startsWith('ou_')) return true
      }
    }
    return false
  }

  private _isGroupMessageForBot(message: Record<string, unknown>): boolean {
    if (this.config.groupPolicy === 'open') return true
    return this._isBotMentioned(message)
  }

  // ---- Emoji reactions ----

  private async _addReaction(messageId: string, emojiType: string): Promise<string | null> {
    if (!this._client) return null
    try {
      const client = this._client as any
      const res = await client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
      if ((res as any).code === 0) {
        return (res as any).data?.reaction_id || null
      }
      return null
    } catch (e) {
      console.warn('[Feishu] Error adding reaction:', e)
      return null
    }
  }

  private async _removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!this._client || !reactionId) return
    try {
      const client = this._client as any
      await client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
    } catch (e) {
      // ignore — reaction may already be removed
    }
  }

  // ---- Media download ----

  private async _downloadAndSaveMedia(
    msgType: string,
    contentJson: Record<string, unknown>,
    messageId: string | null,
  ): Promise<{ path: string | null; text: string }> {
    const mediaDir = this._getMediaDir()
    mkdirSync(mediaDir, { recursive: true })

    const client = this._client as any
    if (!client || !messageId) {
      return { path: null, text: MSG_TYPE_MAP[msgType] || `[${msgType}]` }
    }

    try {
      if (msgType === 'image') {
        const imageKey = contentJson.image_key as string
        if (!imageKey) return { path: null, text: '[image: missing key]' }
        const res = await client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: imageKey },
          params: { type: 'image' },
        })
        if (res.code === 0 && res.data) {
          const data = res.data as any
          const filename = data.file_name || `${imageKey.slice(0, 16)}.jpg`
          const filePath = path.join(mediaDir, filename)
          const buf = typeof data === 'object' && data.file ? data.file : data
          Bun.write(filePath, buf instanceof Uint8Array ? buf : new Uint8Array(buf))
          return { path: filePath, text: `[image: ${filename}]` }
        }
        return { path: null, text: '[image: download failed]' }
      }

      const fileKey = contentJson.file_key as string
      if (!fileKey) return { path: null, text: `[${msgType}: missing file_key]` }

      const resourceType = msgType === 'audio' || msgType === 'media' ? 'file' : 'file'
      const res = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: resourceType },
      })
      if (res.code === 0 && res.data) {
        const data = res.data as any
        let filename = data.file_name || fileKey.slice(0, 16)
        if (msgType === 'audio' && !filename.match(/\.(opus|ogg|oga)$/i)) {
          filename = `${filename}.ogg`
        }
        const filePath = path.join(mediaDir, filename)
        const buf = typeof data === 'object' && data.file ? data.file : data
        Bun.write(filePath, buf instanceof Uint8Array ? buf : new Uint8Array(buf))
        return { path: filePath, text: `[${msgType}: ${filename}]` }
      }
      return { path: null, text: `[${msgType}: download failed]` }
    } catch (e) {
      console.warn(`[Feishu] Error downloading ${msgType}:`, e)
      return { path: null, text: `[${msgType}: download error]` }
    }
  }

  private _getMediaDir(): string {
    const base = process.env.JARVIS_WORKSPACE || path.join(os.homedir(), '.jarvis')
    return path.join(base, 'media', 'feishu')
  }

  // ---- Audio transcription ----

  private async _transcribeAudio(filePath: string): Promise<string | null> {
    try {
      const provider = process.env.TRANSCRIPTION_PROVIDER || ''
      const apiKey = process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY || ''
      if (!apiKey) return null

      const file = Bun.file(filePath)
      const formData = new FormData()
      formData.append('file', file)
      formData.append('model', 'whisper-1')
      if (provider === 'groq') formData.append('model', 'whisper-large-v3')

      const baseUrl = provider === 'groq'
        ? 'https://api.groq.com/openai/v1/audio/transcriptions'
        : 'https://api.openai.com/v1/audio/transcriptions'

      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      })
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>
        return (data.text as string) || null
      }
      return null
    } catch {
      return null
    }
  }

  // ---- Reply context ----

  private async _getMessageContent(messageId: string): Promise<string | null> {
    if (!this._client) return null
    try {
      const client = this._client as any
      const res = await client.im.v1.message.get({
        path: { message_id: messageId },
      })
      if (res.code !== 0) return null
      const items = res.data?.items
      if (!items || !items.length) return null
      const msgObj = items[0]
      const bodyContent = msgObj.body?.content
      if (!bodyContent) return null

      let contentJson: Record<string, unknown> = {}
      try { contentJson = JSON.parse(bodyContent) } catch { return null }

      const msgType = msgObj.msg_type || ''
      let text = ''
      if (msgType === 'text') {
        text = (contentJson.text as string || '').trim()
      } else if (msgType === 'post') {
        const { text: postText } = extractPostContent(contentJson)
        text = postText.trim()
      }
      if (!text) return null
      if (text.length > REPLY_CONTEXT_MAX_LEN) text = text.slice(0, REPLY_CONTEXT_MAX_LEN) + '...'
      return `[Reply to: ${text}]`
    } catch {
      return null
    }
  }

  // ---- Message sending ----

  override async send(msg: OutboundMessage): Promise<void> {
    if (!this._client) {
      console.warn('[Feishu] Client not initialized')
      return
    }
    const client = this._client as any

    const receiveIdType = msg.chatId.startsWith('oc_') ? 'chat_id' : 'open_id'
    const chatId = msg.chatId

    // Tool hint messages
    if (msg.metadata?._toolHint) {
      const hint = (msg.content || '').trim()
      if (!hint) return
      const buf = this._streamBufs.get(chatId)
      if (buf && buf.cardId) {
        await this.sendDelta(chatId, `\n\n${this._formatToolHintDelta(hint)}\n\n`)
        return
      }
      // Send as standalone card
      const card = JSON.stringify({
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: this._formatToolHintDelta(hint) }],
      })
      await this._sendMessage(client, receiveIdType, chatId, 'interactive', card)
      return
    }

    // Determine reply mode
    let replyMessageId: string | null = null
    if (this.replyToMessageFlag && !msg.metadata?._progress) {
      replyMessageId = (msg.metadata?.message_id as string) || null
    } else if (msg.metadata?.thread_id) {
      replyMessageId = (msg.metadata?.root_id || msg.metadata?.message_id) as string || null
    }

    let isFirstSend = true

    const doSend = async (mType: string, content: string): Promise<void> => {
      if (replyMessageId && isFirstSend) {
        isFirstSend = false
        const ok = await this._replyMessage(client, replyMessageId, mType, content)
        if (ok) return
      }
      await this._sendMessage(client, receiveIdType, chatId, mType, content)
    }

    // Send media files
    for (const filePath of msg.media || []) {
      if (!existsSync(filePath)) {
        console.warn(`[Feishu] Media file not found: ${filePath}`)
        continue
      }
      const ext = path.extname(filePath).toLowerCase()
      if (IMAGE_EXTS.has(ext)) {
        const key = await this._uploadImage(client, filePath)
        if (key) await doSend('image', JSON.stringify({ image_key: key }))
      } else {
        const key = await this._uploadFile(client, filePath)
        if (key) {
          let mediaType: string
          if (AUDIO_EXTS.has(ext)) mediaType = 'audio'
          else if (VIDEO_EXTS.has(ext)) mediaType = 'media'
          else mediaType = 'file'
          await doSend(mediaType, JSON.stringify({ file_key: key }))
        }
      }
    }

    // Send text content
    if (msg.content && msg.content.trim()) {
      const fmt = detectMsgFormat(msg.content)
      if (fmt === 'text') {
        await doSend('text', JSON.stringify({ text: msg.content.trim() }))
      } else if (fmt === 'post') {
        await doSend('post', markdownToPost(msg.content))
      } else {
        const elements = buildCardElements(msg.content)
        for (const chunk of splitElementsByTableLimit(elements)) {
          const card = JSON.stringify({ config: { wide_screen_mode: true }, elements: chunk })
          await doSend('interactive', card)
        }
      }
    }
  }

  // ---- sendDelta (CardKit streaming) ----

  override async sendDelta(chatId: string, delta: string, metadata?: Record<string, unknown>): Promise<void> {
    if (!this._client) return
    const client = this._client as any
    const meta = metadata || {}
    const ridType = chatId.startsWith('oc_') ? 'chat_id' : 'open_id'

    // Stream end
    if (meta._streamEnd) {
      const messageId = meta.message_id as string | undefined
      const reactionId = meta.reaction_id as string | undefined
      if (messageId && reactionId) {
        await this._removeReaction(messageId, reactionId)
        if (this.doneEmoji && messageId) {
          await this._addReaction(messageId, this.doneEmoji)
        }
      }

      const buf = this._streamBufs.get(chatId)
      if (!buf || !buf.text) return

      if (buf.cardId) {
        buf.sequence++
        const ok = await this._streamUpdateText(client, buf.cardId, buf.text, buf.sequence)
        if (ok) {
          buf.sequence++
          await this._closeStreamingMode(client, buf.cardId, buf.sequence)
          this._streamBufs.delete(chatId)
          return
        }
        console.warn(`[Feishu] Streaming card ${buf.cardId} final update failed, falling back`)
      }

      // Fallback: send as regular interactive card
      for (const chunk of splitElementsByTableLimit(buildCardElements(buf.text))) {
        const card = JSON.stringify({ config: { wide_screen_mode: true }, elements: chunk })
        await this._sendMessage(client, ridType, chatId, 'interactive', card)
      }
      this._streamBufs.delete(chatId)
      return
    }

    // Accumulate delta
    let buf = this._streamBufs.get(chatId)
    if (!buf) {
      buf = { text: '', cardId: null, sequence: 0, lastEdit: 0 }
      this._streamBufs.set(chatId, buf)
    }
    buf.text += delta
    if (!buf.text.trim()) return

    const now = Date.now()
    if (!buf.cardId) {
      const cardId = await this._createStreamingCard(client, ridType, chatId)
      if (cardId) {
        buf.cardId = cardId
        buf.sequence = 1
        await this._streamUpdateText(client, cardId, buf.text, 1)
        buf.lastEdit = now
      }
    } else if (now - buf.lastEdit >= STREAM_EDIT_INTERVAL_MS) {
      buf.sequence++
      await this._streamUpdateText(client, buf.cardId, buf.text, buf.sequence)
      buf.lastEdit = now
    }
  }

  // ---- Internal: message sending helpers ----

  private async _sendMessage(
    client: any,
    receiveIdType: string,
    receiveId: string,
    msgType: string,
    content: string,
  ): Promise<string | null> {
    try {
      const res = await client.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, msg_type: msgType, content },
      })
      if (res.code !== 0) {
        console.error(`[Feishu] Send failed: code=${res.code}, msg=${res.msg}`)
        return null
      }
      return res.data?.message_id || null
    } catch (e) {
      console.error(`[Feishu] Error sending ${msgType}:`, e)
      return null
    }
  }

  private async _replyMessage(
    client: any,
    parentMessageId: string,
    msgType: string,
    content: string,
  ): Promise<boolean> {
    try {
      const res = await client.im.v1.message.reply({
        path: { message_id: parentMessageId },
        data: { msg_type: msgType, content },
      })
      if (res.code !== 0) {
        console.error(`[Feishu] Reply failed: code=${res.code}, msg=${res.msg}`)
        return false
      }
      return true
    } catch (e) {
      console.error('[Feishu] Error replying:', e)
      return false
    }
  }

  // ---- Internal: media upload ----

  private async _uploadImage(client: any, filePath: string): Promise<string | null> {
    try {
      const file = Bun.file(filePath)
      const buf = await file.arrayBuffer()
      const res = await client.im.v1.image.create({
        data: { image_type: 'message', image: buf },
      })
      if (res.code === 0) return res.data?.image_key || null
      console.error(`[Feishu] Image upload failed: code=${res.code}, msg=${res.msg}`)
      return null
    } catch (e) {
      console.error(`[Feishu] Error uploading image ${filePath}:`, e)
      return null
    }
  }

  private async _uploadFile(client: any, filePath: string): Promise<string | null> {
    try {
      const ext = path.extname(filePath).toLowerCase()
      const fileType = FILE_TYPE_MAP[ext] || 'stream'
      const fileName = path.basename(filePath)
      const file = Bun.file(filePath)
      const buf = await file.arrayBuffer()
      const res = await client.im.v1.file.create({
        data: { file_type: fileType, file_name: fileName, file: buf },
      })
      if (res.code === 0) return res.data?.file_key || null
      console.error(`[Feishu] File upload failed: code=${res.code}, msg=${res.msg}`)
      return null
    } catch (e) {
      console.error(`[Feishu] Error uploading file ${filePath}:`, e)
      return null
    }
  }

  // ---- Internal: CardKit streaming helpers ----

  private async _createStreamingCard(client: any, ridType: string, chatId: string): Promise<string | null> {
    try {
      const cardJson = {
        schema: '2.0',
        config: { wide_screen_mode: true, update_multi: true, streaming_mode: true },
        body: {
          elements: [{ tag: 'markdown', content: '', element_id: STREAM_ELEMENT_ID }],
        },
      }
      const res = await client.cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(cardJson) },
      })
      if (res.code !== 0) {
        console.warn(`[Feishu] CardKit create failed: code=${res.code}, msg=${res.msg}`)
        return null
      }
      const cardId = res.data?.card_id
      if (cardId) {
        const sentMsgId = await this._sendMessage(
          client, ridType, chatId, 'interactive',
          JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        )
        if (sentMsgId) return cardId
      }
      return null
    } catch (e) {
      console.warn('[Feishu] Error creating streaming card:', e)
      return null
    }
  }

  private async _streamUpdateText(client: any, cardId: string, content: string, sequence: number): Promise<boolean> {
    try {
      const res = await client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: STREAM_ELEMENT_ID },
        data: { content, sequence },
      })
      if (res.code !== 0) {
        console.warn(`[Feishu] Stream update failed: code=${res.code}, msg=${res.msg}`)
        return false
      }
      return true
    } catch (e) {
      console.warn('[Feishu] Error streaming update:', e)
      return false
    }
  }

  private async _closeStreamingMode(client: any, cardId: string, sequence: number): Promise<boolean> {
    try {
      const settingsPayload = JSON.stringify({ config: { streaming_mode: false } })
      const uuid = crypto.randomUUID?.() || Math.random().toString(36).slice(2)
      const res = await client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: { settings: settingsPayload, sequence, uuid },
      })
      if (res.code !== 0) {
        console.warn(`[Feishu] Close streaming failed: code=${res.code}, msg=${res.msg}`)
        return false
      }
      return true
    } catch (e) {
      console.warn('[Feishu] Error closing streaming:', e)
      return false
    }
  }

  // ---- Tool hint formatting ----

  private _formatToolHintDelta(toolHint: string): string {
    const lines = formatToolHintLines(toolHint).split('\n')
    return lines.filter(l => l.trim()).map(l => `${this.toolHintPrefix} ${l}`).join('\n')
  }

  // ---- Token management ----

  private async _fetchTenantToken(): Promise<string | null> {
    const apiBase = this.domain === 'lark'
      ? 'https://open.larksuite.com/open-apis'
      : 'https://open.feishu.cn/open-apis'
    try {
      const res = await fetch(`${apiBase}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      })
      if (!res.ok) return null
      const data = await res.json() as Record<string, unknown>
      return (data.tenant_access_token as string) || null
    } catch {
      return null
    }
  }

  // ---- SDK availability check ----

  private async _ensureSDK(): Promise<void> {
    if (this._sdkAvailable) return
    try {
      await import('@larksuiteoapi/node-sdk')
      this._sdkAvailable = true
    } catch {
      this._sdkAvailable = false
    }
  }
}
