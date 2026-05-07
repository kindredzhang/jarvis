/**
 * AgentRunner —— ReAct 循环执行器
 *
 * 执行 "LLM 调用 → 工具执行 → 结果反馈 → LLM 再调用" 的循环，
 * 直到 LLM 返回最终响应或达到最大迭代次数。
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * 以下在 nanobot/agent/runner.py 中存在，本文件暂未实现：
 * - AgentHook 系统：before_iteration / after_iteration / on_stream 等生命周期钩子
 * - 流式输出：hook.wants_streaming() + provider.chat_stream_with_retry
 * - 注入系统：mid-turn user message injection via injection_callback
 * - 空响应重试：_MAX_EMPTY_RETRIES + _request_finalization_retry
 * - length 恢复：_MAX_LENGTH_RECOVERIES + build_length_recovery_message
 * - 上下文窗口裁剪：_snip_history（需要 token 估算）
 * - 工具结果持久化：maybe_persist_tool_result + ensure_nonempty_tool_result
 * - 重复外部查找拦截：repeated_external_lookup_error
 * - 检查点回调：checkpoint_callback / _emit_checkpoint
 * - 进度回调：progress_callback
 * - 模型错误占位符：_PERSISTED_MODEL_ERROR_PLACEHOLDER
 */

import type { LLMProvider } from '../providers/base'
import type { LLMResponse, ToolCallRequest } from '../providers/types'
import type { ToolRegistry } from './tools/registry'
import { truncateText, buildAssistantMessage } from '../utils/helpers'

// ---- 类型定义 ----

/** 单次 Agent 执行的配置 */
export interface AgentRunSpec {
  /** 初始消息列表（含 system prompt） */
  initialMessages: Record<string, unknown>[]
  /** 工具注册表 */
  tools: ToolRegistry
  /** 模型名 */
  model: string
  /** 最大迭代次数 */
  maxIterations: number
  /** 工具结果最大字符数 */
  maxToolResultChars: number
  /** 温度 */
  temperature?: number
  /** 最大输出 token */
  maxTokens?: number
  /** 推理力度（DeepSeek-R1 等） */
  reasoningEffort?: string | null
  /** 出错时展示的消息 */
  errorMessage?: string
  /** 达到最大迭代时的消息 */
  maxIterationsMessage?: string
  /** 工具错误时是否中止 */
  failOnToolError?: boolean
  /** 当前时间戳信息（注入 runtime context） */
  runtimeContext?: string
}

/** 单次 Agent 执行的结果 */
export interface AgentRunResult {
  /** 最终响应文本 */
  finalContent: string | null
  /** 完整消息列表（含所有工具调用） */
  messages: Record<string, unknown>[]
  /** 使用过的工具名列表 */
  toolsUsed: string[]
  /** Token 用量统计 */
  usage: { promptTokens: number; completionTokens: number }
  /** 停止原因 */
  stopReason: 'completed' | 'max_iterations' | 'error' | 'tool_error'
  /** 错误信息 */
  error: string | null
}

// ---- 常量 ----

const DEFAULT_ERROR_MESSAGE = 'Sorry, I encountered an error calling the AI model.'

/** 需要微压缩的工具（结果较长时替换为摘要） */
const COMPACTABLE_TOOLS = new Set([
  'read_file', 'exec', 'grep', 'glob',
  'web_search', 'web_fetch', 'list_dir',
])

/** 微压缩保留的最近条目数 */
const MICROCOMPACT_KEEP_RECENT = 10
/** 微压缩的最小字符数（短结果不压缩） */
const MICROCOMPACT_MIN_CHARS = 500

/** 缺失工具结果的占位消息 */
const BACKFILL_CONTENT = '[Tool result unavailable — call was interrupted or lost]'

// ---- AgentRunner ----

export class AgentRunner {
  constructor(private provider: LLMProvider) {}

  /**
   * 执行 ReAct 循环
   */
  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    const messages = [...spec.initialMessages]
    let finalContent: string | null = null
    const toolsUsed: string[] = []
    const usage = { promptTokens: 0, completionTokens: 0 }
    let error: string | null = null
    let stopReason: AgentRunResult['stopReason'] = 'completed'

    for (let iteration = 0; iteration < spec.maxIterations; iteration++) {
      // 上下文治理：清理 + 压缩 + 截断
      let modelMessages = AgentRunner.dropOrphanToolResults(messages)
      modelMessages = AgentRunner.backfillMissingToolResults(modelMessages)
      modelMessages = AgentRunner.microcompact(modelMessages)
      modelMessages = AgentRunner.applyToolResultBudget(
        spec,
        modelMessages,
      )

      // 调用 LLM
      const response = await this.requestModel(spec, modelMessages)

      // 累积用量
      if (response.usage) {
        usage.promptTokens += response.usage.promptTokens
        usage.completionTokens += response.usage.completionTokens
      }

      // 工具调用分支
      if (
        response.toolCalls.length > 0 &&
        (response.finishReason === 'tool_calls' || response.finishReason === 'stop')
      ) {
        // 构建 assistant 消息（含工具调用）
        const assistantMsg = buildAssistantMessage(
          response.content ?? '',
          {
            toolCalls: response.toolCalls.map((tc) => ({
              id: tc.id,
              type: tc.type,
              function: tc.function,
            })),
            reasoningContent: response.reasoningContent,
          },
        )
        messages.push(assistantMsg)
        for (const tc of response.toolCalls) {
          toolsUsed.push(tc.function.name)
        }

        // 执行工具
        const { results, fatalError } = await this.executeTools(
          spec,
          response.toolCalls,
        )

        // 追加工具结果到消息列表
        for (let i = 0; i < response.toolCalls.length; i++) {
          const tc = response.toolCalls[i]
          const result = results[i]
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: this.normalizeToolResult(spec, tc.id, tc.function.name, result),
          })
        }

        if (fatalError) {
          error = `Error: ${fatalError}`
          finalContent = error
          stopReason = 'tool_error'
          break
        }

        // 继续下一轮迭代
        continue
      }

      // 如有 tool_calls 但不该执行（finish_reason 异常），忽略警告后继续
      if (response.toolCalls.length > 0) {
        // 不执行，视为普通响应
      }

      // 处理错误响应
      if (response.finishReason === 'error') {
        const errContent = response.content || spec.errorMessage || DEFAULT_ERROR_MESSAGE
        finalContent = errContent
        stopReason = 'error'
        error = typeof errContent === 'string' ? errContent : String(errContent)
        break
      }

      // 正常完成
      const clean = response.content ?? ''
      if (!clean || clean.trim() === '') {
        finalContent = '[Empty response from model]'
        stopReason = 'error'
        error = finalContent
        break
      }

      const assistantMsg = buildAssistantMessage(clean, {
        reasoningContent: response.reasoningContent,
      })
      messages.push(assistantMsg)
      finalContent = clean
      stopReason = 'completed'
      break
    }

    // 达到最大迭代次数
    if (finalContent === null) {
      stopReason = 'max_iterations'
      finalContent =
        spec.maxIterationsMessage ??
        `[Reached max iterations (${spec.maxIterations}) without final response]`
    }

    return {
      finalContent,
      messages,
      toolsUsed,
      usage,
      stopReason,
      error,
    }
  }

  /**
   * 调用 LLM 模型
   */
  private async requestModel(
    spec: AgentRunSpec,
    messages: Record<string, unknown>[],
  ): Promise<LLMResponse> {
    const toolDefs = spec.tools.getDefinitions()

    return this.provider.generate(
      messages as any, // Message 类型兼容
      {
        tools: toolDefs as any,
        settings: {
          temperature: spec.temperature,
          maxTokens: spec.maxTokens,
          reasoningEffort: spec.reasoningEffort,
        },
      },
    )
  }

  /**
   * 执行一组工具调用
   *
   * 使用 prepareCall 做参数校验 + 类型转换，然后直接调用 tool.execute。
   * 这样工具内部的异常能正确抛出，被 failOnToolError 捕获。
   */
  private async executeTools(
    spec: AgentRunSpec,
    toolCalls: ToolCallRequest[],
  ): Promise<{ results: unknown[]; fatalError: Error | null }> {
    const results: unknown[] = []
    let fatalError: Error | null = null

    for (const tc of toolCalls) {
      try {
        // 解析工具参数（JSON 字符串 → 对象）
        let args: Record<string, unknown>
        try {
          args = JSON.parse(tc.function.arguments)
        } catch {
          args = {}
        }

        const { tool, params, error } = spec.tools.prepareCall(
          tc.function.name,
          args,
        )
        if (error || !tool) {
          const errMsg = error ?? `Tool '${tc.function.name}' not found`
          if (spec.failOnToolError) {
            fatalError = new Error(errMsg)
            results.push(errMsg)
            break
          }
          results.push(errMsg)
          continue
        }

        const result = await tool.execute(params)
        results.push(result)
      } catch (err) {
        const errorMsg = `Error: ${err instanceof Error ? err.message : String(err)}`
        if (spec.failOnToolError) {
          fatalError = err instanceof Error ? err : new Error(String(err))
          results.push(errorMsg)
          break
        }
        results.push(errorMsg)
      }
    }

    return { results, fatalError }
  }

  /**
   * 标准化工具结果（应用字符上限截断）
   */
  private normalizeToolResult(
    spec: AgentRunSpec,
    toolCallId: string,
    toolName: string,
    result: unknown,
  ): unknown {
    const content = typeof result === 'string' ? result : JSON.stringify(result)
    if (content.length > spec.maxToolResultChars) {
      return truncateText(content, spec.maxToolResultChars)
    }
    return content
  }

  // ========== 上下文治理（静态方法，便于测试） ==========

  /**
   * 移除没有对应 assistant tool_call 的孤立工具结果
   */
  static dropOrphanToolResults(
    messages: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const declared = new Set<string>()
    const updated: Record<string, unknown>[] = []

    for (const msg of messages) {
      const role = msg.role as string
      if (role === 'assistant') {
        const tcs = msg.tool_calls as Record<string, unknown>[] | undefined
        if (tcs) {
          for (const tc of tcs) {
            const id = tc.id as string | undefined
            if (id) declared.add(id)
          }
        }
      }
    }

    for (const msg of messages) {
      const role = msg.role as string
      if (role === 'tool') {
        const tid = msg.tool_call_id as string | undefined
        if (tid && !declared.has(tid)) {
          continue // 跳过孤立条目
        }
      }
      updated.push({ ...msg })
    }

    return updated
  }

  /**
   * 为没有对应工具结果的 tool_use 插入占位错误消息
   */
  static backfillMissingToolResults(
    messages: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    // 收集已声明的 tool_call_id 和已满足的 tool_call_id
    const declared: { index: number; id: string; name: string }[] = []
    const fulfilled = new Set<string>()

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      const role = msg.role as string
      if (role === 'assistant') {
        const tcs = msg.tool_calls as Record<string, unknown>[] | undefined
        if (tcs) {
          for (const tc of tcs) {
            const id = tc.id as string | undefined
            if (id) {
              const fn = tc.function as Record<string, unknown> | undefined
              const name = (fn?.name as string) ?? ''
              declared.push({ index: i, id, name })
            }
          }
        }
      } else if (role === 'tool') {
        const tid = msg.tool_call_id as string | undefined
        if (tid) fulfilled.add(tid)
      }
    }

    const missing = declared.filter((d) => !fulfilled.has(d.id))
    if (missing.length === 0) return messages

    const updated = [...messages]
    let offset = 0
    for (const { index, id, name } of missing) {
      const insertAt = index + 1 + offset
      updated.splice(insertAt, 0, {
        role: 'tool',
        tool_call_id: id,
        name,
        content: BACKFILL_CONTENT,
      })
      offset++
    }

    return updated
  }

  /**
   * 微压缩：将旧的可压缩工具结果替换为摘要行
   */
  static microcompact(
    messages: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const compactableIndices: number[] = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (
        msg.role === 'tool' &&
        msg.name &&
        COMPACTABLE_TOOLS.has(msg.name as string)
      ) {
        compactableIndices.push(i)
      }
    }

    if (compactableIndices.length <= MICROCOMPACT_KEEP_RECENT) return messages

    const stale = compactableIndices.slice(
      0,
      compactableIndices.length - MICROCOMPACT_KEEP_RECENT,
    )
    const updated = messages.map((m) => ({ ...m }))

    for (const idx of stale) {
      const msg = updated[idx]
      const content = msg.content as string | undefined
      if (
        typeof content !== 'string' ||
        content.length < MICROCOMPACT_MIN_CHARS
      ) {
        continue
      }
      const toolName = (msg.name as string) ?? 'tool'
      updated[idx] = {
        ...msg,
        content: `[${toolName} result omitted from context]`,
      }
    }

    return updated
  }

  /**
   * 应用工具结果字符上限（截断过长结果）
   */
  static applyToolResultBudget(
    spec: AgentRunSpec,
    messages: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const updated = messages.map((msg) => {
      if (msg.role !== 'tool') return msg
      const content = msg.content
      if (typeof content === 'string' && content.length > spec.maxToolResultChars) {
        return { ...msg, content: truncateText(content, spec.maxToolResultChars) }
      }
      return msg
    })
    return updated
  }
}
