/**
 * MemoryStore —— 纯文件 I/O 记忆管理
 *
 * 负责管理 MEMORY.md / history.jsonl / SOUL.md / USER.md 等文件。
 * 提供 JSONL 格式的历史记录追加/读取/压缩及游标管理。
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * 以下功能在 nanobot/agent/memory.py 中存在，本文件暂未实现：
 * - GitStore 集成：文件修改后自动 git commit
 * - HISTORY.md 传统格式迁移：_maybe_migrate_legacy_history
 * - raw_archive 原始归档（依赖 strip_think + truncate_text）
 * - _format_messages 结构化消息格式化
 * - Consolidator 模块：token 预算触发的轻量级历史整合
 * - Dream 模块：两阶段 cron 调度的重量级记忆整合
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSONL } from '../utils/jsonl'
import { GitStore } from '../utils/gitstore'
import { truncateText, stripThinkTags } from '../utils/helpers'

/** 历史条目硬上限字符数 */
const HISTORY_ENTRY_HARD_CAP = 64_000

/** 历史记录条目 */
export interface HistoryRecord {
  cursor: number
  timestamp: string
  content: string
}

export class MemoryStore {
  readonly workspace: string
  readonly maxHistoryEntries: number

  readonly memoryDir: string
  readonly memoryFile: string
  readonly historyFile: string
  readonly soulFile: string
  readonly userFile: string

  readonly git: GitStore

  private cursorFile: string
  private dreamCursorFile: string

  private corruptionLogged = false
  private oversizeLogged = false

  constructor(workspace: string, maxHistoryEntries = 1000) {
    this.workspace = workspace
    this.maxHistoryEntries = maxHistoryEntries

    this.memoryDir = join(workspace, 'memory')
    this.memoryFile = join(this.memoryDir, 'MEMORY.md')
    this.historyFile = join(this.memoryDir, 'history.jsonl')
    this.soulFile = join(workspace, 'SOUL.md')
    this.userFile = join(workspace, 'USER.md')
    this.cursorFile = join(this.memoryDir, '.cursor')
    this.dreamCursorFile = join(this.memoryDir, '.dream_cursor')

    this.git = new GitStore(workspace, [
      'SOUL.md',
      'USER.md',
      'memory/MEMORY.md',
    ])

    mkdirSync(this.memoryDir, { recursive: true })

    // 初始化 Git 版本管理（非关键，失败不影响使用）
    try { this.git.init() } catch { /* git not available */ }
  }

  // ---- MEMORY.md（长期记忆） ----

  /** 读取长期记忆 */
  readMemory(): string {
    return this.readText(this.memoryFile)
  }

  /** 写入长期记忆 */
  writeMemory(content: string): void {
    writeFileSync(this.memoryFile, content, 'utf-8')
  }

  // ---- SOUL.md ----

  /** 读取 Soul 文件 */
  readSoul(): string {
    return this.readText(this.soulFile)
  }

  /** 写入 Soul 文件 */
  writeSoul(content: string): void {
    writeFileSync(this.soulFile, content, 'utf-8')
  }

  // ---- USER.md ----

  /** 读取用户画像 */
  readUser(): string {
    return this.readText(this.userFile)
  }

  /** 写入用户画像 */
  writeUser(content: string): void {
    writeFileSync(this.userFile, content, 'utf-8')
  }

  // ---- 上下文注入 ----

  /** 获取记忆上下文（用于 prompt 注入） */
  getMemoryContext(): string {
    const longTerm = this.readMemory()
    return longTerm ? '## Long-term Memory\n' + longTerm : ''
  }

  // ---- history.jsonl（追加式 JSONL 格式） ----

  /**
   * 追加历史条目，返回自增游标值
   *
   * 条目先经过 stripThinkTags 清洗掉内部推理输出，
   * 再应用 maxChars 上限截断。
   *
   * @param entry 条目原始文本
   * @param maxChars 可选字符上限（默认 64000）
   */
  appendHistory(entry: string, maxChars?: number): number {
    const limit = maxChars ?? HISTORY_ENTRY_HARD_CAP
    const cursor = this.nextCursor()
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
    let raw = entry.trimEnd()

    if (raw.length > limit) {
      if (!this.oversizeLogged) {
        this.oversizeLogged = true
        console.warn(`history entry exceeds ${limit} chars (${raw.length}); truncating`)
      }
      raw = truncateText(raw, limit)
    }

    const content = stripThinkTags(raw)
    const record: HistoryRecord = { cursor, timestamp: ts, content }
    JSONL.append(this.historyFile, record)
    writeFileSync(this.cursorFile, String(cursor), 'utf-8')
    return cursor
  }

  /** 读取指定游标之后的所有未处理历史条目 */
  readUnprocessedHistory(sinceCursor: number): HistoryRecord[] {
    return this.readValidEntries().filter((e) => e.cursor > sinceCursor)
  }

  /** 压缩历史——超过上限后保留最近的条目 */
  compactHistory(): void {
    if (this.maxHistoryEntries <= 0) return
    const entries = JSONL.readAll<HistoryRecord>(this.historyFile)
    if (entries.length <= this.maxHistoryEntries) return
    const kept = entries.slice(-this.maxHistoryEntries)
    JSONL.writeAll(this.historyFile, kept)
  }

  // ---- Dream 游标 ----

  /** 获取上次 Dream 处理的游标值 */
  getLastDreamCursor(): number {
    if (existsSync(this.dreamCursorFile)) {
      try {
        return parseInt(readFileSync(this.dreamCursorFile, 'utf-8').trim(), 10)
      } catch {
        // 游标文件损坏，降级
      }
    }
    return 0
  }

  /** 设置 Dream 游标值 */
  setLastDreamCursor(cursor: number): void {
    writeFileSync(this.dreamCursorFile, String(cursor), 'utf-8')
  }

  // ---- 内部方法 ----

  /** 读取所有有效历史条目（过滤损坏的记录） */
  private readValidEntries(): HistoryRecord[] {
    const entries = JSONL.readAll<HistoryRecord>(this.historyFile)
    return entries.filter((e) => {
      // Python: isinstance(True, int) is True, so filter booleans
      if (typeof e.cursor !== 'number' || !Number.isInteger(e.cursor)) {
        if (!this.corruptionLogged) {
          this.corruptionLogged = true
          console.warn(
            'history.jsonl contains invalid cursor (' +
            JSON.stringify(e.cursor) +
            '); dropping it',
          )
        }
        return false
      }
      return true
    })
  }

  /** 计算下一个游标值 */
  private nextCursor(): number {
    // 首先读游标文件
    if (existsSync(this.cursorFile)) {
      try {
        return parseInt(readFileSync(this.cursorFile, 'utf-8').trim(), 10) + 1
      } catch {
        // 降级：扫描文件
      }
    }
    // 从尾部读取最后一条记录
    const last = JSONL.readLast<HistoryRecord>(this.historyFile)
    if (last !== null && Number.isInteger(last.cursor)) {
      return last.cursor + 1
    }
    // 全量扫描求最大值
    const entries = this.readValidEntries()
    return entries.length > 0
      ? Math.max(...entries.map((e) => e.cursor)) + 1
      : 1
  }

  /** 读取文件，不存在返回空串 */
  private readText(path: string): string {
    try {
      return readFileSync(path, 'utf-8')
    } catch {
      return ''
    }
  }
}
