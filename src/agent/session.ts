/**
 * SessionStore —— 轻量级会话持久化
 *
 * 管理每个 sessionKey 对应的消息列表（LLM 消息格式），
 * 持久化为 messages.jsonl（每个 sessionKey 对应一个目录）。
 *
 * ========= TODO: 与 nanobot 差异标注 ==========
 * 以下在 nanobot/agent/session.py SessionManager 中存在，本文件暂未实现：
 * - Session.metadata：运行时检查点、pending_user_turn 等元数据
 * - Session.updated_at / Session.created_at：时间戳管理
 * - Session.add_message()：支持关键字参数注入（sender_id, injected_event 等）
 * - Session.get_history()：支持 max_messages 截断 + 反序列化
 * - TTL 过期清理：session_ttl_minutes
 * - 自动压缩：与 Consolidator 联动
 * - 多会话目录管理：workspace/sessions/{key}/
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSONL } from '../utils/jsonl'

/** 会话记录（JSONL 单行） */
export interface SessionMessageRecord {
  /** 消息角色 */
  role: string
  /** 消息内容（string 或 ContentBlock[]） */
  content: unknown
  /** 工具调用 ID（tool 消息） */
  tool_call_id?: string
  /** 工具名称（tool 消息） */
  name?: string
  /** 工具调用列表（assistant 消息） */
  tool_calls?: unknown[]
  /** 时间戳 */
  timestamp?: string
  /** 额外字段 */
  [key: string]: unknown
}

export class SessionStore {
  private readonly workspace: string
  private readonly sessionsDir: string
  /** 内存缓存：sessionKey → 消息列表 */
  private cache: Map<string, SessionMessageRecord[]> = new Map()
  /** 脏标记：需要刷盘的 sessionKey */
  private dirty: Set<string> = new Set()

  constructor(workspace: string) {
    this.workspace = workspace
    this.sessionsDir = join(workspace, 'sessions')
  }

  /** 获取或创建会话 */
  getOrCreate(sessionKey: string): SessionMessageRecord[] {
    if (!this.cache.has(sessionKey)) {
      this.cache.set(sessionKey, this.loadFromDisk(sessionKey))
    }
    return this.cache.get(sessionKey)!
  }

  /** 标记会话为脏（需持久化） */
  markDirty(sessionKey: string): void {
    this.dirty.add(sessionKey)
  }

  /** 持久化脏会话到磁盘 */
  flush(): void {
    for (const key of this.dirty) {
      const messages = this.cache.get(key)
      if (messages) {
        this.writeToDisk(key, messages)
      }
    }
    this.dirty.clear()
  }

  /** 持久化单个会话 */
  save(sessionKey: string): void {
    const messages = this.cache.get(sessionKey)
    if (messages) {
      this.writeToDisk(sessionKey, messages)
      this.dirty.delete(sessionKey)
    }
  }

  /** 追加消息到会话 */
  appendMessage(sessionKey: string, msg: SessionMessageRecord): void {
    const messages = this.getOrCreate(sessionKey)
    messages.push(msg)
    this.markDirty(sessionKey)
  }

  /** 追加多条消息 */
  appendMessages(sessionKey: string, msgs: SessionMessageRecord[]): void {
    const messages = this.getOrCreate(sessionKey)
    messages.push(...msgs)
    this.markDirty(sessionKey)
  }

  /** 获取最近 N 条历史消息（供 LLM 调用） */
  getHistory(sessionKey: string, maxMessages = 0): SessionMessageRecord[] {
    const all = this.getOrCreate(sessionKey)
    if (maxMessages > 0 && all.length > maxMessages) {
      return all.slice(-maxMessages)
    }
    return all
  }

  // ---- 内部方法 ----

  /** 会话文件路径 */
  private filePath(sessionKey: string): string {
    // 将 sessionKey 中的 : 替换为 _，避免路径问题
    const safeKey = sessionKey.replace(/[:/]/g, '_')
    return join(this.sessionsDir, `${safeKey}.jsonl`)
  }

  /** 从磁盘加载会话 */
  private loadFromDisk(sessionKey: string): SessionMessageRecord[] {
    const fp = this.filePath(sessionKey)
    if (!existsSync(fp)) return []
    try {
      const records = JSONL.readAll(fp) as SessionMessageRecord[]
      return Array.isArray(records) ? records : []
    } catch {
      return []
    }
  }

  /** 写入磁盘 */
  private writeToDisk(sessionKey: string, messages: SessionMessageRecord[]): void {
    const fp = this.filePath(sessionKey)
    const dir = join(fp, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // 全量覆写（简单可靠）
    JSONL.writeAll(fp, messages)
  }
}
