/**
 * WebSocketChannel — WebSocket server channel
 *
 * Port of nanobot/channels/websocket.py.
 * Bun.serve dual HTTP + WebSocket server with:
 * - Token-based auth (issued single-use + API multi-use tokens)
 * - Envelope protocol (new_chat / attach / message typed frames)
 * - Subscription fan-out model (chat_id -> connections)
 * - Signed media URLs via HMAC-SHA256
 * - Session REST API for embedded webui
 * - Static SPA serving
 * - Streaming via sendDelta
 */

import { BaseChannel, type ChannelConfig } from './base'
import { InboundMessage, type OutboundMessage } from '../bus'
import { getMediaDir } from '../config/paths'
import { saveBase64DataUrl } from '../utils/media_decode'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync, copyFileSync, existsSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import type { Server, ServerWebSocket } from 'bun'
import type { SessionStore, Session } from '../agent/session'

// ========================================================================
// Config
// ========================================================================

export interface WebSocketConfig extends ChannelConfig {
  host: string
  port: number
  path: string
  token: string
  tokenIssuePath: string
  tokenIssueSecret: string
  tokenTtlS: number
  websocketRequiresToken: boolean
  streaming: boolean
  maxMessageBytes: number
  pingIntervalS: number
  pingTimeoutS: number
  sslCertfile: string
  sslKeyfile: string
}

// ========================================================================
// Constants
// ========================================================================

const MAX_IMAGES_PER_MESSAGE = 4
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_VIDEOS_PER_MESSAGE = 1
const MAX_VIDEO_BYTES = 20 * 1024 * 1024

const IMAGE_MIME_ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const VIDEO_MIME_ALLOWED = new Set(['video/mp4', 'video/webm', 'video/quicktime'])
const UPLOAD_MIME_ALLOWED = new Set([...IMAGE_MIME_ALLOWED, ...VIDEO_MIME_ALLOWED])

const MEDIA_ALLOWED_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
])

const LOCALHOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const MAX_ISSUED_TOKENS = 10_000
const CHAT_ID_RE = /^[A-Za-z0-9_:-]{1,64}$/
const API_KEY_RE = /^[A-Za-z0-9_:.-]{1,128}$/
const DATA_URL_MIME_RE = /^data:([^;]+);base64,/
// ========================================================================
// Helpers
// ========================================================================

function stripTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1)
  return path || '/'
}

function normalizePath(path: string): string {
  return stripTrailingSlash(path)
}

function isWsUpgrade(req: Request): boolean {
  const upgrade = req.headers.get('Upgrade')?.toLowerCase()
  const connection = req.headers.get('Connection')?.toLowerCase()
  if (!upgrade || upgrade !== 'websocket') return false
  if (!connection || !connection.includes('upgrade')) return false
  return true
}

function isLocalhost(server: { requestIP: (req: Request) => { address: string } | null }, req: Request): boolean {
  try {
    const ip = server.requestIP(req)
    if (!ip) return false
    let host = ip.address
    if (host.startsWith('::ffff:')) host = host.slice(7)
    return LOCALHOSTS.has(host)
  } catch {
    const host = req.headers.get('Host')?.split(':')[0]
    return host ? LOCALHOSTS.has(host) : false
  }
}

function isValidChatId(value: unknown): boolean {
  return typeof value === 'string' && CHAT_ID_RE.test(value)
}

function decodeApiKey(raw: string): string | null {
  const key = decodeURIComponent(raw)
  return API_KEY_RE.test(key) ? key : null
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function mimeTypeFromExt(filename: string): string {
  const ext = extname(filename).toLowerCase()
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml',
  }
  return map[ext] || 'application/octet-stream'
}

function extractDataUrlMime(url: string): string | null {
  if (typeof url !== 'string') return null
  const m = DATA_URL_MIME_RE.exec(url)
  return m ? m[1]!.trim().toLowerCase() || null : null
}

/** Connection metadata passed through Bun.serve upgrade data. */
interface WsConnData {
  clientId: string
  defaultChatId: string
  remoteAddr: string | null
}

// ========================================================================
// Channel
// ========================================================================

export class WebSocketChannel extends BaseChannel {
  override readonly name = 'websocket'

  // Config
  private cfg: WebSocketConfig

  // Subscription system
  private _subs = new Map<string, Set<ServerWebSocket<WsConnData>>>()
  private _connChats = new Map<ServerWebSocket<WsConnData>, Set<string>>()
  private _connDefault = new Map<ServerWebSocket<WsConnData>, string>()

  // Token pools
  private _issuedTokens = new Map<string, number>() // token -> monotonic expiry
  private _apiTokens = new Map<string, number>()     // token -> monotonic expiry

  // Media signing secret
  private _mediaSecret = randomBytes(32)

  // Server ref
  private _server: ReturnType<typeof Bun.serve<WsConnData>> | null = null
  private _pingTimer: Timer | null = null

  // External dependencies
  private _sessionManager: SessionStore | null = null
  private _staticDistPath: string | null = null

  onMessage: ((msg: InboundMessage) => Promise<OutboundMessage | null>) | null = null

  constructor(
    config: WebSocketConfig & Record<string, unknown>,
    sessionManager?: SessionStore | null,
    staticDistPath?: string | null,
  ) {
    super('websocket', config)
    this.cfg = {
      enabled: config.enabled ?? false,
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 8765,
      path: normalizePath(config.path ?? '/'),
      token: config.token ?? '',
      tokenIssuePath: config.tokenIssuePath?.trim() ?? '',
      tokenIssueSecret: config.tokenIssueSecret ?? '',
      tokenTtlS: config.tokenTtlS ?? 300,
      websocketRequiresToken: config.websocketRequiresToken ?? true,
      streaming: config.streaming ?? true,
      maxMessageBytes: config.maxMessageBytes ?? 37_748_736,
      pingIntervalS: config.pingIntervalS ?? 20,
      pingTimeoutS: config.pingTimeoutS ?? 20,
      sslCertfile: config.sslCertfile ?? '',
      sslKeyfile: config.sslKeyfile ?? '',
    }
    if (sessionManager) this._sessionManager = sessionManager
    if (staticDistPath) this._staticDistPath = resolve(staticDistPath)
  }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  async start(): Promise<void> {
    if (!this.cfg.enabled) {
      console.warn('[WebSocket] Channel not enabled')
      return
    }

    this.running = true

    const tls = this._buildTls()

    this._server = Bun.serve<WsConnData>({
      hostname: this.cfg.host,
      port: this.cfg.port,
      tls: tls ? { certFile: tls.cert, keyFile: tls.key } : undefined,
      websocket: {
        maxPayloadLength: this.cfg.maxMessageBytes,
        backpressureLimit: 1024 * 1024,
        open: (ws) => this._onOpen(ws),
        message: (ws, data) => this._onMessage(ws, data),
        close: (ws) => this._onClose(ws),
        drain: (_ws) => { /* backpressure handled by Bun */ },
      },
      fetch: (req, server) => this._fetch(req, server),
    })

    const scheme = tls ? 'wss' : 'ws'
    console.log(`[WebSocket] Server listening on ${scheme}://${this.cfg.host}:${this.cfg.port}${this.cfg.path}`)
    if (this.cfg.tokenIssuePath) {
      console.log(`[WebSocket] Token issue route: ${scheme}://${this.cfg.host}:${this.cfg.port}${normalizePath(this.cfg.tokenIssuePath)}`)
    }

    // Periodic ping
    if (this.cfg.pingIntervalS > 0) {
      this._pingTimer = setInterval(() => {
        for (const [ws] of this._connChats) {
          try { ws.ping() } catch { /* connection may be closed */ }
        }
      }, this.cfg.pingIntervalS * 1000)
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false

    if (this._pingTimer) {
      clearInterval(this._pingTimer)
      this._pingTimer = null
    }

    if (this._server) {
      this._server.stop()
      this._server = null
    }

    this._subs.clear()
    this._connChats.clear()
    this._connDefault.clear()
    this._issuedTokens.clear()
    this._apiTokens.clear()
    console.log('[WebSocket] Stopped')
  }

  private _buildTls(): { cert: string; key: string } | null {
    const cert = this.cfg.sslCertfile.trim()
    const key = this.cfg.sslKeyfile.trim()
    if (!cert && !key) return null
    if (!cert || !key) {
      console.warn('[WebSocket] ssl_certfile and ssl_keyfile must both be set for WSS, or both left empty')
      return null
    }
    return { cert, key }
  }

  // ========================================================================
  // Subscription management
  // ========================================================================

  private _attach(ws: ServerWebSocket<WsConnData>, chatId: string): void {
    if (!this._subs.has(chatId)) this._subs.set(chatId, new Set())
    this._subs.get(chatId)!.add(ws)
    if (!this._connChats.has(ws)) this._connChats.set(ws, new Set())
    this._connChats.get(ws)!.add(chatId)
  }

  private _cleanupConnection(ws: ServerWebSocket<WsConnData>): void {
    const chatIds = this._connChats.get(ws)
    if (chatIds) {
      for (const cid of chatIds) {
        const subs = this._subs.get(cid)
        if (subs) {
          subs.delete(ws)
          if (subs.size === 0) this._subs.delete(cid)
        }
      }
    }
    this._connChats.delete(ws)
    this._connDefault.delete(ws)
  }

  private async _sendEvent(ws: ServerWebSocket<WsConnData>, event: string, fields?: Record<string, unknown>): Promise<void> {
    const payload: Record<string, unknown> = { event, ...fields }
    const raw = JSON.stringify(payload)
    try {
      if (ws.readyState === 1) ws.send(raw)
    } catch {
      this._cleanupConnection(ws)
    }
  }

  // ========================================================================
  // Token management
  // ========================================================================

  private _purgeExpiredIssuedTokens(): void {
    const now = Date.now()
    for (const [key, expiry] of this._issuedTokens) {
      if (now > expiry) this._issuedTokens.delete(key)
    }
  }

  private _purgeExpiredApiTokens(): void {
    const now = Date.now()
    for (const [key, expiry] of this._apiTokens) {
      if (now > expiry) this._apiTokens.delete(key)
    }
  }

  private _takeIssuedTokenIfValid(tokenValue: string | null): boolean {
    if (!tokenValue) return false
    this._purgeExpiredIssuedTokens()
    const expiry = this._issuedTokens.get(tokenValue)
    if (expiry === undefined) return false
    this._issuedTokens.delete(tokenValue)
    return Date.now() <= expiry
  }

  private _bearerToken(req: Request): string | null {
    const auth = req.headers.get('Authorization') || req.headers.get('authorization')
    if (auth && auth.toLowerCase().startsWith('bearer ')) {
      return auth.slice(7).trim() || null
    }
    return null
  }

  private _issueRouteSecretMatches(req: Request): boolean {
    const secret = this.cfg.tokenIssueSecret.trim()
    if (!secret) return true
    const bearer = this._bearerToken(req)
    if (bearer) {
      try { return createHmac('sha256', secret).update(bearer).digest().length === 32 } catch { /* fall through */ }
      return bearer === secret
    }
    const headerToken = req.headers.get('X-Nanobot-Auth') || req.headers.get('x-nanobot-auth')
    return headerToken?.trim() === secret
  }

  private _checkApiToken(req: Request): boolean {
    this._purgeExpiredApiTokens()
    const token = this._bearerToken(req) || new URL(req.url).searchParams.get('token')
    if (!token) return false
    const expiry = this._apiTokens.get(token)
    if (expiry === undefined || Date.now() > expiry) {
      this._apiTokens.delete(token)
      return false
    }
    return true
  }

  private _authorizeHandshake(url: URL): boolean {
    const supplied = url.searchParams.get('token')
    const staticToken = this.cfg.token.trim()

    if (staticToken) {
      if (supplied && staticToken && supplied === staticToken) return true
      if (supplied && this._takeIssuedTokenIfValid(supplied)) return true
      return false
    }

    if (this.cfg.websocketRequiresToken) {
      if (supplied && this._takeIssuedTokenIfValid(supplied)) return true
      return false
    }

    if (supplied) this._takeIssuedTokenIfValid(supplied)
    return true
  }

  // ========================================================================
  // HTTP dispatch
  // ========================================================================

  private _fetch(req: Request, server: Server<WsConnData>): Response | undefined {
    const url = new URL(req.url)
    const got = stripTrailingSlash(url.pathname)

    // Only accept GET
    if (req.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    // 1. Token issue endpoint
    if (this.cfg.tokenIssuePath) {
      const issueExpected = normalizePath(this.cfg.tokenIssuePath)
      if (got === issueExpected) {
        return this._handleTokenIssue(req)
      }
    }

    // 2. WebUI bootstrap (localhost-only)
    if (got === '/webui/bootstrap') {
      return this._handleWebUIBootstrap(server, req)
    }

    // 3. REST API surface
    if (got === '/api/sessions') {
      return this._handleSessionsList(req)
    }

    const msgMatch = got.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (msgMatch) return this._handleSessionMessages(req, msgMatch[1]!)

    const delMatch = got.match(/^\/api\/sessions\/([^/]+)\/delete$/)
    if (delMatch) return this._handleSessionDelete(req, delMatch[1]!)

    const mediaMatch = got.match(/^\/api\/media\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/)
    if (mediaMatch) return this._handleMediaFetch(mediaMatch[1]!, mediaMatch[2]!)

    // 4. WebSocket upgrade
    const expectedWs = normalizePath(this.cfg.path)
    if (got === expectedWs && isWsUpgrade(req)) {
      const clientId = (url.searchParams.get('client_id') || '').slice(0, 128)
      const remoteAddr = this._getRemoteAddr(server, req)
      if (!this.isAllowed(clientId || '*')) {
        return new Response('Forbidden', { status: 403 })
      }
      if (!this._authorizeHandshake(url)) {
        return new Response('Unauthorized', { status: 401 })
      }
      const defaultChatId = crypto.randomUUID()
      const upgraded = server.upgrade(req, {
        data: {
          clientId: clientId || `anon-${crypto.randomUUID().slice(0, 12)}`,
          defaultChatId,
          remoteAddr,
        },
      })
      if (upgraded) return undefined
      return new Response('Upgrade failed', { status: 500 })
    }

    // 5. Static SPA serving
    if (this._staticDistPath) {
      const resp = this._serveStatic(got)
      if (resp) return resp
    }

    return new Response('Not Found', { status: 404 })
  }

  private _getRemoteAddr(server: Server<WsConnData>, req: Request): string | null {
    try {
      const ip = server.requestIP(req)
      return ip ? ip.address : null
    } catch {
      return null
    }
  }

  // ========================================================================
  // HTTP route handlers
  // ========================================================================

  private _handleTokenIssue(req: Request): Response {
    if (!this._issueRouteSecretMatches(req)) {
      return new Response('Unauthorized', { status: 401 })
    }
    if (this.cfg.tokenIssueSecret.trim() && !this.cfg.tokenIssueSecret.trim()) {
      // unused
    } else if (!this.cfg.tokenIssueSecret.trim()) {
      console.warn(
        '[WebSocket] token_issue_path is set but token_issue_secret is empty; ' +
        'any client can obtain connection tokens'
      )
    }

    this._purgeExpiredIssuedTokens()
    if (this._issuedTokens.size >= MAX_ISSUED_TOKENS) {
      return Response.json({ error: 'too many outstanding tokens' }, { status: 429 })
    }

    const tokenValue = `nbwt_${randomBytes(32).toString('base64url')}`
    this._issuedTokens.set(tokenValue, Date.now() + this.cfg.tokenTtlS * 1000)

    return Response.json({ token: tokenValue, expires_in: this.cfg.tokenTtlS })
  }

  private _handleWebUIBootstrap(server: Server<WsConnData>, req: Request): Response {
    if (!isLocalhost(server, req)) {
      return Response.json({ error: 'webui bootstrap is localhost-only' }, { status: 403 })
    }

    this._purgeExpiredIssuedTokens()
    this._purgeExpiredApiTokens()
    if (this._issuedTokens.size >= MAX_ISSUED_TOKENS || this._apiTokens.size >= MAX_ISSUED_TOKENS) {
      return Response.json({ error: 'too many outstanding tokens' }, { status: 429 })
    }

    const token = `nbwt_${randomBytes(32).toString('base64url')}`
    const expiry = Date.now() + this.cfg.tokenTtlS * 1000
    this._issuedTokens.set(token, expiry)
    this._apiTokens.set(token, expiry)

    return Response.json({
      token,
      ws_path: this.cfg.path,
      expires_in: this.cfg.tokenTtlS,
    })
  }

  private _handleSessionsList(req: Request): Response {
    if (!this._checkApiToken(req)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!this._sessionManager) {
      return Response.json({ error: 'session manager unavailable' }, { status: 503 })
    }

    const sessions = this._sessionManager.listSessions()
    // Filter to websocket-prefixed sessions only
    const cleaned = sessions
      .filter((s) => s.key.startsWith('websocket:'))
      .map((s) => ({ key: s.key, created_at: s.created_at, updated_at: s.updated_at }))

    return Response.json({ sessions: cleaned })
  }

  private _handleSessionMessages(req: Request, key: string): Response {
    if (!this._checkApiToken(req)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!this._sessionManager) {
      return Response.json({ error: 'session manager unavailable' }, { status: 503 })
    }

    const decodedKey = decodeApiKey(key)
    if (!decodedKey || !decodedKey.startsWith('websocket:')) {
      return Response.json({ error: 'session not found' }, { status: 404 })
    }

    const data = this._sessionManager.readSessionFile(decodedKey)
    if (!data) {
      return Response.json({ error: 'session not found' }, { status: 404 })
    }

    this._augmentMediaUrls(data)
    return Response.json(data)
  }

  private _handleSessionDelete(req: Request, key: string): Response {
    if (!this._checkApiToken(req)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!this._sessionManager) {
      return Response.json({ error: 'session manager unavailable' }, { status: 503 })
    }

    const decodedKey = decodeApiKey(key)
    if (!decodedKey || !decodedKey.startsWith('websocket:')) {
      return Response.json({ error: 'session not found' }, { status: 404 })
    }

    const deleted = this._sessionManager.deleteSession(decodedKey)
    return Response.json({ deleted })
  }

  // ========================================================================
  // Media fetch (HMAC-validated)
  // ========================================================================

  private _handleMediaFetch(sig: string, payload: string): Response {
    // Validate signature
    let providedMac: Buffer
    try {
      providedMac = Buffer.from(sig, 'base64url')
    } catch {
      return new Response('invalid signature', { status: 401 })
    }

    const expectedMac = createHmac('sha256', this._mediaSecret)
      .update(payload)
      .digest()
      .subarray(0, 16)

    if (providedMac.length !== expectedMac.length || !crypto.timingSafeEqual(providedMac, expectedMac)) {
      return new Response('invalid signature', { status: 401 })
    }

    // Decode payload
    let relStr: string
    try {
      relStr = Buffer.from(payload, 'base64url').toString('utf-8')
    } catch {
      return new Response('invalid payload', { status: 400 })
    }

    // Path traversal guard
    const mediaRoot = resolve(getMediaDir())
    const candidate = resolve(join(mediaRoot, relStr))
    if (!candidate.startsWith(mediaRoot)) {
      return new Response('not found', { status: 404 })
    }

    if (!existsSync(candidate)) {
      return new Response('not found', { status: 404 })
    }

    try {
      const body = readFileSync(candidate)
      let mime = mimeTypeFromExt(candidate)
      if (!MEDIA_ALLOWED_MIMES.has(mime)) {
        mime = 'application/octet-stream'
      }
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return new Response('read error', { status: 500 })
    }
  }

  // ========================================================================
  // Static SPA serving
  // ========================================================================

  private _serveStatic(requestPath: string): Response | null {
    if (!this._staticDistPath) return null

    let rel = requestPath.replace(/^\/+/, '')
    if (!rel) rel = 'index.html'

    // Reject path traversal
    if (rel.split('/').includes('..')) {
      return new Response('Forbidden', { status: 403 })
    }

    const candidate = resolve(join(this._staticDistPath, rel))
    if (!candidate.startsWith(this._staticDistPath)) {
      return new Response('Forbidden', { status: 403 })
    }

    if (!existsSync(candidate)) {
      // SPA fallback
      const index = join(this._staticDistPath, 'index.html')
      if (existsSync(index)) {
        try {
          const body = readFileSync(index)
          const cache = 'no-cache'
          return new Response(body, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': cache,
            },
          })
        } catch {
          return null
        }
      }
      return null
    }

    try {
      const body = readFileSync(candidate)
      const filename = candidate.split('/').pop() || ''
      const cache = filename === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable'
      const ctype = mimeTypeFromExt(candidate)
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': ctype,
          'Cache-Control': cache,
        },
      })
    } catch {
      return null
    }
  }

  // ========================================================================
  // WebSocket event handlers
  // ========================================================================

  private _onOpen(ws: ServerWebSocket<WsConnData>): void {
    const data = ws.data
    // Send ready event
    const readyPayload = JSON.stringify({
      event: 'ready',
      chat_id: data.defaultChatId,
      client_id: data.clientId,
    })
    ws.send(readyPayload)

    // Register connection
    this._connDefault.set(ws, data.defaultChatId)
    this._attach(ws, data.defaultChatId)
  }

  private _onMessage(ws: ServerWebSocket<WsConnData>, raw: string | Buffer): void {
    if (typeof raw !== 'string') {
      try {
        raw = new TextDecoder().decode(raw as Buffer)
      } catch {
        return // ignore binary frames
      }
    }

    // Try envelope first
    const envelope = this._parseEnvelope(raw)
    if (envelope) {
      this._dispatchEnvelope(ws, envelope)
      return
    }

    // Fallback to plain text
    const content = this._parseInboundPayload(raw)
    if (!content) return

    const data = ws.data
    const defaultChatId = this._connDefault.get(ws)
    if (!defaultChatId) return

    this._handleMessage({
      senderId: data.clientId,
      chatId: defaultChatId,
      content,
      metadata: { remote: data.remoteAddr },
    })
  }

  private _onClose(ws: ServerWebSocket<WsConnData>): void {
    this._cleanupConnection(ws)
  }

  // ========================================================================
  // Envelope handling
  // ========================================================================

  private _parseEnvelope(raw: string): Record<string, unknown> | null {
    const text = raw.trim()
    if (!text.startsWith('{')) return null
    try {
      const data = JSON.parse(text)
      if (typeof data !== 'object' || data === null) return null
      if (typeof data.type !== 'string') return null
      return data as Record<string, unknown>
    } catch {
      return null
    }
  }

  private _parseInboundPayload(raw: string): string | null {
    const text = raw.trim()
    if (!text) return null
    if (text.startsWith('{')) {
      try {
        const data = JSON.parse(text)
        if (typeof data === 'object' && data !== null) {
          for (const key of ['content', 'text', 'message']) {
            const value = (data as Record<string, unknown>)[key]
            if (typeof value === 'string' && value.trim()) return value
          }
          return null
        }
      } catch {
        return text
      }
    }
    return text
  }

  private async _dispatchEnvelope(ws: ServerWebSocket<WsConnData>, envelope: Record<string, unknown>): Promise<void> {
    const t = envelope.type as string | undefined

    if (t === 'new_chat') {
      const newId = crypto.randomUUID()
      this._attach(ws, newId)
      await this._sendEvent(ws, 'attached', { chat_id: newId })
      return
    }

    if (t === 'attach') {
      const cid = envelope.chat_id
      if (!isValidChatId(cid)) {
        await this._sendEvent(ws, 'error', { detail: 'invalid chat_id' })
        return
      }
      this._attach(ws, cid as string)
      await this._sendEvent(ws, 'attached', { chat_id: cid })
      return
    }

    if (t === 'message') {
      const cid = envelope.chat_id as string | undefined
      const content = envelope.content as string | undefined

      if (!isValidChatId(cid)) {
        await this._sendEvent(ws, 'error', { detail: 'invalid chat_id' })
        return
      }
      if (typeof content !== 'string') {
        await this._sendEvent(ws, 'error', { detail: 'missing content' })
        return
      }

      const rawMedia = envelope.media
      let mediaPaths: string[] = []
      if (rawMedia !== undefined) {
        if (!Array.isArray(rawMedia)) {
          await this._sendEvent(ws, 'error', { detail: 'image_rejected', reason: 'malformed' })
          return
        }
        const result = this._saveEnvelopeMedia(rawMedia)
        if (result.reason) {
          await this._sendEvent(ws, 'error', { detail: 'image_rejected', reason: result.reason })
          return
        }
        mediaPaths = result.paths
      }

      if (!content.trim() && mediaPaths.length === 0) {
        await this._sendEvent(ws, 'error', { detail: 'missing content' })
        return
      }

      // Auto-attach on first message
      this._attach(ws, cid as string)

      const data = ws.data
      this._handleMessage({
        senderId: data.clientId,
        chatId: cid as string,
        content,
        media: mediaPaths.length > 0 ? mediaPaths : undefined,
        metadata: { remote: data.remoteAddr },
      })
      return
    }

    await this._sendEvent(ws, 'error', { detail: `unknown type: ${t ?? '(missing)'}` })
  }

  private _handleMessage(params: {
    senderId: string
    chatId: string
    content: string
    media?: string[]
    metadata?: Record<string, unknown>
  }): void {
    if (!this.onMessage) return

    const inbound = new InboundMessage({
      channel: 'websocket',
      senderId: params.senderId,
      chatId: params.chatId,
      content: params.content,
      media: params.media ?? [],
      metadata: params.metadata ?? {},
    })

    this.onMessage(inbound).catch((err) => {
      console.error('[WebSocket] onMessage error:', err)
    })
  }

  // ========================================================================
  // Media: envelope data URL saving
  // ========================================================================

  private _saveEnvelopeMedia(media: unknown[]): { paths: string[]; reason: string | null } {
    let imageCount = 0
    let videoCount = 0

    for (const item of media) {
      const mime = (typeof item === 'object' && item !== null)
        ? extractDataUrlMime((item as Record<string, unknown>).data_url as string)
        : null
      if (mime && VIDEO_MIME_ALLOWED.has(mime)) videoCount++
      else if (mime && IMAGE_MIME_ALLOWED.has(mime)) imageCount++
    }

    if (imageCount > MAX_IMAGES_PER_MESSAGE) return { paths: [], reason: 'too_many_images' }
    if (videoCount > MAX_VIDEOS_PER_MESSAGE) return { paths: [], reason: 'too_many_videos' }

    const mediaDir = getMediaDir('websocket')
    const paths: string[] = []

    const abort = (reason: string): { paths: string[]; reason: string } => {
      for (const p of paths) {
        try { existsSync(p) } catch { /* ignore */ }
      }
      return { paths: [], reason }
    }

    for (const item of media) {
      if (typeof item !== 'object' || item === null) return abort('malformed')
      const dataUrl = (item as Record<string, unknown>).data_url
      if (typeof dataUrl !== 'string' || !dataUrl) return abort('malformed')

      const mime = extractDataUrlMime(dataUrl)
      if (!mime) return abort('decode')
      if (!UPLOAD_MIME_ALLOWED.has(mime)) return abort('mime')

      const isVideo = VIDEO_MIME_ALLOWED.has(mime)
      const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES

      try {
        const saved = saveBase64DataUrl(dataUrl, mediaDir, maxBytes)
        if (!saved) return abort('decode')
        paths.push(saved)
      } catch (err) {
        if (err instanceof Error && err.name === 'FileSizeExceeded') {
          return abort('size')
        }
        console.warn('[WebSocket] media decode error:', err)
        return abort('decode')
      }
    }

    return { paths, reason: null }
  }

  // ========================================================================
  // Media: signed URL generation
  // ========================================================================

  private _signMediaPath(absPath: string): string | null {
    try {
      const mediaRoot = resolve(getMediaDir())
      const resolved = resolve(absPath)
      const rel = resolved.startsWith(mediaRoot) ? resolved.slice(mediaRoot.length + 1) : null
      if (!rel) return null

      const payload = Buffer.from(rel).toString('base64url')
      const mac = createHmac('sha256', this._mediaSecret)
        .update(payload)
        .digest()
        .subarray(0, 16)
      const sig = mac.toString('base64url')
      return `/api/media/${sig}/${payload}`
    } catch {
      return null
    }
  }

  private _signOrStageMediaPath(path: string): { url: string; name: string } | null {
    const signed = this._signMediaPath(path)
    if (signed) return { url: signed, name: path.split('/').pop() || 'attachment' }

    try {
      if (!existsSync(path)) return null
      const mediaDir = getMediaDir('websocket')
      const safeName = safeFilename(path.split('/').pop() || 'attachment')
      const staged = join(mediaDir, `${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}-${safeName}`)
      copyFileSync(path, staged)

      const signedUrl = this._signMediaPath(staged)
      if (!signedUrl) return null
      return { url: signedUrl, name: path.split('/').pop() || 'attachment' }
    } catch (err) {
      console.warn('[WebSocket] failed to stage outbound media:', err)
      return null
    }
  }

  private _augmentMediaUrls(session: Session): void {
    const messages = session.messages
    if (!Array.isArray(messages)) return

    for (const msg of messages) {
      const media = (msg as Record<string, unknown>).media
      if (!Array.isArray(media) || media.length === 0) continue

      const urls: { url: string; name: string }[] = []
      for (const entry of media) {
        if (typeof entry !== 'string' || !entry) continue
        const signed = this._signMediaPath(entry)
        if (signed) {
          urls.push({ url: signed, name: entry.split('/').pop() || 'attachment' })
        }
      }
      if (urls.length > 0) {
        (msg as Record<string, unknown>).media_urls = urls
      }
      delete (msg as Record<string, unknown>).media
    }
  }

  // ========================================================================
  // Message sending
  // ========================================================================

  async send(msg: OutboundMessage): Promise<void> {
    const conns = this._subs.get(msg.chatId)
    if (!conns || conns.size === 0) {
      console.warn(`[WebSocket] no active subscribers for chat_id=${msg.chatId}`)
      return
    }

    const payload: Record<string, unknown> = {
      event: 'message',
      chat_id: msg.chatId,
      text: msg.content,
    }

    // Media URLs
    if (msg.media && msg.media.length > 0) {
      const urls: { url: string; name: string }[] = []
      for (const entry of msg.media) {
        const signed = this._signOrStageMediaPath(entry)
        if (signed) urls.push(signed)
      }
      if (urls.length > 0) payload.media_urls = urls
    }

    if (msg.replyTo) {
      payload.reply_to = msg.replyTo
    }

    // Mark intermediate agent breadcrumbs
    if (msg.metadata?._tool_hint) {
      payload.kind = 'tool_hint'
    } else if (msg.metadata?._progress) {
      payload.kind = 'progress'
    }

    const raw = JSON.stringify(payload)
    const snapshot = [...conns]
    for (const ws of snapshot) {
      try {
        if (ws.readyState === 1) ws.send(raw)
      } catch {
        this._cleanupConnection(ws)
      }
    }
  }

  async sendDelta(chatId: string, delta: string, metadata?: Record<string, unknown>): Promise<void> {
    const conns = this._subs.get(chatId)
    if (!conns || conns.size === 0) return

    const meta = metadata ?? {}
    let body: Record<string, unknown>

    if (meta._stream_end) {
      body = { event: 'stream_end', chat_id: chatId }
    } else {
      body = { event: 'delta', chat_id: chatId, text: delta }
    }

    if (meta._stream_id !== undefined) {
      body.stream_id = meta._stream_id
    }

    const raw = JSON.stringify(body)
    const snapshot = [...conns]
    for (const ws of snapshot) {
      try {
        if (ws.readyState === 1) ws.send(raw)
      } catch {
        this._cleanupConnection(ws)
      }
    }
  }
}
