/**
 * SlackChannel — Slack Socket Mode channel
 *
 * Port of original Python channels/slack.py.
 * Uses fetch() for Slack Web API and WebSocket API for Socket Mode.
 * No slack_sdk dependency — implements Slack API protocol directly.
 */

import { BaseChannel, type ChannelConfig } from './base'
import { InboundMessage, type OutboundMessage } from '../bus'

// ---- Config ----

export interface SlackDMConfig {
  enabled: boolean
  policy: 'open' | 'allowlist'
  allowFrom: string[]
}

export interface SlackConfig extends ChannelConfig {
  mode: 'socket'
  botToken: string
  appToken: string
  userTokenReadOnly: boolean
  replyInThread: boolean
  reactEmoji: string
  doneEmoji: string
  groupPolicy: 'open' | 'mention' | 'allowlist'
  groupAllowFrom: string[]
  dm: SlackDMConfig
}

// ---- Constants ----

const SLACK_API = 'https://slack.com/api'
const RECONNECT_DELAY_MS = 5_000
const LIST_PAGE_SIZE = 200
const SLACK_ID_RE = /^[CDGUW][A-Z0-9]{2,}$/
const SLACK_CHANNEL_REF_RE = /^<#([A-Z0-9]+)(?:\|[^>]+)?>$/
const SLACK_USER_REF_RE = /^<@([A-Z0-9]+)(?:\|[^>]+)?>$/
const TABLE_RE = /^\|.*\|$(?:\n\|[\s:|-]*\|$)(?:\n\|.*\|$)*/m
const CODE_FENCE_RE = /```[\s\S]*?```/
const INLINE_CODE_RE = /`[^`]+`/
const LEFTOVER_BOLD_RE = /\*\*(.+?)\*\*/
const LEFTOVER_HEADER_RE = /^#{1,6}\s+(.+)$/m
const BARE_URL_RE = /(?<![|<])(https?:\/\/\S+)/g

// ---- Channel ----

export class SlackChannel extends BaseChannel {
  override readonly name = 'slack'
  private cfg: SlackConfig
  private botToken: string
  private appToken: string
  private botUserId: string | null = null
  private ws: WebSocket | null = null
  private targetCache = new Map<string, string>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private manualStop = false

  /** Callback for incoming messages — wired up by the agent loop */
  onMessage: ((msg: InboundMessage) => Promise<OutboundMessage | null>) | null = null

  constructor(config: SlackConfig) {
    super('slack', config)
    this.cfg = config
    this.botToken = config.botToken
    this.appToken = config.appToken
  }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  async start(): Promise<void> {
    if (!this.botToken || !this.appToken) {
      console.warn('[Slack] botToken or appToken not configured')
      return
    }
    if (this.cfg.mode !== 'socket') {
      console.warn(`[Slack] Unsupported mode: ${this.cfg.mode}`)
      return
    }

    this.running = true
    this.manualStop = false

    // Resolve bot user ID
    try {
      const auth = await this._slackApi('auth.test', {})
      this.botUserId = (auth as any).user_id ?? null
      console.log(`[Slack] Bot connected as ${this.botUserId}`)
    } catch (e) {
      console.warn(`[Slack] auth.test failed: ${e}`)
    }

    await this._connectSocket()
  }

  async stop(): Promise<void> {
    this.manualStop = true
    this.running = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this._closeSocket()
    console.log('[Slack] Stopped')
  }

  // ========================================================================
  // Socket Mode WebSocket
  // ========================================================================

  private async _connectSocket(): Promise<void> {
    try {
      const resp = await this._callApi('apps.connections.open', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.appToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      })
      const data = (await resp.json()) as Record<string, unknown>
      if (!data.ok) throw new Error(`apps.connections.open failed: ${data.error ?? 'unknown'}`)
      const url = data.url as string
      if (!url) throw new Error('No WebSocket URL returned')

      this._connectWs(url)
    } catch (e) {
      console.error(`[Slack] Socket connect failed: ${e}`)
      this._scheduleReconnect()
    }
  }

  private _connectWs(url: string): void {
    this._closeSocket()

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      console.log('[Slack] Socket Mode connected')
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data as string)
        this._handleEnvelope(envelope)
      } catch (e) {
        console.warn('[Slack] Failed to parse envelope:', e)
      }
    }

    ws.onclose = (event: CloseEvent) => {
      console.log(`[Slack] Socket closed (code=${event.code})`)
      this.ws = null
      if (!this.manualStop) {
        this._scheduleReconnect()
      }
    }

    ws.onerror = () => {
      // onclose fires after onerror, so reconnect is scheduled there
    }
  }

  private _closeSocket(): void {
    if (this.ws) {
      try {
        this.ws.onclose = null // prevent reconnect trigger
        this.ws.close()
      } catch { /* ignore */ }
      this.ws = null
    }
  }

  private _scheduleReconnect(): void {
    if (this.manualStop || !this.running) return
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this._connectSocket()
    }, RECONNECT_DELAY_MS)
  }

  private _handleEnvelope(envelope: Record<string, unknown>): void {
    const type = envelope.type as string
    const envelopeId = envelope.envelope_id as string

    // Acknowledge every envelope
    if (envelopeId && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ envelope_id: envelopeId }))
    }

    if (type === 'hello') {
      // Connection established, server may send capabilities
      return
    }

    if (type === 'disconnect') {
      console.log('[Slack] Server requested disconnect')
      this._closeSocket()
      if (!this.manualStop) this._scheduleReconnect()
      return
    }

    if (type !== 'events_api') return

    const payload = (envelope.payload as Record<string, unknown>) ?? {}
    const event = (payload.event as Record<string, unknown>) ?? {}
    const eventType = event.type as string | undefined

    if (eventType !== 'message' && eventType !== 'app_mention') return

    this._handleEvent(payload, event).catch((e) => {
      console.error('[Slack] Event handling error:', e)
    })
  }

  // ========================================================================
  // Event handling
  // ========================================================================

  private async _handleEvent(
    payload: Record<string, unknown>,
    event: Record<string, unknown>,
  ): Promise<void> {
    const senderId = event.user as string | undefined
    const chatId = event.channel as string | undefined

    // Ignore bot/system messages (any subtype = not a normal user message)
    if (event.subtype) return
    if (this.botUserId && senderId === this.botUserId) return

    if (!senderId || !chatId) return

    const channelType = (event.channel_type as string) ?? ''
    const text = (event.text as string) ?? ''

    // Avoid double-processing: Slack sends both `message` and `app_mention`
    // for mentions in channels. Prefer `app_mention`.
    if (payload.event_type === 'message' && this.botUserId && text.includes(`<@${this.botUserId}>`)) {
      return
    }

    if (!this._isAllowed(senderId, chatId, channelType)) return

    if (channelType !== 'im' && !this._shouldRespondInChannel(payload.event_type as string, text, chatId)) {
      return
    }

    const cleanText = this._stripBotMention(text)

    const eventTs = event.ts as string | undefined
    let threadTs = event.thread_ts as string | undefined
    if (this.cfg.replyInThread && !threadTs) {
      threadTs = eventTs
    }

    // Add :eyes: reaction (best-effort)
    if (eventTs) {
      this._reactionsAdd(chatId, this.cfg.reactEmoji, eventTs).catch(() => {})
    }

    // Thread-scoped session key for channel/group messages
    const sessionKey = threadTs && channelType !== 'im'
      ? `slack:${chatId}:${threadTs}`
      : undefined

    if (this.onMessage) {
      const inbound = new InboundMessage({
        channel: 'slack',
        senderId,
        chatId,
        content: cleanText,
        metadata: {
          slack: {
            event,
            thread_ts: threadTs,
            channel_type: channelType,
          } satisfies SlackMetadata,
        },
        sessionKeyOverride: sessionKey,
      })
      this.onMessage(inbound).catch((err) => {
        console.error('[Slack] onMessage error:', err)
      })
    }
  }

  // ========================================================================
  // Message sending
  // ========================================================================

  async send(msg: OutboundMessage): Promise<void> {
    const targetChatId = await this._resolveTargetChatId(msg.chatId)
    const slackMeta = (msg.metadata?.slack ?? {}) as SlackMetadata | undefined
    const threadTs = slackMeta?.thread_ts
    const channelType = slackMeta?.channel_type
    const originChatId = String(slackMeta?.event?.channel ?? msg.chatId)

    // Slack DMs don't use threads; channel/group replies may keep thread_ts
    const threadTsParam =
      threadTs && channelType !== 'im' && targetChatId === originChatId
        ? threadTs
        : undefined

    // Send text (Slack rejects empty text payloads)
    if (msg.content || !msg.media?.length) {
      await this._chatPostMessage(targetChatId, msg.content, threadTsParam)
    }

    // Upload files
    if (msg.media?.length) {
      for (const mediaPath of msg.media) {
        try {
          await this._filesUpload(targetChatId, mediaPath, threadTsParam)
        } catch (e) {
          console.error(`[Slack] File upload failed: ${mediaPath}`, e)
        }
      }
    }

    // Update reaction emoji when final (non-progress) response is sent
    if (!msg.metadata?._progress) {
      const event = slackMeta?.event as Record<string, unknown> | undefined
      if (event?.ts) {
        await this._updateReactEmoji(originChatId, event.ts as string)
      }
    }
  }

  private async _chatPostMessage(
    channel: string,
    content: string,
    threadTs?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      channel,
      text: content ? this._toMrkdwn(content) : ' ',
    }
    if (threadTs) body.thread_ts = threadTs
    await this._slackApi('chat.postMessage', body)
  }

  private async _filesUpload(
    channel: string,
    filePath: string,
    threadTs?: string,
  ): Promise<void> {
    // Slack files.upload v2 requires multipart form data.
    // We use fetch with FormData (Bun supports this).
    const formData = new FormData()
    formData.append('channels', channel)
    formData.append('file', Bun.file(filePath))
    if (threadTs) formData.append('thread_ts', threadTs)

    const resp = await fetch(`${SLACK_API}/files.upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.botToken}` },
      body: formData,
    })

    if (!resp.ok) {
      const err = await resp.text().catch(() => 'unknown')
      throw new Error(`Slack files.upload error ${resp.status}: ${err}`)
    }
  }

  // ========================================================================
  // Reaction emoji lifecycle
  // ========================================================================

  private async _reactionsAdd(chatId: string, emoji: string, ts: string): Promise<void> {
    await this._slackApi('reactions.add', {
      channel: chatId,
      name: emoji,
      timestamp: ts,
    })
  }

  private async _reactionsRemove(chatId: string, emoji: string, ts: string): Promise<void> {
    await this._slackApi('reactions.remove', {
      channel: chatId,
      name: emoji,
      timestamp: ts,
    })
  }

  private async _updateReactEmoji(chatId: string, ts: string): Promise<void> {
    // Remove the in-progress reaction
    try {
      await this._reactionsRemove(chatId, this.cfg.reactEmoji, ts)
    } catch { /* best-effort */ }

    // Add done reaction
    if (this.cfg.doneEmoji) {
      try {
        await this._reactionsAdd(chatId, this.cfg.doneEmoji, ts)
      } catch { /* best-effort */ }
    }
  }

  // ========================================================================
  // Permission checking
  // ========================================================================

  private _isAllowed(senderId: string, chatId: string, channelType: string): boolean {
    if (channelType === 'im') {
      if (!this.cfg.dm.enabled) return false
      if (this.cfg.dm.policy === 'allowlist') {
        return this.cfg.dm.allowFrom.includes(senderId)
      }
      return true
    }

    // Group / channel messages
    if (this.cfg.groupPolicy === 'allowlist') {
      return this.cfg.groupAllowFrom.includes(chatId)
    }
    return true
  }

  private _shouldRespondInChannel(eventType: string, text: string, chatId: string): boolean {
    switch (this.cfg.groupPolicy) {
      case 'open':
        return true
      case 'mention':
        if (eventType === 'app_mention') return true
        return this.botUserId !== null && text.includes(`<@${this.botUserId}>`)
      case 'allowlist':
        return this.cfg.groupAllowFrom.includes(chatId)
      default:
        return false
    }
  }

  private _stripBotMention(text: string): string {
    if (!text || !this.botUserId) return text
    return text.replace(new RegExp(`<@${escapeRegex(this.botUserId)}>\\s*`, 'g'), '').trim()
  }

  // ========================================================================
  // Target resolution (channel names, user handles, DMs)
  // ========================================================================

  async _resolveTargetChatId(target: string): Promise<string> {
    const t = target.trim()
    if (!t) return t

    const channelRef = t.match(SLACK_CHANNEL_REF_RE)
    if (channelRef) return channelRef[1]!

    const userRef = t.match(SLACK_USER_REF_RE)
    if (userRef) return this._openDmForUser(userRef[1]!)

    if (SLACK_ID_RE.test(t)) {
      if (t.startsWith('U') || t.startsWith('W')) return this._openDmForUser(t)
      return t
    }

    if (t.startsWith('#')) return this._resolveChannelName(t.slice(1))
    if (t.startsWith('@')) return this._resolveUserHandle(t.slice(1))

    try {
      return await this._resolveChannelName(t)
    } catch {
      return this._resolveUserHandle(t)
    }
  }

  async _resolveChannelName(name: string): Promise<string> {
    const normalized = normalizeTarget(name)
    if (!normalized) throw new Error('Slack target channel name is empty')

    const cacheKey = `channel:${normalized}`
    const cached = this.targetCache.get(cacheKey)
    if (cached) return cached

    let cursor: string | undefined
    while (true) {
      const params: Record<string, unknown> = {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: LIST_PAGE_SIZE,
      }
      if (cursor) params.cursor = cursor

      const response = (await this._slackApi('conversations.list', params)) as Record<string, unknown>
      const channels = (response.channels as Array<Record<string, unknown>>) ?? []
      for (const ch of channels) {
        if (normalizeTarget(String(ch.name ?? '')) === normalized) {
          const channelId = String(ch.id ?? '')
          this.targetCache.set(cacheKey, channelId)
          return channelId
        }
      }
      cursor = ((response.response_metadata as Record<string, unknown>)?.next_cursor as string)?.trim() || undefined
      if (!cursor) break
    }

    throw new Error(
      `Slack channel '${name}' not found. Use a joined channel name like '#general' or a concrete channel ID.`,
    )
  }

  async _resolveUserHandle(handle: string): Promise<string> {
    const normalized = normalizeTarget(handle)
    if (!normalized) throw new Error('Slack target user handle is empty')

    const cacheKey = `user:${normalized}`
    const cached = this.targetCache.get(cacheKey)
    if (cached) return cached

    let cursor: string | undefined
    while (true) {
      const params: Record<string, unknown> = { limit: LIST_PAGE_SIZE }
      if (cursor) params.cursor = cursor

      const response = (await this._slackApi('users.list', params)) as Record<string, unknown>
      const members = (response.members as Array<Record<string, unknown>>) ?? []
      for (const member of members) {
        if (this._memberMatchesHandle(member, normalized)) {
          const userId = String(member.id ?? '')
          if (!userId) continue
          const dmId = await this._openDmForUser(userId)
          this.targetCache.set(cacheKey, dmId)
          return dmId
        }
      }
      cursor = ((response.response_metadata as Record<string, unknown>)?.next_cursor as string)?.trim() || undefined
      if (!cursor) break
    }

    throw new Error(
      `Slack user '${handle}' not found. Use '@name' or a concrete DM/channel ID.`,
    )
  }

  async _openDmForUser(userId: string): Promise<string> {
    const response = (await this._slackApi('conversations.open', {
      users: userId,
    })) as Record<string, unknown>
    const channel = (response.channel as Record<string, unknown>) ?? {}
    const channelId = String(channel.id ?? '')
    if (!channelId) throw new Error(`Slack DM target for user '${userId}' could not be opened.`)
    return channelId
  }

  private _memberMatchesHandle(member: Record<string, unknown>, normalized: string): boolean {
    const profile = (member.profile as Record<string, unknown>) ?? {}
    const candidates = [
      String(member.name ?? ''),
      String(profile.display_name ?? ''),
      String(profile.display_name_normalized ?? ''),
      String(profile.real_name ?? ''),
      String(profile.real_name_normalized ?? ''),
    ]
    for (const candidate of candidates) {
      if (candidate && normalizeTarget(candidate) === normalized) return true
    }
    return false
  }

  // ========================================================================
  // Slack Web API helpers
  // ========================================================================

  private async _callApi(path: string, init: RequestInit): Promise<Response> {
    const url = `${SLACK_API}/${path}`
    return fetch(url, init)
  }

  private async _slackApi(method: string, body: Record<string, unknown>): Promise<unknown> {
    const resp = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      throw new Error(`Slack API ${method} error ${resp.status}`)
    }

    const data = (await resp.json()) as Record<string, unknown>
    if (!data.ok) {
      throw new Error(`Slack API ${method} error: ${String(data.error ?? 'unknown')}`)
    }

    return data
  }

  // ========================================================================
  // Markdown → Slack mrkdwn conversion
  // ========================================================================

  private _toMrkdwn(text: string): string {
    if (!text) return ''
    text = text.replace(TABLE_RE, (match) => this._convertTable(match))
    return this._fixupMrkdwn(this._basicMrkdwn(text))
  }

  private _basicMrkdwn(text: string): string {
    // Bold: **text** → *text*
    text = text.replace(/\*\*(.+?)\*\*/g, '*$1*')
    // Italic: *text* → _text_ (careful not to conflict with bold markers that were just converted)
    text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '_$1_')
    // Strikethrough: ~~text~~ → ~text~
    text = text.replace(/~~(.+?)~~/g, '~$1~')
    // Inline code: preserve as-is
    // Links: [text](url) → <url|text>
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    // Headers: ### text → *text*
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    // Unordered list: - text → • text
    text = text.replace(/^- (.+)$/gm, '\u2022 $1')
    // Ordered list: 1. text → 1. text (keep as-is)
    // Bare URLs: wrap in <>
    text = text.replace(BARE_URL_RE, '<$1>')
    return text
  }

  private _fixupMrkdwn(text: string): string {
    // Save code blocks and inline code from fixups
    const saved: string[] = []

    text = text.replace(CODE_FENCE_RE, (m) => {
      saved.push(m)
      return `\x00CB${saved.length - 1}\x00`
    })

    text = text.replace(INLINE_CODE_RE, (m) => {
      saved.push(m)
      return `\x00CB${saved.length - 1}\x00`
    })

    // Fix leftover bold/header artifacts
    text = text.replace(LEFTOVER_BOLD_RE, '*$1*')
    text = text.replace(LEFTOVER_HEADER_RE, '*$1*')

    // Restore saved code blocks
    for (let i = 0; i < saved.length; i++) {
      text = text.replace(`\x00CB${i}\x00`, saved[i]!)
    }

    return text
  }

  private _convertTable(match: string): string {
    const lines = match
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)

    if (lines.length < 2) return match

    const headers = lines[0]!.replace(/^\||\|$/g, '').split('|').map((h) => h.trim())
    const separatorLine = lines[1] ?? ''
    const start = /^[\s|:\-]+$/.test(separatorLine) ? 2 : 1

    const rows: string[] = []
    for (let i = start; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const parts: string[] = []
      for (let j = 0; j < headers.length; j++) {
        const val = cells[j] ?? ''
        if (val) {
          parts.push(`*${headers[j]}*: ${val}`)
        }
      }
      if (parts.length > 0) {
        rows.push(parts.join(' \u00B7 '))
      }
    }

    return rows.join('\n')
  }
}

// ---- Helpers ----

interface SlackMetadata {
  event: Record<string, unknown>
  thread_ts?: string
  channel_type?: string
}

function normalizeTarget(value: string): string {
  return value.trim().replace(/^[#@]/, '').toLowerCase()
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
