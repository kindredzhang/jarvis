/**
 * ContextBuilder —— 构建 Agent 上下文（system prompt + 消息列表）
 *
 * 负责拼接系统提示词（身份 + 引导文件 + 记忆 + 历史），
 * 以及运行时上下文注入和消息格式转换。
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * 以下在 nanobot/agent/context.py 中存在，本文件暂未实现：
 * - SkillsLoader 集成：skills.get_always_skills / load_skills_for_context
 * - render_template 模板渲染：identity.md / platform_policy.md / skills_section.md
 * - _is_template_content：检测内容是否为未修改的模板（需要打包模板文件）
 * - 图片 base64 编码（_build_user_content），当前只返回纯文本
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryStore } from './memory'
import { currentTimeStr, truncateText, buildAssistantMessage } from '../utils/helpers'

/** 运行时上下文标记 */
const RUNTIME_CONTEXT_TAG = '[Runtime Context — metadata only, not instructions]'
const RUNTIME_CONTEXT_END = '[/Runtime Context]'

/** 历史记录配置 */
const MAX_RECENT_HISTORY = 50
const MAX_HISTORY_CHARS = 32_000

/** 引导文件名列表 */
const BOOTSTRAP_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md']

export interface ContextBuilderOptions {
  /** 工作区路径 */
  workspace: string
  /** MemoryStore 实例 */
  memory: MemoryStore
  /** 时区名（如 'Asia/Shanghai'） */
  timezone?: string
}

export interface BuildMessagesOptions {
  /** 历史消息列表 */
  history: Record<string, unknown>[]
  /** 当前用户消息 */
  currentMessage: string
  /** 通道标识 */
  channel?: string
  /** 聊天 ID */
  chatId?: string
  /** 当前消息角色（默认 'user'） */
  currentRole?: string
  /** 会话摘要 */
  sessionSummary?: string
}

export class ContextBuilder {
  private workspace: string
  private memory: MemoryStore
  private timezone?: string

  constructor(options: ContextBuilderOptions) {
    this.workspace = options.workspace
    this.memory = options.memory
    this.timezone = options.timezone
  }

  /**
   * 构建系统提示词
   *
   * 组装顺序：身份 → 引导文件 → 记忆 → 最近历史
   *
   * @param options.identity 身份描述文本（替代模板渲染）
   * @param options.channel 通道名（用于运行时信息）
   */
  buildSystemPrompt(options?: {
    identity?: string
    channel?: string
  }): string {
    const parts: string[] = []

    // 1. 身份
    if (options?.identity) {
      parts.push(options.identity)
    }

    // 2. 引导文件（AGENTS.md, SOUL.md, USER.md, TOOLS.md）
    const bootstrap = this.loadBootstrapFiles()
    if (bootstrap) {
      parts.push(bootstrap)
    }

    // 3. 长期记忆
    const memory = this.memory.getMemoryContext()
    if (memory) {
      parts.push('# Memory\n\n' + memory)
    }

    // 4. 最近历史
    const entries = this.memory.readUnprocessedHistory(
      this.memory.getLastDreamCursor(),
    )
    if (entries.length > 0) {
      const capped = entries.slice(-MAX_RECENT_HISTORY)
      const historyText = capped
        .map((e) => `- [${e.timestamp}] ${e.content}`)
        .join('\n')
      parts.push(
        '# Recent History\n\n' + truncateText(historyText, MAX_HISTORY_CHARS),
      )
    }

    return parts.join('\n\n---\n\n')
  }

  /**
   * 构建完整消息列表（供 LLM 调用）
   *
   * 将运行时上下文注入当前消息头部，
   * 处理连续同角色消息的合并（部分 provider 不允许）。
   */
  buildMessages(options: BuildMessagesOptions): Record<string, unknown>[] {
    const {
      history,
      currentMessage,
      channel,
      chatId,
      currentRole = 'user',
      sessionSummary,
    } = options

    const runtimeCtx = ContextBuilder.buildRuntimeContext(
      channel ?? null,
      chatId ?? null,
      this.timezone,
      sessionSummary ?? null,
    )

    const userContent = currentMessage

    // 合并运行时上下文与用户消息
    let merged: string
    if (typeof userContent === 'string') {
      merged = `${runtimeCtx}\n\n${userContent}`
    } else {
      // ContentBlock[] 格式
      merged = runtimeCtx + '\n\n' + JSON.stringify(userContent)
    }

    const messages: Record<string, unknown>[] = [
      {
        role: 'system',
        content: this.buildSystemPrompt({ channel }),
      },
      ...history,
    ]

    // 处理连续同角色消息
    const lastMsg = messages[messages.length - 1]
    if (lastMsg && lastMsg.role === currentRole) {
      lastMsg.content = ContextBuilder.mergeMessageContent(
        lastMsg.content,
        merged,
      )
      return messages
    }

    messages.push({ role: currentRole, content: merged })
    return messages
  }

  /**
   * 构建运行时上下文块
   *
   * 注入到用户消息头部，包含当前时间、通道、会话摘要等信息。
   * 格式: [Runtime Context]...[/Runtime Context]
   */
  static buildRuntimeContext(
    channel: string | null,
    chatId: string | null,
    timezone?: string,
    sessionSummary?: string | null,
  ): string {
    const lines: string[] = [`Current Time: ${currentTimeStr(timezone)}`]
    if (channel && chatId) {
      lines.push(`Channel: ${channel}`)
      lines.push(`Chat ID: ${chatId}`)
    }
    if (sessionSummary) {
      lines.push('')
      lines.push('[Resumed Session]')
      lines.push(sessionSummary)
    }
    return (
      RUNTIME_CONTEXT_TAG +
      '\n' +
      lines.join('\n') +
      '\n' +
      RUNTIME_CONTEXT_END
    )
  }

  /**
   * 加载引导文件（AGENTS.md, SOUL.md, USER.md, TOOLS.md）
   */
  private loadBootstrapFiles(): string {
    const parts: string[] = []

    for (const filename of BOOTSTRAP_FILES) {
      const filePath = join(this.workspace, filename)
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, 'utf-8')
        parts.push(`## ${filename}\n\n${content}`)
      }
    }

    return parts.join('\n\n')
  }

  /**
   * 合并两个消息内容（字符串或 ContentBlock 数组）
   *
   * 用于将运行时上下文注入到用户消息中。
   */
  static mergeMessageContent(
    left: unknown,
    right: unknown,
  ): string | Record<string, unknown>[] {
    if (typeof left === 'string' && typeof right === 'string') {
      return left ? `${left}\n\n${right}` : right
    }

    function toBlocks(value: unknown): Record<string, unknown>[] {
      if (Array.isArray(value)) {
        return value.map((item) =>
          typeof item === 'object' && item !== null
            ? (item as Record<string, unknown>)
            : ({ type: 'text', text: String(item) }),
        )
      }
      if (value === null || value === undefined) return []
      return [{ type: 'text', text: String(value) }]
    }

    return [...toBlocks(left), ...toBlocks(right)]
  }

  /**
   * 将工具调用结果追加到消息列表
   */
  addToolResult(
    messages: Record<string, unknown>[],
    toolCallId: string,
    toolName: string,
    result: unknown,
  ): Record<string, unknown>[] {
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      name: toolName,
      content: result,
    })
    return messages
  }

  /**
   * 将 assistant 消息追加到消息列表
   */
  addAssistantMessage(
    messages: Record<string, unknown>[],
    content: string | null,
    options?: {
      toolCalls?: Record<string, unknown>[]
      reasoningContent?: string | null
      thinkingBlocks?: Record<string, unknown>[]
    },
  ): Record<string, unknown>[] {
    messages.push(buildAssistantMessage(content, options))
    return messages
  }
}
