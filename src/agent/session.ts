/**
 * SessionStore —— 轻量级会话持久化
 *
 * 管理每个 sessionKey 对应的消息列表（LLM 消息格式），
 * 支持会话元数据（updated_at, last_consolidated, metadata）。
 * 持久化为 messages.jsonl + meta.json（每个 sessionKey 对应一个目录）。
 *
 * ===== 原子写入 =====
 * save() 先写入 .jsonl.tmp 再 rename，避免断电/崩溃导致文件损坏。
 * flushAll() 在优雅关闭时带 fsync 刷新到磁盘。
 * 加载时若检测到 .tmp 残留文件则自动清理。
 *
 * ===== 修复 =====
 * 加载 messages.jsonl 时若某行 JSON 解析失败则跳过该行，其余消息保留。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { JSONL } from '../utils/jsonl'
import { findLegalMessageStart } from '../utils/helpers'

// ---- 类型 ----

/** 会话记录（JSONL 单行） */
export interface SessionMessageRecord {
  role: string
  content: unknown
  tool_call_id?: string
  name?: string
  tool_calls?: unknown[]
  timestamp?: string
  [key: string]: unknown
}

/** 会话元数据 */
export interface SessionMeta {
  created_at: string
  updated_at: string
  last_consolidated: number
  metadata: Record<string, unknown>
}

/** 完整会话 = 消息列表 + 元数据 */
export interface Session {
  key: string
  messages: SessionMessageRecord[]
  created_at: string
  updated_at: string
  metadata: Record<string, unknown>
  last_consolidated: number
}

/** list_sessions 返回的摘要信息 */
export interface SessionInfo {
  key: string
  created_at: string
  updated_at: string
}

// ---- 常量 ----

const DEFAULT_META: SessionMeta = {
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_consolidated: 0,
  metadata: {},
}

// ---- 辅助函数 ----

function defaultSession(key: string): Session {
  return {
    key,
    messages: [],
    ...DEFAULT_META,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: {},
    last_consolidated: 0,
  }
}

/** 保留最近 N 条消息的合法后缀（1:1 移植 retain_recent_legal_suffix） */
export function retainRecentLegalSuffix(
  session: Session,
  maxMessages: number,
): void {
  if (maxMessages <= 0) {
    session.messages = []
    session.last_consolidated = 0
    session.updated_at = new Date().toISOString()
    return
  }
  if (session.messages.length <= maxMessages) return

  let startIdx = Math.max(0, session.messages.length - maxMessages)

  // 如果截断点落在回合中间，向前扩展到最近的 user 消息
  while (startIdx > 0 && session.messages[startIdx]!.role !== 'user') {
    startIdx--
  }

  let retained = session.messages.slice(startIdx)

  // 避免保留前端的孤立工具结果
  const legalStart = findLegalMessageStart(retained)
  if (legalStart > 0) {
    retained = retained.slice(legalStart)
  }

  const dropped = session.messages.length - retained.length
  session.messages = retained
  session.last_consolidated = Math.max(0, session.last_consolidated - dropped)
  session.updated_at = new Date().toISOString()
}

// ---- SessionStore ----

export class SessionStore {
  private readonly workspace: string
  private readonly sessionsDir: string
  private cache: Map<string, Session> = new Map()
  private dirty: Set<string> = new Set()

  constructor(workspace: string) {
    this.workspace = workspace
    this.sessionsDir = join(workspace, 'sessions')
    this.migrateLegacy()
  }

  /**
   * 迁移旧版单 JSON 文件格式 → 新版目录格式。
   */
  private migrateLegacy(): void {
    const legacyPath = join(this.workspace, 'sessions.json')
    if (!existsSync(legacyPath)) return
    try {
      const data = JSON.parse(readFileSync(legacyPath, 'utf-8'))
      if (typeof data !== 'object') return
      for (const [key, msgs] of Object.entries(data as Record<string, unknown>)) {
        if (!Array.isArray(msgs) || msgs.length === 0) continue
        const session = this.getOrCreate(key)
        session.messages.push(...(msgs as SessionMessageRecord[]))
        this.save(key)
      }
      renameSync(legacyPath, legacyPath + '.bak')
    } catch {
      // ignore migration errors
    }
  }

  // ==================================================================
  // 公共 API
  // ==================================================================

  /** 获取或创建完整 Session 对象 */
  getOrCreate(sessionKey: string): Session {
    if (!this.cache.has(sessionKey)) {
      this.cache.set(sessionKey, this.loadSession(sessionKey))
    }
    return this.cache.get(sessionKey)!
  }

  /** 获取历史消息列表（保持向后兼容） */
  getHistory(sessionKey: string, maxMessages = 0): SessionMessageRecord[] {
    const session = this.getOrCreate(sessionKey)
    if (maxMessages > 0 && session.messages.length > maxMessages) {
      return session.messages.slice(-maxMessages)
    }
    return session.messages
  }

  /** 追加消息到会话 */
  appendMessage(sessionKey: string, msg: SessionMessageRecord): void {
    const session = this.getOrCreate(sessionKey)
    session.messages.push(msg)
    session.updated_at = new Date().toISOString()
    this.markDirty(sessionKey)
  }

  /** 追加多条消息 */
  appendMessages(sessionKey: string, msgs: SessionMessageRecord[]): void {
    const session = this.getOrCreate(sessionKey)
    session.messages.push(...msgs)
    session.updated_at = new Date().toISOString()
    this.markDirty(sessionKey)
  }

  /** 持久化单个会话（原子写入：.tmp → rename） */
  save(sessionKey: string): void {
    const session = this.cache.get(sessionKey)
    if (session) {
      this.writeSessionAtomic(sessionKey, session)
      this.dirty.delete(sessionKey)
    }
  }

  /** 标记会话为脏（需持久化） */
  markDirty(sessionKey: string): void {
    this.dirty.add(sessionKey)
  }

  /** 持久化所有脏会话（常规写入，不带 fsync） */
  flush(): void {
    for (const key of this.dirty) {
      const session = this.cache.get(key)
      if (session) {
        this.writeSessionAtomic(key, session)
      }
    }
    this.dirty.clear()
  }

  /**
   * 持久化所有缓存中的会话并 fsync，用于优雅关闭。
   * 返回已刷新的会话数。
   */
  flushAll(): number {
    let flushed = 0
    for (const [key, session] of this.cache) {
      try {
        this.writeSessionAtomic(key, session, true)
        flushed++
      } catch {
        console.warn(`[SessionStore] Failed to flush session ${key}`)
      }
    }
    this.dirty.clear()
    return flushed
  }

  /** 使缓存失效（下次访问时重新从磁盘加载） */
  invalidate(sessionKey: string): void {
    this.cache.delete(sessionKey)
    this.dirty.delete(sessionKey)
  }

  /**
   * 删除会话（从磁盘和缓存中移除）。
   * 返回 true 如果文件存在且已删除。
   */
  deleteSession(sessionKey: string): boolean {
    const dir = this.sessionDir(sessionKey)
    this.invalidate(sessionKey)
    if (!existsSync(dir)) return false
    try {
      const messagesPath = this.messagesPath(sessionKey)
      const metaPath = this.metaPath(sessionKey)
      if (existsSync(messagesPath)) unlinkSync(messagesPath)
      if (existsSync(metaPath)) unlinkSync(metaPath)
      try { unlinkSync(dir) } catch { /* not empty */ }
      return true
    } catch {
      return false
    }
  }

  /**
   * 只读加载会话（不缓存），适用于 HTTP 只读端点。
   * 返回 session 格式数据或 null。
   */
  readSessionFile(sessionKey: string): Session | null {
    const dir = this.sessionDir(sessionKey)
    if (!existsSync(dir)) return null
    try {
      return this.loadSession(sessionKey)
    } catch {
      // 尝试修复
      const repaired = this.repairSession(sessionKey)
      return repaired ?? null
    }
  }

  /** 列出所有已知会话 */
  listSessions(): SessionInfo[] {
    const results: SessionInfo[] = []

    if (!existsSync(this.sessionsDir)) return results

    // 从磁盘读取目录列表
    try {
      const entries = readdirSync(this.sessionsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const meta = this.loadMeta(entry.name)
          if (meta) {
            results.push({
              key: entry.name,
              created_at: meta.created_at,
              updated_at: meta.updated_at,
            })
          }
        }
      }
    } catch {
      // ignore
    }

    // 补充缓存中的会话
    for (const [key, session] of this.cache) {
      if (!results.some((r) => r.key === key)) {
        results.push({
          key,
          created_at: session.created_at,
          updated_at: session.updated_at,
        })
      }
    }

    return results
  }

  /** 获取最近 consolidated 的索引 */
  getLastConsolidated(sessionKey: string): number {
    const session = this.cache.get(sessionKey)
    return session?.last_consolidated ?? 0
  }

  /** 设置 last_consolidated */
  setConsolidated(sessionKey: string, value: number): void {
    const session = this.cache.get(sessionKey)
    if (session) {
      session.last_consolidated = value
      this.markDirty(sessionKey)
    }
  }

  // ==================================================================
  // 内部方法
  // ==================================================================

  private sessionDir(sessionKey: string): string {
    const safeKey = sessionKey.replace(/[:/]/g, '_')
    return join(this.sessionsDir, safeKey)
  }

  private messagesPath(sessionKey: string): string {
    return join(this.sessionDir(sessionKey), 'messages.jsonl')
  }

  private metaPath(sessionKey: string): string {
    return join(this.sessionDir(sessionKey), 'meta.json')
  }

  private loadSession(sessionKey: string): Session {
    const dir = this.sessionDir(sessionKey)
    const messagesPath = this.messagesPath(sessionKey)
    const metaPath = this.metaPath(sessionKey)

    if (!existsSync(dir)) return defaultSession(sessionKey)

    // 清理残留的 .tmp 文件
    this.cleanupStaleTmp(sessionKey)

    const meta = this.loadMeta(sessionKey)
    const messages: SessionMessageRecord[] = this.loadMessages(sessionKey)

    return {
      key: sessionKey,
      messages,
      created_at: meta?.created_at ?? new Date().toISOString(),
      updated_at: meta?.updated_at ?? new Date().toISOString(),
      metadata: meta?.metadata ?? {},
      last_consolidated: meta?.last_consolidated ?? 0,
    }
  }

  private loadMessages(sessionKey: string): SessionMessageRecord[] {
    const messagesPath = this.messagesPath(sessionKey)
    if (!existsSync(messagesPath)) return []

    const messages: SessionMessageRecord[] = []
    const text = readFileSync(messagesPath, 'utf-8')
    const lines = text.split('\n').filter((l) => l.trim())

    let skipped = 0
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as SessionMessageRecord
        messages.push(record)
      } catch {
        skipped++
      }
    }

    if (skipped > 0) {
      console.warn(`[SessionStore] Skipped ${skipped} corrupt line(s) in session ${sessionKey}`)
    }

    return messages
  }

  /**
   * 修复：尝试从损坏的 messages.jsonl 中恢复数据。
   */
  private repairSession(sessionKey: string): Session | null {
    const dir = this.sessionDir(sessionKey)
    if (!existsSync(dir)) return null

    const meta = this.loadMeta(sessionKey)
    const messages = this.loadMessages(sessionKey)

    if (messages.length === 0 && !meta) return null

    return {
      key: sessionKey,
      messages,
      created_at: meta?.created_at ?? new Date().toISOString(),
      updated_at: meta?.updated_at ?? new Date().toISOString(),
      metadata: meta?.metadata ?? {},
      last_consolidated: meta?.last_consolidated ?? 0,
    }
  }

  private cleanupStaleTmp(sessionKey: string): void {
    const dir = this.sessionDir(sessionKey)
    if (!existsSync(dir)) return

    const tmpPath = join(dir, 'messages.jsonl.tmp')
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
        console.warn(`[SessionStore] Cleaned up stale .tmp file for session ${sessionKey}`)
      } catch {
        // ignore
      }
    }
  }

  private loadMeta(sessionKey: string): SessionMeta | null {
    const fp = this.metaPath(sessionKey)
    if (!existsSync(fp)) return null
    try {
      const raw = JSON.parse(readFileSync(fp, 'utf-8'))
      return {
        created_at: raw.created_at ?? new Date().toISOString(),
        updated_at: raw.updated_at ?? new Date().toISOString(),
        last_consolidated: raw.last_consolidated ?? 0,
        metadata: raw.metadata ?? {},
      }
    } catch {
      return null
    }
  }

  /**
   * 原子写入：先写 .tmp 再 rename，避免文件损坏。
   * 当 fsync=true 时，显式刷新到磁盘（优雅关闭时使用）。
   */
  private writeSessionAtomic(sessionKey: string, session: Session, fsync = false): void {
    const dir = this.sessionDir(sessionKey)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    // 写入 meta.json
    const meta: SessionMeta = {
      created_at: session.created_at,
      updated_at: session.updated_at,
      last_consolidated: session.last_consolidated,
      metadata: session.metadata,
    }
    writeFileSync(this.metaPath(sessionKey), JSON.stringify(meta, null, 2), 'utf-8')

    // 原子写入 messages.jsonl
    const messagesPath = this.messagesPath(sessionKey)
    const tmpPath = join(dir, 'messages.jsonl.tmp')

    try {
      // 写入 .tmp
      const content = session.messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
      writeFileSync(tmpPath, content, 'utf-8')

      if (fsync) {
        // 显式 fsync .tmp 文件
        const fd = openSync(tmpPath, 'r')
        try {
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      }

      // 原子 rename
      renameSync(tmpPath, messagesPath)

      if (fsync) {
        // fsync 目录以使 rename 持久化
        try {
          const dirFd = openSync(dir, 'r')
          try {
            fsyncSync(dirFd)
          } finally {
            closeSync(dirFd)
          }
        } catch {
          // Windows: 目录 fsync 可能失败
        }
      }
    } catch (err) {
      // 清理残留 .tmp
      if (existsSync(tmpPath)) {
        try { unlinkSync(tmpPath) } catch { /* ignore */ }
      }
      throw err
    }
  }
}
