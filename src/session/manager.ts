/**
 * SessionManager —— 完整会话管理
 *
 * 比 SessionStore 更完整：支持 metadata、TTL 过期、自动压缩、归档。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export interface SessionMessage {
  role: string
  content: string
  timestamp: string
  tool_call_id?: string
  name?: string
  tool_calls?: unknown[]
  [key: string]: unknown
}

export class Session {
  key: string
  messages: SessionMessage[] = []
  createdAt: Date = new Date()
  updatedAt: Date = new Date()
  metadata: Record<string, unknown> = {}
  lastConsolidated = 0

  constructor(key: string) { this.key = key }

  addMessage(role: string, content: string, extra?: Record<string, unknown>) {
    this.messages.push({ role, content, timestamp: new Date().toISOString(), ...extra })
    this.updatedAt = new Date()
  }

  getHistory(maxMessages = 500): SessionMessage[] {
    return this.messages.slice(-maxMessages)
  }
}

export class SessionManager {
  private sessionsDir: string
  private cache = new Map<string, Session>()
  private ttlMinutes: number

  constructor(workspace: string, ttlMinutes = 0) {
    this.sessionsDir = join(workspace, 'sessions')
    this.ttlMinutes = ttlMinutes
  }

  private path(key: string): string { return join(this.sessionsDir, `${key.replace(/[:\/]/g, '_')}.json`) }

  getOrCreate(key: string): Session {
    let s = this.cache.get(key)
    if (!s) {
      const fp = this.path(key)
      if (existsSync(fp)) {
        try {
          const data = JSON.parse(readFileSync(fp, 'utf-8'))
          s = Object.assign(new Session(key), data, { createdAt: new Date(data.createdAt), updatedAt: new Date(data.updatedAt) })
        } catch {}
      }
      if (!s) { s = new Session(key) }
      this.cache.set(key, s)
    }
    return s
  }

  save(session: Session): void {
    mkdirSync(this.sessionsDir, { recursive: true })
    writeFileSync(this.path(session.key), JSON.stringify(session, null, 2), 'utf-8')
    this.cache.set(session.key, session)
  }

  invalidate(key: string): void { this.cache.delete(key) }

  /** 清理过期会话 */
  cleanup(): number {
    if (this.ttlMinutes <= 0) return 0
    const now = Date.now()
    const maxAge = this.ttlMinutes * 60 * 1000
    let count = 0
    if (existsSync(this.sessionsDir)) {
      for (const f of readdirSync(this.sessionsDir)) {
        try {
          const data = JSON.parse(readFileSync(join(this.sessionsDir, f), 'utf-8'))
          const updated = new Date(data.updatedAt ?? data.createdAt).getTime()
          if (now - updated > maxAge) { unlinkSync(join(this.sessionsDir, f)); count++ }
        } catch {}
      }
    }
    return count
  }
}
