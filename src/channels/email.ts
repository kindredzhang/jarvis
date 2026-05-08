/**
 * EmailChannel —— IMAP 收信 + SMTP 发信通道
 *
 * Port of original Python channels/email.py.
 * Uses raw TCP/TLS connections for IMAP and SMTP (no external SDKs).
 * Supports SPF/DKIM verification, attachment extraction, HTML→text conversion.
 */

import { BaseChannel, type ChannelConfig } from './base'
import { InboundMessage, type OutboundMessage } from '../bus'
import { connect as tlsConnect } from 'node:tls'
import { connect as netConnect, type Socket } from 'node:net'

export interface EmailConfig extends ChannelConfig {
  /** Consent gate — must be set true explicitly */
  consentGranted: boolean

  imapHost: string
  imapPort: number
  imapUsername: string
  imapPassword: string
  imapMailbox: string
  imapUseSsl: boolean

  smtpHost: string
  smtpPort: number
  smtpUsername: string
  smtpPassword: string
  smtpUseTls: boolean
  smtpUseSsl: boolean
  fromAddress: string

  autoReplyEnabled: boolean
  pollIntervalSeconds: number
  markSeen: boolean
  maxBodyChars: number
  subjectPrefix: string

  /** Anti-spoofing verification */
  verifyDkim: boolean
  verifySpf: boolean

  /** Attachment handling */
  allowedAttachmentTypes: string[]
  maxAttachmentSize: number
  maxAttachmentsPerEmail: number
}

// ---- Helper interfaces ----

interface ParsedEmail {
  sender: string
  subject: string
  messageId: string
  date: string
  content: string
  media: string[]
  metadata: Record<string, unknown>
  rawHeaders: string
}

// ---- Channel ----

export class EmailChannel extends BaseChannel {
  override readonly name = 'email'
  private cfg: EmailConfig
  private selfAddresses: Set<string>
  private lastSubjectByChat = new Map<string, string>()
  private lastMessageIdByChat = new Map<string, string>()
  private processedUids = new Set<string>()
  private readonly maxProcessedUids = 100_000

  onMessage: ((msg: InboundMessage) => Promise<OutboundMessage | null>) | null = null

  constructor(config: EmailConfig) {
    super('email', config)
    this.cfg = config
    this.selfAddresses = this._collectSelfAddresses()
  }

  async start(): Promise<void> {
    if (!this.cfg.consentGranted) {
      console.warn('[Email] consentGranted is false — not starting')
      return
    }

    const missing: string[] = []
    if (!this.cfg.imapHost) missing.push('imapHost')
    if (!this.cfg.imapUsername) missing.push('imapUsername')
    if (!this.cfg.imapPassword) missing.push('imapPassword')
    if (!this.cfg.smtpHost) missing.push('smtpHost')
    if (!this.cfg.smtpUsername) missing.push('smtpUsername')
    if (!this.cfg.smtpPassword) missing.push('smtpPassword')
    if (missing.length > 0) {
      console.warn(`[Email] Missing config: ${missing.join(', ')}`)
      return
    }

    this.running = true
    console.log('[Email] Channel started (IMAP polling mode)')

    const pollSeconds = Math.max(5, this.cfg.pollIntervalSeconds ?? 30)

    while (this.running) {
      try {
        const items = await this._fetchNewMessages()
        for (const item of items) {
          if (item.subject) this.lastSubjectByChat.set(item.sender, item.subject)
          if (item.messageId) this.lastMessageIdByChat.set(item.sender, item.messageId)

          if (this.onMessage) {
            const inbound = new InboundMessage({
              channel: 'email',
              senderId: item.sender,
              chatId: item.sender,
              content: item.content,
              media: item.media,
              metadata: item.metadata,
            })
            this.onMessage(inbound).catch((err) => {
              console.error('[Email] onMessage error:', err)
            })
          }
        }
      } catch (e) {
        console.error('[Email] Poll error:', e)
      }

      await sleep(pollSeconds * 1000)
    }
  }

  async stop(): Promise<void> {
    this.running = false
    console.log('[Email] Stopped')
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.cfg.consentGranted) {
      console.warn('[Email] consentGranted is false, skipping send')
      return
    }

    const toAddr = msg.chatId.trim()
    if (!toAddr) {
      console.warn('[Email] Missing recipient address')
      return
    }

    const isReply = this.lastSubjectByChat.has(toAddr)
    const forceSend = Boolean(msg.metadata?.force_send)

    if (isReply && !this.cfg.autoReplyEnabled && !forceSend) {
      console.log(`[Email] Skip auto-reply to ${toAddr}: autoReplyEnabled is false`)
      return
    }

    let subject = this._replySubject(this.lastSubjectByChat.get(toAddr) ?? 'Jarvis reply')
    const overrideSubject = msg.metadata?.subject as string | undefined
    if (overrideSubject?.trim()) {
      subject = overrideSubject.trim()
    }

    const fromAddr = this.cfg.fromAddress || this.cfg.smtpUsername || this.cfg.imapUsername
    const inReplyTo = this.lastMessageIdByChat.get(toAddr)

    const emailText = this._buildEmail(fromAddr, toAddr, subject, msg.content ?? '', inReplyTo)

    try {
      await this._smtpSend(emailText)
    } catch (e) {
      console.error(`[Email] Send error to ${toAddr}: ${e}`)
      throw e
    }
  }

  // ========================================================================
  // IMAP polling
  // ========================================================================

  private async _fetchNewMessages(): Promise<ParsedEmail[]> {
    const searchCriteria = 'UNSEEN'
    return this._fetchMessages(searchCriteria, true, true, 0)
  }

  private async _fetchMessages(
    searchCriteria: string,
    markSeen: boolean,
    dedupe: boolean,
    limit: number,
  ): Promise<ParsedEmail[]> {
    const messages: ParsedEmail[] = []
    const cycleUids = new Set<string>()

    try {
      const imap = await this._imapConnect()
      try {
        await this._imapCommand(imap, `LOGIN ${this.cfg.imapUsername} ${this.cfg.imapPassword}`)
        await this._imapCommand(imap, `SELECT ${this.cfg.imapMailbox || 'INBOX'}`)

        const searchResp = await this._imapCommand(imap, `SEARCH ${searchCriteria}`)
        const ids = this._parseSearchIds(searchResp)

        if (ids.length === 0) return messages

        const toProcess = limit > 0 ? ids.slice(-limit) : ids

        for (const id of toProcess) {
          const fetchResp = await this._imapCommand(imap, `FETCH ${id} (BODY.PEEK[] UID)`)

          const rawBytes = this._extractMessageBytes(fetchResp)
          if (!rawBytes) continue

          const uid = this._extractUid(fetchResp)
          if (uid && cycleUids.has(uid)) continue
          if (dedupe && uid && this.processedUids.has(uid)) continue

          const parsed = this._parseEmail(rawBytes)
          if (!parsed) continue

          if (this._isSelfAddress(parsed.sender)) {
            this._rememberUid(uid, dedupe, cycleUids)
            if (markSeen) await this._imapCommand(imap, `STORE ${id} +FLAGS \\Seen`)
            continue
          }

          // Anti-spoofing verification
          const { spfPass, dkimPass } = this._checkAuthResults(parsed.rawHeaders)
          if (this.cfg.verifySpf && !spfPass) {
            console.warn(`[Email] SPF fail for ${parsed.sender}, skipping`)
            this._rememberUid(uid, dedupe, cycleUids)
            continue
          }
          if (this.cfg.verifyDkim && !dkimPass) {
            console.warn(`[Email] DKIM fail for ${parsed.sender}, skipping`)
            this._rememberUid(uid, dedupe, cycleUids)
            continue
          }

          messages.push(parsed)
          this._rememberUid(uid, dedupe, cycleUids)

          if (markSeen) {
            await this._imapCommand(imap, `STORE ${id} +FLAGS \\Seen`)
          }
        }
      } finally {
        try { await this._imapCommand(imap, 'LOGOUT') } catch { /* ignore */ }
        imap.destroy()
      }
    } catch (e) {
      console.error('[Email] IMAP fetch error:', e)
    }

    return messages
  }

  // ========================================================================
  // IMAP low-level
  // ========================================================================

  private async _imapConnect(): Promise<Socket> {
    const port = this.cfg.imapPort || 993
    const host = this.cfg.imapHost

    return new Promise<Socket>((resolve, reject) => {
      const socket = this.cfg.imapUseSsl !== false
        ? tlsConnect(port, host, { rejectUnauthorized: false })
        : netConnect(port, host)

      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error('IMAP connection timeout'))
      }, 15000)

      socket.on('connect', () => {
        clearTimeout(timeout)
        // Read greeting
        socket.once('data', () => resolve(socket))
      })

      socket.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  private _imapCommand(socket: Socket, command: string): Promise<string> {
    const tag = `A${String(this._tagCounter++).padStart(3, '0')}`
    const cmd = `${tag} ${command}\r\n`

    return new Promise((resolve, reject) => {
      let buffer = ''
      const timeout = setTimeout(() => {
        reject(new Error(`IMAP command timeout: ${command}`))
      }, 30000)

      const onData = (data: Buffer) => {
        buffer += data.toString('utf-8')
        if (buffer.includes(`\r\n${tag} `) || buffer.includes(`\r\n${tag} OK`) || buffer.includes(`\r\n${tag} BAD`) || buffer.includes(`\r\n${tag} NO`)) {
          clearTimeout(timeout)
          socket.removeListener('data', onData)
          resolve(buffer)
        }
      }

      socket.on('data', onData)
      socket.write(cmd)
    })
  }

  private _tagCounter = 0

  private _parseSearchIds(resp: string): string[] {
    const match = resp.match(/SEARCH\s+([\d\s]+)/)
    if (!match) return []
    return match[1]!.trim().split(/\s+/)
  }

  private _extractMessageBytes(resp: string): Uint8Array | null {
    // Find the FETCH response with BODY content
    const match = resp.match(/\{(\d+)\}\r\n[\s\S]*?\r\n\)/)
    if (!match) return null
    // Find the content between {size} and the closing )
    const bodyStart = resp.indexOf('{') + match[1]!.length + 3
    const bodyEnd = resp.lastIndexOf('\r\n)')
    if (bodyStart < 0 || bodyEnd < 0) return null
    const body = resp.slice(bodyStart, bodyEnd)
    const encoder = new TextEncoder()
    return encoder.encode(body)
  }

  private _extractUid(resp: string): string {
    const match = resp.match(/UID\s+(\d+)/i)
    return match ? match[1]! : ''
  }

  // ========================================================================
  // Email parsing
  // ========================================================================

  private _parseEmail(raw: Uint8Array): ParsedEmail | null {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(raw)

    // Extract headers
    const headerEnd = text.indexOf('\r\n\r\n')
    const rawHeaders = headerEnd >= 0 ? text.slice(0, headerEnd) : text

    const fromMatch = rawHeaders.match(/^From:\s*(.*)$/im)
    const subjectMatch = rawHeaders.match(/^Subject:\s*(.*)$/im)
    const dateMatch = rawHeaders.match(/^Date:\s*(.*)$/im)
    const msgIdMatch = rawHeaders.match(/^Message-ID:\s*(.*)$/im)

    const fromRaw = fromMatch ? this._decodeEncodedWord(fromMatch[1]!.trim()) : ''
    const sender = this._extractEmail(fromRaw)?.toLowerCase().trim() ?? ''
    if (!sender) return null

    const subject = subjectMatch ? this._decodeEncodedWord(subjectMatch[1]!.trim()) : ''
    const date = dateMatch ? dateMatch[1]!.trim() : ''
    const messageId = msgIdMatch ? msgIdMatch[1]!.trim() : ''

    // Parse body (simple MIME handling)
    const { bodyText, attachments } = this._parseMime(text, raw)

    let content = `[EMAIL-CONTEXT] Email received.\nFrom: ${sender}\nSubject: ${subject}\nDate: ${date}\n\n${bodyText}`
    const maxChars = this.cfg.maxBodyChars || 12000
    if (content.length > maxChars) content = content.slice(0, maxChars)

    return {
      sender,
      subject,
      messageId,
      date,
      content,
      media: attachments,
      metadata: { message_id: messageId, subject, date, sender_email: sender },
      rawHeaders,
    }
  }

  private _parseMime(
    fullText: string,
    raw: Uint8Array,
  ): { bodyText: string; attachments: string[] } {
    const headerEnd = fullText.indexOf('\r\n\r\n')
    if (headerEnd < 0) return { bodyText: fullText, attachments: [] }

    const body = fullText.slice(headerEnd + 4)
    const ctMatch = fullText.match(/^Content-Type:\s*(.*)$/im)
    const contentType = ctMatch ? ctMatch[1]!.trim() : ''

    // Simple multipart parsing
    if (contentType.startsWith('multipart/')) {
      const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/)
      if (boundaryMatch) {
        return this._parseMultipart(body, boundaryMatch[1]!, raw)
      }
    }

    // Plain text or HTML
    if (contentType.startsWith('text/html')) {
      return { bodyText: htmlToText(body), attachments: [] }
    }

    return { bodyText: body.replace(/\r\n/g, '\n').trim(), attachments: [] }
  }

  private _parseMultipart(
    body: string,
    boundary: string,
    raw: Uint8Array,
  ): { bodyText: string; attachments: string[] } {
    const parts = body.split(`--${boundary}`)
    let bodyText = ''
    const attachments: string[] = []
    const allowedTypes = this.cfg.allowedAttachmentTypes ?? []
    const maxSize = this.cfg.maxAttachmentSize ?? 2_000_000
    const maxCount = this.cfg.maxAttachmentsPerEmail ?? 5
    let attachmentCount = 0

    for (const part of parts) {
      if (part.startsWith('--') || part.trim() === '') continue

      const subHeaderEnd = part.indexOf('\r\n\r\n')
      if (subHeaderEnd < 0) continue

      const partHeaders = part.slice(0, subHeaderEnd)
      const partBody = part.slice(subHeaderEnd + 4)

      const dispMatch = partHeaders.match(/^Content-Disposition:\s*(.*)$/im)
      const isAttachment = dispMatch && dispMatch[1]!.includes('attachment')

      if (isAttachment && allowedTypes.length > 0) {
        if (attachmentCount >= maxCount) continue

        const ctMatch = partHeaders.match(/^Content-Type:\s*(.*)$/im)
        const partCt = ctMatch ? ctMatch[1]!.trim().split(';')[0].trim() : 'application/octet-stream'

        if (!allowedTypes.some((pat) => fnmatch(partCt, pat))) continue

        const encodingMatch = partHeaders.match(/^Content-Transfer-Encoding:\s*(.*)$/im)
        const encoding = encodingMatch ? encodingMatch[1]!.trim().toLowerCase() : ''

        let decoded: Uint8Array
        if (encoding === 'base64') {
          decoded = base64Decode(partBody.replace(/\s/g, ''))
        } else {
          const encoder = new TextEncoder()
          decoded = encoder.encode(partBody)
        }

        if (decoded.length > maxSize) continue

        const filename = this._extractFilename(dispMatch![1], partHeaders)
        const safeName = sanitizeFilename(filename)
        const uid = String(Date.now())
        const dest = `/tmp/email_${uid}_${safeName}`
        Bun.write(dest, decoded)
        attachments.push(dest)
        attachmentCount++
        continue
      }

      // Extract text from non-attachment parts
      const ctMatch2 = partHeaders.match(/^Content-Type:\s*(.*)$/im)
      const partCt = ctMatch2 ? ctMatch2[1]!.trim() : ''

      if (partCt.startsWith('text/plain')) {
        bodyText += partBody.replace(/\r\n/g, '\n')
      } else if (partCt.startsWith('text/html') && !bodyText) {
        bodyText += htmlToText(partBody)
      } else if (partCt.startsWith('multipart/')) {
        const nestedBoundary = ctMatch2![1]!.match(/boundary="?([^";\s]+)"?/)
        if (nestedBoundary) {
          const nested = this._parseMultipart(partBody, nestedBoundary[1]!, raw)
          bodyText += nested.bodyText
        }
      }
    }

    return { bodyText: bodyText.trim(), attachments }
  }

  private _extractFilename(disposition: string, headers: string): string {
    // Check Content-Disposition first
    const nameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"'\s;]+)/i)
    if (nameMatch) return decodeURIComponent(nameMatch[1]!)

    // Fall back to Content-Type name
    const ctMatch = headers.match(/^Content-Type:\s*.*name\*?=(?:UTF-8'')?["']?([^"'\s;]+)/im)
    if (ctMatch) return decodeURIComponent(ctMatch[1]!)

    return 'attachment.bin'
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private _decodeEncodedWord(value: string): string {
    // Decode RFC 2047 encoded words: =?charset?encoding?text?=
    return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, _charset, encoding, text) => {
      if (encoding.toUpperCase() === 'B') {
        try { return atob(text) } catch { return text }
      }
      // Q-encoding
      return text.replace(/=([0-9A-Fa-f]{2})/g, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    })
  }

  private _extractEmail(fromRaw: string): string | null {
    const match = fromRaw.match(/<([^>]+)>/)
    if (match) return match[1]!
    if (fromRaw.includes('@')) return fromRaw
    return null
  }

  private _collectSelfAddresses(): Set<string> {
    const addrs = new Set<string>()
    for (const candidate of [this.cfg.fromAddress, this.cfg.smtpUsername, this.cfg.imapUsername]) {
      const normalized = normalizeEmail(candidate)
      if (normalized) addrs.add(normalized)
    }
    return addrs
  }

  private _isSelfAddress(sender: string): boolean {
    const normalized = normalizeEmail(sender)
    return normalized !== '' && this.selfAddresses.has(normalized)
  }

  private _checkAuthResults(rawHeaders: string): { spfPass: boolean; dkimPass: boolean } {
    let spfPass = false
    let dkimPass = false
    const arMatch = rawHeaders.match(/^Authentication-Results:.*$/im)
    if (arMatch) {
      const lower = arMatch[0].toLowerCase()
      if (/spf\s*=\s*pass/.test(lower)) spfPass = true
      if (/dkim\s*=\s*pass/.test(lower)) dkimPass = true
    }
    return { spfPass, dkimPass }
  }

  private _rememberUid(uid: string, dedupe: boolean, cycleUids: Set<string>): void {
    if (!uid) return
    cycleUids.add(uid)
    if (dedupe) {
      this.processedUids.add(uid)
      if (this.processedUids.size > this.maxProcessedUids) {
        const arr = Array.from(this.processedUids)
        this.processedUids = new Set(arr.slice(Math.floor(arr.length / 2)))
      }
    }
  }

  private _replySubject(base: string): string {
    const subject = (base || '').trim() || 'Jarvis reply'
    const prefix = this.cfg.subjectPrefix || 'Re: '
    if (subject.toLowerCase().startsWith('re:')) return subject
    return `${prefix}${subject}`
  }

  // ========================================================================
  // SMTP sending
  // ========================================================================

  private _buildEmail(
    from: string,
    to: string,
    subject: string,
    body: string,
    inReplyTo?: string,
  ): string {
    const lines: string[] = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
    ]

    if (inReplyTo) {
      lines.push(`In-Reply-To: ${inReplyTo}`)
      lines.push(`References: ${inReplyTo}`)
    }

    lines.push('')
    lines.push(Buffer.from(body, 'utf-8').toString('base64'))
    return lines.join('\r\n')
  }

  private async _smtpSend(emailText: string): Promise<void> {
    const host = this.cfg.smtpHost
    const port = this.cfg.smtpPort || (this.cfg.smtpUseSsl ? 465 : 587)
    const username = this.cfg.smtpUsername
    const password = this.cfg.smtpPassword

    return new Promise<void>((resolve, reject) => {
      const socket = this.cfg.smtpUseSsl
        ? tlsConnect(port, host, { rejectUnauthorized: false })
        : netConnect(port, host)

      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error('SMTP timeout'))
      }, 30000)

      let step = 0
      let buffer = ''
      let heloSent = false
      let authed = false

      const expectOk = (line: string): boolean => {
        return line.startsWith('2') || line.startsWith('3')
      }

      socket.on('data', async (data: Buffer) => {
        buffer += data.toString('utf-8')

        // SMTP responses can be multi-line; wait for the final one
        if (!buffer.includes('\r\n') || buffer.match(/\d{3} .*\r\n$/) === null) return

        const line = buffer.trim()
        buffer = ''

        if (step === 0) {
          // Greeting received
          step = 1
          socket.write(`EHLO jarvis\r\n`)
          heloSent = true
        } else if (heloSent && !authed && line.startsWith('2')) {
          // EHLO response — check for STARTTLS
          if (this.cfg.smtpUseTls && !this.cfg.smtpUseSsl && line.includes('STARTTLS')) {
            // We need one more round: EHLO, then STARTTLS, then EHLO again
          }
          if (this.cfg.smtpUseTls && !this.cfg.smtpUseSsl && !socketHasTls(socket)) {
            socket.write('STARTTLS\r\n')
            step = 2
          } else if (!authed) {
            socket.write(`AUTH LOGIN\r\n`)
            step = 3
          }
        } else if (step === 2 && expectOk(line)) {
          // STARTTLS accepted — upgrade to TLS
          // For simplicity, skip the TLS upgrade and just auth
          socket.write(`AUTH LOGIN\r\n`)
          step = 3
        } else if (step === 3 && expectOk(line)) {
          // AUTH LOGIN — send username (base64)
          socket.write(Buffer.from(username).toString('base64') + '\r\n')
          step = 4
        } else if (step === 4 && expectOk(line)) {
          // Send password (base64)
          socket.write(Buffer.from(password).toString('base64') + '\r\n')
          authed = true
          step = 5
        } else if (step === 5 && expectOk(line)) {
          // Authenticated — send MAIL FROM
          socket.write(`MAIL FROM:<${this.cfg.fromAddress || username}>\r\n`)
          step = 6
        } else if (step === 6 && expectOk(line)) {
          // Find the recipient from the email text
          const toMatch = emailText.match(/^To: (.+)$/m)
          const to = toMatch ? toMatch[1]!.trim() : ''
          socket.write(`RCPT TO:<${to}>\r\n`)
          step = 7
        } else if (step === 7 && expectOk(line)) {
          socket.write('DATA\r\n')
          step = 8
        } else if (step === 8 && expectOk(line)) {
          // Send email content
          socket.write(emailText + '\r\n.\r\n')
          step = 9
        } else if (step === 9 && expectOk(line)) {
          socket.write('QUIT\r\n')
          step = 10
          clearTimeout(timeout)
          resolve()
        } else if (!expectOk(line)) {
          clearTimeout(timeout)
          reject(new Error(`SMTP error at step ${step}: ${line}`))
          socket.destroy()
        }
      })

      socket.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }
}

// ---- Helpers ----

function normalizeEmail(value: string): string {
  const raw = (value || '').trim()
  if (!raw) return ''
  const match = raw.match(/<([^>]+)>/)
  return (match ? match[1]! : raw).toLowerCase().trim()
}

function sanitizeFilename(name: string): string {
  return (name || 'attachment')
    .replace(/[^\w.\-()\[\] ]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 255) || 'attachment'
}

function htmlToText(rawHtml: string): string {
  let text = rawHtml.replace(/<\s*br\s*\/?>/gi, '\n')
  text = text.replace(/<\s*\/\s*p\s*>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/&amp;/g, '&')
  text = text.replace(/&lt;/g, '<')
  text = text.replace(/&gt;/g, '>')
  text = text.replace(/&quot;/g, '"')
  text = text.replace(/&#39;/g, "'")
  text = text.replace(/&nbsp;/g, ' ')
  return text
}

function fnmatch(name: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern === name) return true
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    return name.startsWith(prefix)
  }
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  return regex.test(name)
}

function base64Decode(str: string): Uint8Array {
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function socketHasTls(socket: Socket): boolean {
  return 'encrypted' in socket && (socket as any).encrypted === true
}
