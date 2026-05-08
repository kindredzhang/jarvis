/**
 * Consolidator —— token 预算触发器摘要归档 + Dream 记忆更新
 *
 * Consolidator：当对话上下文超预算时，将早期消息摘要归档到 history.jsonl。
 * Dream：后台处理未归档的历史条目，更新 MEMORY.md。
 *
 * ========= TODO: 与 Python 原版差异标注 =========
 * - token 估算使用 4 字符 ≈ 1 token 的经验公式（而非 tiktoken）
 * - Consolidator 无 session.last_consolidated 游标（直接截断 messages）
 * - Dream 无 GitStore 版本管理 / line_ages 标注 / AgentRunner Phase 2
 * - Dream 无 Phase 2 AgentRunner 编辑流程（当前仅 Phase 1 分析 + 直接写 MEMORY.md）
 * - 无 prompt 模板引擎（硬编码提示词）
 * - 无 SkillsLoader 技能列表
 */

import type { LLMProvider } from '../providers/base'
import type { SessionMessageRecord, Session } from './session'
import { SessionStore, retainRecentLegalSuffix } from './session'
import { MemoryStore } from './memory'
import { truncateText } from '../utils/helpers'
import { TemplateEngine } from '../utils/template'

// ---- 常量 ----

/** 安全缓冲（token） */
const SAFETY_BUFFER = 1024
/** 摘要最大字符 */
const SUMMARY_MAX_CHARS = 8_000
/** 原始归档最大字符 */
const RAW_ARCHIVE_MAX_CHARS = 16_000
/** Dream 单批最大处理条目 */
const DREAM_BATCH_SIZE = 20
/** Dream 历史条目预览上限（字符） */
const DREAM_ENTRY_PREVIEW_CHARS = 4_000
/** MEMORY.md 预览上限 */
const DREAM_MEMORY_CHARS = 32_000
/** SOUL.md/USER.md 预览上限 */
const DREAM_FILE_CHARS = 16_000

// ---- Consolidator ----

/**
 * 粗略估算消息的 token 数（4 字符 ≈ 1 token）
 */
function estimateMessageTokens(msg: Record<string, unknown>): number {
  const content = msg.content
  const contentLen = typeof content === 'string' ? content.length : 0
  return Math.ceil(contentLen / 4)
}

/**
 * 粗略估算完整消息列表的 token 数
 */
function estimatePromptTokens(messages: Record<string, unknown>[]): number {
  // 每条消息的开销（role + 结构字段等，约 20 tokens）
  let total = messages.length * 20
  for (const m of messages) {
    total += estimateMessageTokens(m)
  }
  return total
}

export class Consolidator {
  private provider: LLMProvider
  private model: string
  private contextWindowTokens: number

  constructor(options: {
    provider: LLMProvider
    model: string
    contextWindowTokens: number
  }) {
    this.provider = options.provider
    this.model = options.model
    this.contextWindowTokens = options.contextWindowTokens
  }

  get inputTokenBudget(): number {
    // 预留 completion tokens + 安全缓冲
    return this.contextWindowTokens - 4096 - SAFETY_BUFFER
  }

  /**
   * 检查并执行消息摘要归档
   * @returns 是否执行了归档操作
   */
  async maybeConsolidate(
    messages: SessionMessageRecord[],
    onsessMessagesUpdated: (msgs: SessionMessageRecord[]) => void,
  ): Promise<boolean> {
    if (messages.length === 0 || this.contextWindowTokens <= 0) return false

    const budget = this.inputTokenBudget
    if (budget <= 0) return false

    const estimated = estimatePromptTokens(messages as Record<string, unknown>[])
    // 低于预算则无需归档
    if (estimated < budget) return false

    const target = Math.floor(budget / 2)
    if (estimated <= target) return false

    // 找到需要归档的用户轮次
    // 从第 1 条非 system 消息开始计算
    const maxRounds = 5
    let lastSummary: string | null = null
    let consolidated = false

    for (let round = 0; round < maxRounds; round++) {
      // 取前 1/3 的消息作为归档候选
      const cutIdx = Math.max(1, Math.floor(messages.length / 3))
      const chunk = messages.slice(0, cutIdx)

      if (chunk.length <= 1) break

      const summary = await this.archive(chunk)
      if (summary) {
        lastSummary = summary
      }

      // 替换已归档消息
      const replacement: SessionMessageRecord = {
        role: 'system',
        content: `[Consolidated: ${this._formatMessages(chunk)}]`,
        timestamp: new Date().toISOString(),
      }
      messages.splice(0, cutIdx, replacement)
      onsessMessagesUpdated(messages)

      consolidated = true

      // 再次估算
      const newEstimated = estimatePromptTokens(messages as Record<string, unknown>[])
      if (newEstimated <= target) break
      if (!summary) break // LLM 降级，停止
    }

    return consolidated
  }

  /**
   * 将一批消息发送给 LLM 摘要（公开方法，供 AutoCompact 调用）
   */
  async archive(chunk: SessionMessageRecord[]): Promise<string | null> {
    try {
      const formatted = this._formatMessages(chunk)
      const truncated = truncateText(formatted, RAW_ARCHIVE_MAX_CHARS)

      const response = await this.provider.generate(
        [
          {
            role: 'system',
            content: 'You are a memory consolidation system. Your job is to summarize a conversation chunk into a concise archive entry. Preserve key facts, decisions, user preferences, and task outcomes. Omit small talk, pleasantries, and redundant exchanges. The summary will be stored as an archive reference, not shown to the user directly. Write in 3-5 sentences.',
          },
          { role: 'user', content: truncated },
        ],
        {
          settings: { maxTokens: 2048 },
        },
      )

      if (response.finishReason === 'error') {
        throw new Error(`LLM returned error: ${response.content}`)
      }

      const summary = response.content?.trim() ?? ''
      if (summary) {
        return summary
      }
      return null
    } catch {
      return null
    }
  }

  private _formatMessages(messages: SessionMessageRecord[]): string {
    return messages
      .filter((m) => m.content && typeof m.content === 'string')
      .map((m) => {
        const ts = (m.timestamp ?? '?').slice(0, 16)
        const role = (m.role ?? '?').toUpperCase()
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        return `[${ts}] ${role}: ${content}`
      })
      .join('\n')
  }
}

// ---- AutoCompact ----

/**
 * AutoCompact — 空闲会话主动压缩
 *
 * 从 Python 原版 autocompact.py 移植。
 * 当会话 TTL 过期时，将未归档的前缀消息发送给 Consolidator 做摘要，
 * 摘要存入 session.metadata._last_summary，消息列表替换为保留的后缀。
 */
export class AutoCompact {
  private static RECENT_SUFFIX_MESSAGES = 8

  private sessions: SessionStore
  private consolidator: Consolidator
  private ttlMinutes: number
  private archiving: Set<string> = new Set()
  private summaries: Map<string, { text: string; lastActive: Date }> = new Map()

  constructor(
    sessions: SessionStore,
    consolidator: Consolidator,
    sessionTtlMinutes = 0,
  ) {
    this.sessions = sessions
    this.consolidator = consolidator
    this.ttlMinutes = sessionTtlMinutes
  }

  /** 检查时间戳是否已超过 TTL */
  private isExpired(ts: string | Date | null | undefined, now?: Date): boolean {
    if (this.ttlMinutes <= 0 || !ts) return false
    const date = typeof ts === 'string' ? new Date(ts) : ts
    const n = now ?? new Date()
    return (n.getTime() - date.getTime()) / 1000 >= this.ttlMinutes * 60
  }

  /** 格式化摘要文本 */
  static formatSummary(text: string, lastActive: Date): string {
    const idleMin = Math.floor(
      (Date.now() - lastActive.getTime()) / 60000,
    )
    return `Inactive for ${idleMin} minutes.\nPrevious conversation summary: ${text}`
  }

  /** 将会话尾部拆分为: [需归档前缀, 保留后缀] */
  private splitUnconsolidated(
    session: Session,
  ): [SessionMessageRecord[], SessionMessageRecord[]] {
    const tail = session.messages.slice(session.last_consolidated)
    if (tail.length === 0) return [[], []]

    // 创建探针会话，调用 retainRecentLegalSuffix 确定保留后缀
    const probe: Session = {
      key: session.key,
      messages: [...tail],
      created_at: session.created_at,
      updated_at: session.updated_at,
      metadata: {},
      last_consolidated: 0,
    }
    retainRecentLegalSuffix(probe, AutoCompact.RECENT_SUFFIX_MESSAGES)
    const kept = probe.messages
    const cut = tail.length - kept.length
    return [tail.slice(0, cut), kept]
  }

  /**
   * 检查过期会话并调度后台归档
   * @param scheduleBackground 回调，接收一个 Promise，由调用方负责调度执行
   * @param activeSessionKeys 活跃会话键集合（跳过正在处理中的会话）
   */
  checkExpired(
    scheduleBackground: (task: Promise<void>) => void,
    activeSessionKeys: Set<string> | string[] = [],
  ): void {
    const activeSet =
      activeSessionKeys instanceof Set
        ? activeSessionKeys
        : new Set(activeSessionKeys)

    const now = new Date()
    for (const info of this.sessions.listSessions()) {
      const key = info.key
      if (!key || this.archiving.has(key)) continue
      if (activeSet.has(key)) continue
      if (this.isExpired(info.updated_at, now)) {
        this.archiving.add(key)
        scheduleBackground(this.archive(key))
      }
    }
  }

  /** 归档单个会话的过期前缀消息 */
  private async archive(key: string): Promise<void> {
    try {
      this.sessions.invalidate(key)
      const session = this.sessions.getOrCreate(key)
      const [archiveMsgs, keptMsgs] = this.splitUnconsolidated(session)

      if (archiveMsgs.length === 0 && keptMsgs.length === 0) {
        session.updated_at = new Date().toISOString()
        this.sessions.save(key)
        return
      }

      const lastActive = new Date(session.updated_at)
      let summary = ''
      if (archiveMsgs.length > 0) {
        summary = (await this.consolidator.archive(archiveMsgs)) ?? ''
      }
      if (summary && summary !== '(nothing)') {
        this.summaries.set(key, { text: summary, lastActive })
        session.metadata._last_summary = {
          text: summary,
          last_active: lastActive.toISOString(),
        }
      }
      session.messages = keptMsgs
      session.last_consolidated = 0
      session.updated_at = new Date().toISOString()
      this.sessions.save(key)

      if (archiveMsgs.length > 0) {
        console.info(
          `Auto-compact: archived ${key} (archived=${archiveMsgs.length}, ` +
          `kept=${keptMsgs.length}, summary=${!!summary})`,
        )
      }
    } catch (err) {
      console.error(`Auto-compact: failed for ${key}:`, err)
    } finally {
      this.archiving.delete(key)
    }
  }

  /**
   * 在处理消息前准备会话：弹出待处理的摘要。
   * @returns [session, summaryText | null]
   */
  prepareSession(
    session: Session,
    key: string,
  ): { session: Session; summary: string | null } {
    if (this.archiving.has(key) || this.isExpired(session.updated_at)) {
      console.info(
        `Auto-compact: reloading session ${key} (archiving=${this.archiving.has(key)})`,
      )
      session = this.sessions.getOrCreate(key)
    }

    // 热路径：从内存字典获取摘要（进程未重启）
    const entry = this.summaries.get(key)
    if (entry) {
      this.summaries.delete(key)
      session.metadata._last_summary = undefined
      delete session.metadata._last_summary
      return {
        session,
        summary: AutoCompact.formatSummary(entry.text, entry.lastActive),
      }
    }

    // 冷路径：从磁盘元数据恢复摘要
    if (session.metadata._last_summary) {
      const meta = session.metadata._last_summary as {
        text: string
        last_active: string
      }
      session.metadata._last_summary = undefined
      delete session.metadata._last_summary
      this.sessions.save(key)
      return {
        session,
        summary: AutoCompact.formatSummary(
          meta.text,
          new Date(meta.last_active),
        ),
      }
    }

    return { session, summary: null }
  }
}

// ---- Dream ----

export class Dream {
  private store: MemoryStore
  private provider: LLMProvider
  private model: string

  constructor(options: {
    store: MemoryStore
    provider: LLMProvider
    model: string
  }) {
    this.store = options.store
    this.provider = options.provider
    this.model = options.model
  }

  /**
   * 处理未归档的历史条目，更新 MEMORY.md。
   * @returns 是否执行了工作
   */
  async run(): Promise<boolean> {
    const lastCursor = this.store.getLastDreamCursor()
    const entries = this.store.readUnprocessedHistory(lastCursor)
    if (entries.length === 0) return false

    const batch = entries.slice(0, DREAM_BATCH_SIZE)
    const lastEntry = batch[batch.length - 1]
    const newCursor = lastEntry?.cursor ?? lastCursor

    // 构建历史文本
    const historyText = batch
      .map((e) => `[${e.timestamp}] ${truncateText(e.content, DREAM_ENTRY_PREVIEW_CHARS)}`)
      .join('\n')

    // 当前文件内容
    const currentDate = new Date().toISOString().slice(0, 10)
    const rawMemory = this.store.readMemory() || '(empty)'
    const currentMemory = truncateText(rawMemory, DREAM_MEMORY_CHARS)
    const currentSoul = truncateText(this.store.readSoul() || '(empty)', DREAM_FILE_CHARS)
    const currentUser = truncateText(this.store.readUser() || '(empty)', DREAM_FILE_CHARS)

    const fileContext = [
      `## Current Date\n${currentDate}\n`,
      `## Current MEMORY.md (${currentMemory.length} chars)\n${currentMemory}\n`,
      `## Current SOUL.md (${currentSoul.length} chars)\n${currentSoul}\n`,
      `## Current USER.md (${currentUser.length} chars)\n${currentUser}`,
    ].join('\n\n')

    // Phase 1: 分析
    const phase1Prompt = `## Conversation History\n${historyText}\n\n${fileContext}`

    let analysis: string
    try {
      const response = await this.provider.generate([
        { role: 'system', content: 'You are a memory management system. Analyze the conversation history and current memory files. Your task: identify new information that should be recorded, outdated information to remove, and produce a complete new MEMORY.md or output NO_CHANGES.' },
        { role: 'user', content: phase1Prompt },
      ])
      analysis = response.content?.trim() ?? ''
      if (!analysis) return false
    } catch {
      return false
    }

    // Phase 2（简化版）：直接写 MEMORY.md

    // 检查 LLM 分析结果是否表明无需变更
    const noChanges = analysis.includes('NO_CHANGES') || analysis.includes('no changes needed')
    if (noChanges) {
      this.store.setLastDreamCursor(newCursor)
      this.store.compactHistory()
      return false
    }
    try {
      const newMemory = this._applyAnalysisToMemory(analysis, rawMemory)
      if (newMemory && newMemory !== rawMemory) {
        this.store.writeMemory(newMemory)
        // Git auto-commit
        try {
          if (this.store.git.isInitialized()) {
            const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
            this.store.git.autoCommit(`dream: ${ts}, memory updated`)
          }
        } catch {
          // auto-commit failure is non-fatal
        }
        this.store.setLastDreamCursor(newCursor)
        this.store.compactHistory()
        return true
      }
    } catch {
      // Phase 2 失败，仍前进游标避免重复处理
      this.store.setLastDreamCursor(newCursor)
      this.store.compactHistory()
      return false
    }

    this.store.setLastDreamCursor(newCursor)
    this.store.compactHistory()
    return true
  }

  /**
   * 将分析结果应用到 MEMORY.md
   * 简化版：直接使用分析结果替换 MEMORY.md
   */
  private _applyAnalysisToMemory(analysis: string, _currentMemory: string): string {
    // 从分析结果中提取 MEMORY.md 内容
    // 查找 ~~~markdown 或 ### 开头的段落
    const lines = analysis.split('\n')
    const memoryLines: string[] = []
    let inMemory = false

    for (const line of lines) {
      if (line.includes('~~~') || line.startsWith('```')) {
        inMemory = !inMemory
        continue
      }
      if (inMemory) {
        memoryLines.push(line)
      }
    }

    if (memoryLines.length > 0) {
      return memoryLines.join('\n').trim()
    }

    // 没有 markdown 代码块，直接用分析结果
    return analysis
  }
}

