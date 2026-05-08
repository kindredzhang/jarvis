/**
 * AgentLoop —— 核心处理引擎
 *
 * 从 MessageBus 消费入站消息，构建上下文，执行 ReAct 循环，发布出站响应。
 * 这是连接所有子系统的顶层编排器。
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * 以下在 nanobot/agent/loop.py 中存在，本文件暂未实现：
 * - SessionManager / Session：完整的会话持久化体系（含 metadata、checkpoint、pending_user_turn）
 *   当前使用 SessionStore（轻量 JSONL 持久化）替代
 * - Consolidator：memory 固化（将对话总结写入 MEMORY.md）
 * - AutoCompact：auto_compact.check_expired + prepare_session
 * - Dream：dream 背景任务
 * - SubagentManager：subagent 分发与管理
 * - CommandRouter：斜杠命令路由（/stop, /compact 等）
 * - MCP 连接管理：_connect_mcp + mcp_stacks
 * - 并发门控：asyncio.Semaphore → 暂无等效实现
 * - 中继注入（mid-turn injection）：pending_queues → 暂无等效实现
 * - 运行时检查点：_set_runtime_checkpoint / _restore_runtime_checkpoint
 * - pending_user_turn 恢复：_restore_pending_user_turn
 * - CronService：定时任务
 * - 流式回调自动注册：_wants_stream metadata
 * - 通道级错误路由：channel-specific error handling
 * - _register_default_tools：文件/执行/web 工具类尚未移植
 * - SkillsLoader：技能加载
 * - render_template：模板渲染
 * - image_placeholder_text：图片暂存占位符
 * - 工具执行上下文设置：_set_tool_context
 * - Subagent follow-up 持久化：_persist_subagent_followup
 * - _sanitize_persisted_blocks：持久化前净化多模态内容
 * - processDirect 返回类型简化：暂不含 streaming metadata
 */

import type { LLMProvider } from '../providers/base'
import type { Message } from '../providers/types'
import { InboundMessage, type OutboundMessage } from '../bus'
import { ToolRegistry } from './tools/registry'
import { AgentRunner, type AgentRunSpec } from './runner'
import { ContextBuilder } from './context'
import { RUNTIME_CONTEXT_TAG, RUNTIME_CONTEXT_END } from './context'
import { MemoryStore } from './memory'
import { SessionStore, type SessionMessageRecord } from './session'
import { truncateText, stripThinkTags } from '../utils/helpers'
import {
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  ListDirTool,
  GlobTool,
  GrepTool,
  ExecTool,
  SpawnTool,
} from './tools'
import { CommandRouter } from '../command/router'
import { registerBuiltinCommands } from '../command/builtin'
import { Consolidator, Dream } from './consolidator'
import { SubagentManager } from './subagent'

// ---- 配置类型 ----

export interface AgentLoopConfig {
  /** 消息总线（可选，不传则不支持 run() 循环消费） */
  bus?: unknown
  /** LLM 提供方 */
  provider: LLMProvider
  /** 工作区根目录（用于记忆/会话存储和工具沙箱） */
  workspace: string
  /** 模型名称（默认取 provider 的默认模型） */
  model?: string
  /** 最大 ReAct 迭代次数 */
  maxIterations?: number
  /** 上下文窗口 token 上限（用于裁剪） */
  contextWindowTokens?: number
  /** 单个工具结果最大字符数（超过则截断） */
  maxToolResultChars?: number
  /** 提供方重试策略 */
  providerRetryMode?: string
  /** 时区（默认 'UTC'） */
  timezone?: string
  /** 禁用的技能列表 */
  disabledSkills?: string[]
  /** 最大历史条目数 */
  maxHistoryEntries?: number
}

/** 流式回调 */
export interface StreamCallbacks {
  onStream?: (delta: string) => Promise<void> | void
  onStreamEnd?: (resuming: boolean) => Promise<void> | void
  onProgress?: (
    content: string,
    opts?: { toolHint?: boolean; toolEvents?: Record<string, unknown>[] },
  ) => Promise<void> | void
  onRetryWait?: (content: string) => Promise<void> | void
}

// ---- AgentLoop 实现 ----

export class AgentLoop {
  readonly provider: LLMProvider
  readonly workspace: string

  model: string
  maxIterations: number
  maxToolResultChars: number
  contextWindowTokens: number

  readonly context: ContextBuilder
  readonly memory: MemoryStore
  readonly sessions: SessionStore
  readonly tools: ToolRegistry
  readonly runner: AgentRunner
  readonly commands: CommandRouter
  readonly consolidator: Consolidator
  readonly dream: Dream
  readonly subagents: SubagentManager


  private _running = false
  private _lastUsage: Record<string, number> = {}

  constructor(config: AgentLoopConfig) {
    this.provider = config.provider
    this.workspace = config.workspace
    this.model = config.model ?? config.provider.model
    this.maxIterations = config.maxIterations ?? 15
    this.maxToolResultChars = config.maxToolResultChars ?? 60_000
    this.contextWindowTokens = config.contextWindowTokens ?? 128_000

    this.memory = new MemoryStore(config.workspace, config.maxHistoryEntries ?? 1000)
    this.sessions = new SessionStore(config.workspace)
    this.tools = new ToolRegistry()
    this._registerDefaultTools()
    this.commands = new CommandRouter()
    registerBuiltinCommands(
      (cmd, handler) => this.commands.priorityCmd(cmd, handler),
      (cmd, handler) => this.commands.exactCmd(cmd, handler),
    )
    this.runner = new AgentRunner(config.provider)

    this.context = new ContextBuilder({
      workspace: config.workspace,
      memory: this.memory,
      timezone: config.timezone,
    })

    this.consolidator = new Consolidator({
      provider: config.provider,
      model: this.model,
      contextWindowTokens: this.contextWindowTokens,
    })
    this.dream = new Dream({
      store: this.memory,
      provider: config.provider,
      model: this.model,
    })

    this.subagents = new SubagentManager({
      provider: config.provider,
      workspace: config.workspace,
      model: this.model,
      maxToolResultChars: this.maxToolResultChars,
    })

    // SpawnTool 依赖 subagents，需在之后注册
    this.tools.register(new SpawnTool(this.subagents))

    // 子代理结果回调
    this.subagents.setOnResult((_taskId, result) => {
      console.log(`[Subagent] result:\n${result.slice(0, 200)}...`)
    })

    // 注册 /dream 命令
    this.commands.exactCmd('/dream', async (ctx) => {
      this.dream.run().then((didWork) => {
        console.log(`[Dream] ${didWork ? 'completed' : 'nothing to process'}`)
      }).catch((err) => {
        console.error(`[Dream] failed: ${err}`)
      })
      return {
        channel: ctx.channel,
        chatId: ctx.chatId,
        content: 'Dreaming...',
        metadata: { ...ctx.metadata },
        media: [],
        buttons: [],
      }
    })
  }

  /** 注册默认工具集 */
  private _registerDefaultTools(): void {
    this.tools.register(new ReadFileTool(this.workspace))
    this.tools.register(new WriteFileTool(this.workspace))
    this.tools.register(new EditFileTool(this.workspace))
    this.tools.register(new ListDirTool(this.workspace))
    this.tools.register(new GlobTool())
    this.tools.register(new GrepTool())
    this.tools.register(new ExecTool({ workingDir: this.workspace }))
  }

  // ---- 公共 API ----

  /**
   * 直接处理一条消息（不经由 MessageBus）
   * 适用于 CLI 等同步场景。
   */
  async processDirect(
    content: string,
    options?: {
      channel?: string
      chatId?: string
      sessionKey?: string
      callbacks?: StreamCallbacks
    },
  ): Promise<OutboundMessage | null> {
    const channel = options?.channel ?? 'cli'
    const chatId = options?.chatId ?? 'direct'
    const sessionKey = options?.sessionKey ?? `${channel}:${chatId}`

    const msg = new InboundMessage({
      channel,
      senderId: 'user',
      chatId,
      content,
    })

    return this.processMessage(msg, options?.callbacks, sessionKey)
  }

  /**
   * 处理单条入站消息，返回出站响应。
   *
   * 核心流程：
   * 1. 从 SessionStore 获取/创建会话
   * 2. 上下文构建（系统提示 + 历史 + 当前消息）
   * 3. AgentRunner 执行 ReAct 循环
   * 4. 保存本轮新消息到 SessionStore
   * 5. 返回 OutboundMessage
   */
  async processMessage(
    msg: InboundMessage,
    callbacks?: StreamCallbacks,
    sessionKeyOverride?: string,
  ): Promise<OutboundMessage | null> {
    const sessionKey =
      sessionKeyOverride ?? msg.sessionKey

    // 检查是否为斜杠命令
    const raw = msg.content.trim()
    if (this.commands.isPriority(raw)) {
      const priorityCtx = {
        raw,
        args: '',
        sessionKey,
        channel: msg.channel,
        chatId: msg.chatId,
        metadata: { ...(msg.metadata ?? {}) },
      }
      const priorityResult = await this.commands.dispatchPriority(priorityCtx)
      if (priorityResult) return priorityResult
    }
    if (this.commands.isDispatchableCommand(raw)) {
      const dispatchCtx = {
        raw,
        args: '',
        sessionKey,
        channel: msg.channel,
        chatId: msg.chatId,
        metadata: { ...(msg.metadata ?? {}) },
      }
      const cmdResult = await this.commands.dispatch(dispatchCtx)
      if (cmdResult) return cmdResult
    }

    // 1. 获取/创建会话历史
    const history = this.sessions.getHistory(sessionKey)

    // 1b. Consolidate 检查：如果历史消息超出 token 预算，先行归档
    // history 会被 maybeConsolidate 原地修改
    const didConsolidate = await this.consolidator.maybeConsolidate(history, () => {
      this.sessions.save(sessionKey)
    })

    // 1c. 复制历史用于上下文构建（consolidate 可能已修改 history 数组）
    const historyForContext: Record<string, unknown>[] = history.map((m) => ({ ...m }))

    // 2. 构建 LLM 消息列表
    const initialMessages = this.context.buildMessages({
      history: historyForContext,
      currentMessage: msg.content,
      channel: msg.channel,
      chatId: msg.chatId,
    })

    // 3. 构建 AgentRunSpec
    const spec: AgentRunSpec = {
      initialMessages,
      tools: this.tools,
      model: this.model,
      maxIterations: this.maxIterations,
      maxToolResultChars: this.maxToolResultChars,
      errorMessage: 'Sorry, I encountered an error calling the AI model.',
    }

    // 4. 执行 ReAct 循环
    const result = await this.runner.run(spec)
    this._lastUsage = result.usage ?? {}

    if (result.stopReason === 'max_iterations') {
      console.warn(`[AgentLoop] max iterations (${this.maxIterations}) reached`)
    } else if (result.stopReason === 'error') {
      console.error(
        `[AgentLoop] LLM error: ${(result.error ?? '').slice(0, 200)}`,
      )
    }

    // 5. 保存本轮新消息到 SessionStore
    // skip: 系统提示(1) + 已有历史(history.length)
    const skip = 1 + history.length
    this._saveTurn(sessionKey, result.messages, skip)

    // 6. 发送流式结束回调
    if (callbacks?.onStreamEnd) {
      await callbacks.onStreamEnd(result.stopReason !== 'max_iterations')
    }

    // 7. 构建出站消息
    const finalContent = AgentLoop.stripThink(result.finalContent) || ''
    if (!finalContent.trim() && result.stopReason !== 'tool_error') {
      return null
    }


    return {
      channel: msg.channel,
      chatId: msg.chatId,
      content: finalContent,
      media: [],
      metadata: { ...(msg.metadata ?? {}) },
      buttons: [],
    }
  }

  // ---- 内部方法 ----

  /**
   * 将本轮新消息保存到 SessionStore。
   * @param sessionKey 会话标识
   * @param messages 完整消息列表（由 AgentRunner 返回）
   * @param skip 跳过前 skip 条消息（系统提示 + 已有历史）
   */
  private _saveTurn(
    sessionKey: string,
    messages: Record<string, unknown>[],
    skip: number,
  ): void {
    for (const m of messages.slice(skip)) {
      const role = m.role as string
      const content = m.content
      // 跳过空 assistant 消息（没有 content 也没有 tool_calls）
      if (role === 'assistant' && !content && !m.tool_calls) continue

      const entry = {
        role,
        content: typeof content === 'string' ? content : content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id as string } : {}),
        ...(m.name ? { name: m.name as string } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        timestamp: new Date().toISOString(),
      } as SessionMessageRecord

      // 截断超长工具结果
      if (role === 'tool' && typeof entry.content === 'string') {
        if (entry.content.length > this.maxToolResultChars) {
          entry.content = truncateText(entry.content, this.maxToolResultChars)
        }
      }

      // 去掉运行时上下文标签
      if (
        role === 'user' &&
        typeof entry.content === 'string' &&
        entry.content.startsWith(RUNTIME_CONTEXT_TAG)
      ) {
        entry.content = this._stripRuntimeContext(entry.content)
      }

      this.sessions.appendMessage(sessionKey, entry)
    }
    this.sessions.save(sessionKey)
  }

  /**
   * 从 user 消息中去除运行时上下文片段。
   */
  private _stripRuntimeContext(content: string): string {
    const endPos = content.indexOf(RUNTIME_CONTEXT_END)
    if (endPos >= 0) {
      return content.slice(endPos + RUNTIME_CONTEXT_END.length).trimStart()
    }
    // 没有结束标记，去掉前缀标签
    const afterTag = content.slice(RUNTIME_CONTEXT_TAG.length).trim()
    return afterTag
  }

  /** 去除 thinking 标签包裹的内容（空安全） */
  static stripThink(text: string | null | undefined): string | null {
    if (!text) return null
    return stripThinkTags(text) || null
  }

  get lastUsage(): Record<string, number> {
    return { ...this._lastUsage }
  }
}