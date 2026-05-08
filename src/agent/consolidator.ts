/**
 * Consolidator —— token 预算触发器摘要归档 + Dream 记忆更新
 *
 * Consolidator：当对话上下文超预算时，将早期消息摘要归档到 history.jsonl。
 * Dream：后台处理未归档的历史条目，更新 MEMORY.md。
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * - token 估算使用 4 字符 ≈ 1 token 的经验公式（而非 tiktoken）
 * - Consolidator 无 session.last_consolidated 游标（直接截断 messages）
 * - Dream 无 GitStore 版本管理 / line_ages 标注 / AgentRunner Phase 2
 * - Dream 无 Phase 2 AgentRunner 编辑流程（当前仅 Phase 1 分析 + 直接写 MEMORY.md）
 * - 无 prompt 模板引擎（硬编码提示词）
 * - 无 SkillsLoader 技能列表
 */

import type { LLMProvider } from '../providers/base'
import type { SessionMessageRecord } from './session'
import { MemoryStore } from './memory'
import { truncateText } from '../utils/helpers'

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

      const summary = await this._archive(chunk)
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
   * 将一批消息发送给 LLM 摘要
   */
  private async _archive(chunk: SessionMessageRecord[]): Promise<string | null> {
    try {
      const formatted = this._formatMessages(chunk)
      const truncated = truncateText(formatted, RAW_ARCHIVE_MAX_CHARS)

      const response = await this.provider.generate(
        [
          {
            role: 'system',
            content: CONSOLIDATOR_SYSTEM_PROMPT,
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
        { role: 'system', content: DREAM_PHASE1_PROMPT },
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

// ---- 提示词 ----

const CONSOLIDATOR_SYSTEM_PROMPT = `You are a memory consolidation system. Your job is to summarize a conversation chunk into a concise archive entry. Preserve key facts, decisions, user preferences, and task outcomes. Omit small talk, pleasantries, and redundant exchanges. The summary will be stored as an archive reference, not shown to the user directly. Write in 3-5 sentences.`

const DREAM_PHASE1_PROMPT = `You are a memory management system. Analyze the conversation history and current memory files. Your task:

1. Identify new information in the conversation history that should be recorded in MEMORY.md (long-term facts, user preferences, important decisions).
2. Identify information in MEMORY.md that is outdated or contradicted by the new conversation.
3. If changes are needed, output a complete new MEMORY.md wrapped in a ~~~markdown code block.
4. If no changes are needed, output "NO_CHANGES".

Focus on durable facts, not transient topics. Keep the writing concise and informative.`
