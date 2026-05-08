/**
 * AgentRunner —— ReAct 循环执行器
 *
 * 执行 "LLM 调用 → 工具执行 → 结果反馈 → LLM 再调用" 的循环，
 * 直到 LLM 返回最终响应或达到最大迭代次数。
 *
 * 从 Python 原版 runner.py 移植。
 */

import type { LLMProvider } from '../providers/base'
import type { LLMResponse, ToolCallRequest } from '../providers/types'
import type { ToolRegistry } from './tools/registry'
import { AgentHook, type AgentHookContext, type ToolEvent } from './hook'
import {
  truncateText,
  buildAssistantMessage,
  isBlankText,
  buildFinalizationRetryMessage,
  buildLengthRecoveryMessage,
  ensureNonemptyToolResult,
  repeatedExternalLookupError,
  EMPTY_FINAL_RESPONSE_MESSAGE,
  findLegalMessageStart,
} from '../utils/helpers'
import { estimatePromptTokensChain, SNIP_SAFETY_BUFFER } from '../utils/tokens'

// ---- 常量 ----

const DEFAULT_ERROR_MESSAGE = 'Sorry, I encountered an error calling the AI model.'
const PERSISTED_MODEL_ERROR_PLACEHOLDER = '[Assistant reply unavailable due to model error.]'
const MAX_EMPTY_RETRIES = 2
const MAX_LENGTH_RECOVERIES = 3
const MAX_INJECTIONS_PER_TURN = 3
const MAX_INJECTION_CYCLES = 5
const MICROCOMPACT_KEEP_RECENT = 10
const MICROCOMPACT_MIN_CHARS = 500
const COMPACTABLE_TOOLS = new Set([
  'read_file', 'exec', 'grep', 'glob',
  'web_search', 'web_fetch', 'list_dir',
])
const BACKFILL_CONTENT = '[Tool result unavailable — call was interrupted or lost]'

// ---- 类型定义 ----

export interface AgentRunSpec {
  initialMessages: Record<string, unknown>[]
  tools: ToolRegistry
  model: string
  maxIterations: number
  maxToolResultChars: number
  temperature?: number | null
  maxTokens?: number | null
  reasoningEffort?: string | null
  hook?: AgentHook | null
  errorMessage?: string | null
  maxIterationsMessage?: string | null
  concurrentTools?: boolean
  failOnToolError?: boolean
  workspace?: string | null
  sessionKey?: string | null
  contextWindowTokens?: number | null
  contextBlockLimit?: number | null
  providerRetryMode?: string
  progressCallback?: ((event: Record<string, unknown>) => void) | null
  retryWaitCallback?: ((msg: string) => void) | null
  checkpointCallback?: ((payload: Record<string, unknown>) => Promise<void>) | null
  injectionCallback?: ((limit?: number) => Promise<InjectionItem[]>) | null
  llmTimeoutS?: number | null
  onStreamDelta?: (delta: string) => void
}

export interface InjectionItem {
  role?: string
  content: string
}

export interface AgentRunResult {
  finalContent: string | null
  messages: Record<string, unknown>[]
  toolsUsed: string[]
  usage: Record<string, number>
  stopReason: string
  error: string | null
  toolEvents: ToolEvent[]
  hadInjections: boolean
}

// ---- AgentRunner ----

export class AgentRunner {
  constructor(private provider: LLMProvider) {}

  // ==================================================================
  // 主循环 — run()
  // ==================================================================

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    const hook = spec.hook ?? new AgentHook()
    const messages = [...spec.initialMessages]
    let finalContent: string | null = null
    const toolsUsed: string[] = []
    const usage: Record<string, number> = { prompt_tokens: 0, completion_tokens: 0 }
    let error: string | null = null
    let stopReason = 'completed'
    const toolEvents: ToolEvent[] = []
    const externalLookupCounts: Record<string, number> = {}
    let emptyContentRetries = 0
    let lengthRecoveryCount = 0
    let hadInjections = false
    let injectionCycles = 0

    for (let iteration = 0; iteration < spec.maxIterations; iteration++) {
      // --- 上下文治理 ---
      let messagesForModel: Record<string, unknown>[]
      try {
        messagesForModel = AgentRunner.dropOrphanToolResults(messages)
        messagesForModel = AgentRunner.backfillMissingToolResults(messagesForModel)
        messagesForModel = AgentRunner.microcompact(messagesForModel)
        messagesForModel = AgentRunner.applyToolResultBudget(spec, messagesForModel)
        messagesForModel = this.snipHistory(spec, messagesForModel)
        // snipping 可能产生新孤儿，再清理一次
        messagesForModel = AgentRunner.dropOrphanToolResults(messagesForModel)
        messagesForModel = AgentRunner.backfillMissingToolResults(messagesForModel)
      } catch (exc) {
        console.warn(
          `Context governance failed on turn ${iteration} for ${spec.sessionKey ?? 'default'}:`,
          exc,
        )
        try {
          messagesForModel = AgentRunner.dropOrphanToolResults(messages)
          messagesForModel = AgentRunner.backfillMissingToolResults(messagesForModel)
        } catch {
          messagesForModel = messages
        }
      }

      const context: AgentHookContext = {
        iteration,
        messages,
        response: null,
        usage: {},
        toolCalls: [],
        toolResults: [],
        toolEvents: [],
        finalContent: null,
        stopReason: null,
        error: null,
      }
      await hook.beforeIteration(context)

      // --- LLM 调用 ---
      const response = await this.requestModel(spec, messagesForModel, hook, context)
      const rawUsage = AgentRunner.usageDict(response.usage)
      context.response = response
      context.usage = { ...rawUsage }
      context.toolCalls = [...response.toolCalls]
      AgentRunner.accumulateUsage(usage, rawUsage)

      // --- 工具调用分支 ---
      if (response.toolCalls.length > 0 &&
          (response.finishReason === 'tool_calls' || response.finishReason === 'stop')) {
        if (hook.wantsStreaming()) {
          await hook.onStreamEnd(context, true)
        }

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

        await this.emitCheckpoint(spec, {
          phase: 'awaiting_tools',
          iteration,
          model: spec.model,
          assistant_message: assistantMsg,
          completed_tool_results: [],
          pending_tool_calls: response.toolCalls.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: tc.function,
          })),
        })

        await hook.beforeExecuteTools(context)

        const { results, events, fatalError } = await this.executeTools(
          spec,
          response.toolCalls,
          externalLookupCounts,
        )
        toolEvents.push(...events)
        context.toolResults = [...results]
        context.toolEvents = [...events]

        const completedToolResults: Record<string, unknown>[] = []
        for (let i = 0; i < response.toolCalls.length; i++) {
          const tc = response.toolCalls[i]!
          const result = results[i]
          const toolMsg: Record<string, unknown> = {
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: this.normalizeToolResult(
              spec,
              tc.id,
              tc.function.name,
              result,
            ),
          }
          messages.push(toolMsg)
          completedToolResults.push(toolMsg)
        }

        if (fatalError) {
          error = `Error: ${fatalError.name}: ${fatalError.message}`
          finalContent = error
          stopReason = 'tool_error'
          AgentRunner.appendFinalMessage(messages, finalContent)
          context.finalContent = finalContent
          context.error = error
          context.stopReason = stopReason
          await hook.afterIteration(context)

          const { shouldContinue } = await this.tryDrainInjections(
            spec, messages, null, injectionCycles,
            { phase: 'after tool error' },
          )
          if (shouldContinue) {
            hadInjections = true
            injectionCycles++
            continue
          }
          break
        }

        await this.emitCheckpoint(spec, {
          phase: 'tools_completed',
          iteration,
          model: spec.model,
          assistant_message: assistantMsg,
          completed_tool_results: completedToolResults,
          pending_tool_calls: [],
        })

        emptyContentRetries = 0
        lengthRecoveryCount = 0

        // 工具执行后排空注入
        const drained = await this.tryDrainInjections(
          spec, messages, null, injectionCycles,
          { phase: 'after tool execution' },
        )
        if (drained.shouldContinue) {
          hadInjections = true
          injectionCycles++
        }

        await hook.afterIteration(context)
        continue
      }

      // 有 tool_calls 但不该执行
      if (response.toolCalls.length > 0) {
        console.warn(
          `Ignoring tool calls under finish_reason='${response.finishReason}' for ${spec.sessionKey ?? 'default'}`,
        )
      }

      // --- 处理响应 ---
      let clean = hook.finalizeContent(context, response.content)

      // 空响应重试
      if (response.finishReason !== 'error' && isBlankText(clean)) {
        emptyContentRetries++
        if (emptyContentRetries < MAX_EMPTY_RETRIES) {
          console.warn(
            `Empty response on turn ${iteration} for ${spec.sessionKey ?? 'default'} ` +
            `(${emptyContentRetries}/${MAX_EMPTY_RETRIES}); retrying`,
          )
          if (hook.wantsStreaming()) {
            await hook.onStreamEnd(context, false)
          }
          await hook.afterIteration(context)
          continue
        }
        console.warn(
          `Empty response on turn ${iteration} for ${spec.sessionKey ?? 'default'} ` +
          `after ${emptyContentRetries} retries; attempting finalization`,
        )
        if (hook.wantsStreaming()) {
          await hook.onStreamEnd(context, false)
        }
        const retryResponse = await this.requestFinalizationRetry(spec, messagesForModel)
        const retryUsage = AgentRunner.usageDict(retryResponse.usage)
        AgentRunner.accumulateUsage(usage, retryUsage)
        AgentRunner.mergeUsageInto(rawUsage, retryUsage)
        context.response = retryResponse
        context.usage = { ...rawUsage }
        context.toolCalls = [...retryResponse.toolCalls]
        clean = hook.finalizeContent(context, retryResponse.content)
      }

      // length 恢复
      if (response.finishReason === 'length' && !isBlankText(clean)) {
        lengthRecoveryCount++
        if (lengthRecoveryCount <= MAX_LENGTH_RECOVERIES) {
          console.info(
            `Output truncated on turn ${iteration} for ${spec.sessionKey ?? 'default'} ` +
            `(${lengthRecoveryCount}/${MAX_LENGTH_RECOVERIES}); continuing`,
          )
          if (hook.wantsStreaming()) {
            await hook.onStreamEnd(context, true)
          }
          messages.push(buildAssistantMessage(clean, {
            reasoningContent: response.reasoningContent,
          }))
          messages.push(buildLengthRecoveryMessage())
          await hook.afterIteration(context)
          continue
        }
      }

      // --- 最终响应处理 ---
      let assistantMessage: Record<string, unknown> | null = null
      if (response.finishReason !== 'error' && !isBlankText(clean)) {
        assistantMessage = buildAssistantMessage(clean!, {
          reasoningContent: response.reasoningContent,
        })
      }

      // 中继注入检查（在 on_stream_end 之前）
      const { shouldContinue } = await this.tryDrainInjections(
        spec, messages, assistantMessage, injectionCycles,
        { phase: 'after final response', iteration },
      )
      if (shouldContinue) {
        hadInjections = true
        injectionCycles++
      }

      if (hook.wantsStreaming()) {
        await hook.onStreamEnd(context, shouldContinue)
      }

      if (shouldContinue) {
        await hook.afterIteration(context)
        continue
      }

      // 错误响应
      if (response.finishReason === 'error') {
        finalContent = clean || spec.errorMessage || DEFAULT_ERROR_MESSAGE
        stopReason = 'error'
        error = finalContent ?? undefined
        AgentRunner.appendModelErrorPlaceholder(messages)
        context.finalContent = finalContent
        context.error = error
        context.stopReason = stopReason
        await hook.afterIteration(context)

        const drainResult = await this.tryDrainInjections(
          spec, messages, null, injectionCycles,
          { phase: 'after LLM error' },
        )
        if (drainResult.shouldContinue) {
          hadInjections = true
          injectionCycles++
          continue
        }
        break
      }

      // 空最终响应
      if (isBlankText(clean)) {
        finalContent = EMPTY_FINAL_RESPONSE_MESSAGE
        stopReason = 'empty_final_response'
        error = finalContent
        AgentRunner.appendFinalMessage(messages, finalContent)
        context.finalContent = finalContent
        context.error = error
        context.stopReason = stopReason
        await hook.afterIteration(context)

        const drainResult = await this.tryDrainInjections(
          spec, messages, null, injectionCycles,
          { phase: 'after empty response' },
        )
        if (drainResult.shouldContinue) {
          hadInjections = true
          injectionCycles++
          continue
        }
        break
      }

      // 成功完成
      messages.push(
        assistantMessage ??
        buildAssistantMessage(clean!, {
          reasoningContent: response.reasoningContent,
        }),
      )
      await this.emitCheckpoint(spec, {
        phase: 'final_response',
        iteration,
        model: spec.model,
        assistant_message: messages[messages.length - 1],
        completed_tool_results: [],
        pending_tool_calls: [],
      })
      finalContent = clean
      context.finalContent = finalContent
      context.stopReason = stopReason
      await hook.afterIteration(context)
      break
    }

    // --- 达到最大迭代次数 ---
    if (finalContent === null) {
      stopReason = 'max_iterations'
      finalContent =
        spec.maxIterationsMessage ??
        `[Reached max iterations (${spec.maxIterations}) without final response]`
      AgentRunner.appendFinalMessage(messages, finalContent)

      const drainedAfterMax = await this.tryDrainInjections(
        spec, messages, null, injectionCycles,
        { phase: 'after max_iterations' },
      )
      if (drainedAfterMax.shouldContinue) {
        hadInjections = true
        injectionCycles++
      }
    }

    return {
      finalContent,
      messages,
      toolsUsed,
      usage,
      stopReason,
      error,
      toolEvents,
      hadInjections,
    }
  }

  // ==================================================================
  // LLM 调用
  // ==================================================================

  private buildRequestOpts(
    spec: AgentRunSpec,
    messages: Record<string, unknown>[],
    tools?: Record<string, unknown>[],
  ) {
    return {
      messages: messages as any,
      tools: tools as any,
      settings: {
        temperature: spec.temperature ?? undefined,
        maxTokens: spec.maxTokens ?? undefined,
        reasoningEffort: spec.reasoningEffort ?? undefined,
      },
    }
  }

  private async requestModel(
    spec: AgentRunSpec,
    messages: Record<string, unknown>[],
    hook: AgentHook,
    context: AgentHookContext,
  ): Promise<LLMResponse> {
    const timeoutS = spec.llmTimeoutS ?? 300
    const toolDefs = spec.tools.getDefinitions()
    const opts = this.buildRequestOpts(spec, messages, toolDefs as any)

    if (hook.wantsStreaming()) {
      // 流式模式 — 聚合 chunk 并通过 hook.on_stream 发射
      let content = ''
      let reasoningContent = ''
      let finishReason: LLMResponse['finishReason'] = 'stop'
      const toolCalls: ToolCallRequest[] = []

      const abort = new AbortController()
      const timer = timeoutS > 0 ? setTimeout(() => abort.abort(), timeoutS * 1000) : null

      try {
        for await (const chunk of this.provider.generateStream(
          opts.messages,
          { tools: opts.tools, settings: opts.settings },
        )) {
          if (chunk.content) {
            content += chunk.content
            await hook.onStream(context, chunk.content)
          }
          if (chunk.reasoningContent) reasoningContent += chunk.reasoningContent
          if (chunk.finishReason) finishReason = chunk.finishReason as LLMResponse['finishReason']
          if (chunk.toolCalls?.length) {
            for (const tc of chunk.toolCalls) {
              const existing = toolCalls.find((t) => t.id === tc.id)
              if (existing) {
                existing.function.arguments += tc.function.arguments
                if (tc.function.name) existing.function.name = tc.function.name
              } else {
                toolCalls.push({ ...tc })
              }
            }
          }
        }
      } catch (err: any) {
        if (err?.name === 'AbortError' || abort.signal.aborted) {
          return {
            content: `Error calling LLM: timed out after ${timeoutS}s`,
            finishReason: 'error',
            toolCalls: [],
          }
        }
        throw err
      } finally {
        if (timer) clearTimeout(timer)
      }

      return { content: content || null, finishReason, toolCalls, reasoningContent: reasoningContent || null }
    }

    // 非流式模式
    const abort = new AbortController()
    const timer = timeoutS > 0 ? setTimeout(() => abort.abort(), timeoutS * 1000) : null

    try {
      const result = await this.provider.generate(opts.messages, {
        tools: opts.tools,
        settings: opts.settings,
      })
      return result
    } catch (err: any) {
      if (err?.name === 'AbortError' || abort.signal.aborted) {
        return {
          content: `Error calling LLM: timed out after ${timeoutS}s`,
          finishReason: 'error',
          toolCalls: [],
        }
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async requestFinalizationRetry(
    spec: AgentRunSpec,
    messages: Record<string, unknown>[],
  ): Promise<LLMResponse> {
    const retryMessages = [...messages, buildFinalizationRetryMessage()]
    const opts = this.buildRequestOpts(spec, retryMessages)
    return this.provider.generate(opts.messages, { settings: opts.settings })
  }

  // ==================================================================
  // 工具执行
  // ==================================================================

  private async executeTools(
    spec: AgentRunSpec,
    toolCalls: ToolCallRequest[],
    externalLookupCounts: Record<string, number>,
  ): Promise<{
    results: unknown[]
    events: ToolEvent[]
    fatalError: Error | null
  }> {
    const batches = this.partitionToolBatches(spec, toolCalls)
    const toolResults: { result: unknown; event: ToolEvent; error: Error | null }[] = []

    for (const batch of batches) {
      if (spec.concurrentTools && batch.length > 1) {
        const batchResults = await Promise.all(
          batch.map((tc) => this.runTool(spec, tc, externalLookupCounts)),
        )
        toolResults.push(...batchResults)
      } else {
        for (const tc of batch) {
          toolResults.push(await this.runTool(spec, tc, externalLookupCounts))
        }
      }
    }

    const results: unknown[] = []
    const events: ToolEvent[] = []
    let fatalError: Error | null = null

    for (const { result, event, error } of toolResults) {
      results.push(result)
      events.push(event)
      if (error && !fatalError) {
        fatalError = error
      }
    }

    return { results, events, fatalError }
  }

  private async runTool(
    spec: AgentRunSpec,
    toolCall: ToolCallRequest,
    externalLookupCounts: Record<string, number>,
  ): Promise<{ result: unknown; event: ToolEvent; error: Error | null }> {
    const HINT = '\n\n[Analyze the error above and try a different approach.]'

    // 重复外部查找拦截
    try {
      const args = JSON.parse(toolCall.function.arguments)
      const lookupError = repeatedExternalLookupError(
        toolCall.function.name,
        args,
        externalLookupCounts,
      )
      if (lookupError) {
        const event: ToolEvent = {
          name: toolCall.function.name,
          status: 'error',
          detail: 'repeated external lookup blocked',
        }
        if (spec.failOnToolError) {
          return { result: lookupError + HINT, event, error: new Error(lookupError) }
        }
        return { result: lookupError + HINT, event, error: null }
      }
    } catch {
      // JSON 解析失败，跳过重复检查
    }

    // prepareCall
    let args: Record<string, unknown>
    try {
      args = JSON.parse(toolCall.function.arguments)
    } catch {
      args = {}
    }

    const { tool, params, error: prepError } = spec.tools.prepareCall(
      toolCall.function.name,
      args,
    )

    if (prepError) {
      const event: ToolEvent = {
        name: toolCall.function.name,
        status: 'error',
        detail: prepError.split(': ').slice(-1)[0]?.slice(0, 120) ?? prepError.slice(0, 120),
      }
      if (spec.failOnToolError) {
        return { result: prepError + HINT, event, error: new Error(prepError) }
      }
      return { result: prepError + HINT, event, error: null }
    }

    // 执行
    try {
      let result: unknown
      if (tool) {
        result = await tool.execute(params)
      } else {
        result = await spec.tools.execute(toolCall.function.name, params)
      }

      if (typeof result === 'string' && result.startsWith('Error')) {
        const event: ToolEvent = {
          name: toolCall.function.name,
          status: 'error',
          detail: result.replace(/\n/g, ' ').trim().slice(0, 120),
        }
        if (spec.failOnToolError) {
          return { result: result + HINT, event, error: new Error(result) }
        }
        return { result: result + HINT, event, error: null }
      }

      let detail = ''
      if (result == null) {
        detail = '(empty)'
      } else {
        detail = String(result).replace(/\n/g, ' ').trim()
      }
      if (!detail) {
        detail = '(empty)'
      } else if (detail.length > 120) {
        detail = detail.slice(0, 120) + '...'
      }
      return { result, event: { name: toolCall.function.name, status: 'ok', detail }, error: null }
    } catch (err) {
      const event: ToolEvent = {
        name: toolCall.function.name,
        status: 'error',
        detail: String(err),
      }
      if (spec.failOnToolError) {
        return {
          result: `Error: ${err instanceof Error ? err.name + ': ' + err.message : String(err)}`,
          event,
          error: err instanceof Error ? err : new Error(String(err)),
        }
      }
      return {
        result: `Error: ${err instanceof Error ? err.name + ': ' + err.message : String(err)}`,
        event,
        error: null,
      }
    }
  }

  private partitionToolBatches(
    spec: AgentRunSpec,
    toolCalls: ToolCallRequest[],
  ): ToolCallRequest[][] {
    if (!spec.concurrentTools) {
      return toolCalls.map((tc) => [tc])
    }

    const batches: ToolCallRequest[][] = []
    let current: ToolCallRequest[] = []

    for (const tc of toolCalls) {
      const tool = spec.tools.get(tc.function.name)
      const canBatch = !!(tool && tool.concurrencySafe)
      if (canBatch) {
        current.push(tc)
        continue
      }
      if (current.length > 0) {
        batches.push(current)
        current = []
      }
      batches.push([tc])
    }
    if (current.length > 0) {
      batches.push(current)
    }
    return batches
  }

  // ==================================================================
  // 中继注入
  // ==================================================================

  private async tryDrainInjections(
    spec: AgentRunSpec,
    messages: Record<string, unknown>[],
    assistantMessage: Record<string, unknown> | null,
    injectionCycles: number,
    opts: { phase?: string; iteration?: number } = {},
  ): Promise<{ shouldContinue: boolean }> {
    if (injectionCycles >= MAX_INJECTION_CYCLES) {
      return { shouldContinue: false }
    }

    const injections = await this.drainInjections(spec)
    if (injections.length === 0) {
      return { shouldContinue: false }
    }

    if (assistantMessage) {
      messages.push(assistantMessage)
      if (opts.iteration !== undefined) {
        await this.emitCheckpoint(spec, {
          phase: 'final_response',
          iteration: opts.iteration,
          model: spec.model,
          assistant_message: assistantMessage,
          completed_tool_results: [],
          pending_tool_calls: [],
        })
      }
    }

    AgentRunner.appendInjectedMessages(messages, injections)
    console.info(
      `Injected ${injections.length} follow-up message(s) ${opts.phase ?? ''} ` +
      `(${injectionCycles + 1}/${MAX_INJECTION_CYCLES})`,
    )
    return { shouldContinue: true }
  }

  private async drainInjections(
    spec: AgentRunSpec,
  ): Promise<Record<string, unknown>[]> {
    if (!spec.injectionCallback) return []

    let items: InjectionItem[]
    try {
      // 检查回调是否接受 limit 参数
      if (spec.injectionCallback.length > 0) {
        items = await spec.injectionCallback(MAX_INJECTIONS_PER_TURN)
      } else {
        items = await spec.injectionCallback()
      }
    } catch (err) {
      console.error('injectionCallback failed:', err)
      return []
    }

    if (!items || items.length === 0) return []

    const injectedMessages: Record<string, unknown>[] = []
    for (const item of items) {
      if (
        typeof item === 'object' &&
        item !== null &&
        (item as unknown as Record<string, unknown>).role === 'user' &&
        'content' in item
      ) {
        injectedMessages.push(item as unknown as Record<string, unknown>)
        continue
      }
      const text =
        typeof item === 'object' && item !== null && 'content' in item
          ? String((item as unknown as Record<string, unknown>).content)
          : String(item)
      if (text.trim()) {
        injectedMessages.push({ role: 'user', content: text })
      }
    }

    if (injectedMessages.length > MAX_INJECTIONS_PER_TURN) {
      const dropped = injectedMessages.length - MAX_INJECTIONS_PER_TURN
      console.warn(
        `Injection callback returned ${injectedMessages.length} messages, ` +
        `capping to ${MAX_INJECTIONS_PER_TURN} (${dropped} dropped)`,
      )
      return injectedMessages.slice(0, MAX_INJECTIONS_PER_TURN)
    }

    return injectedMessages
  }

  // ==================================================================
  // Checkpoint
  // ==================================================================

  private async emitCheckpoint(
    spec: AgentRunSpec,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (spec.checkpointCallback) {
      await spec.checkpointCallback(payload)
    }
  }

  // ==================================================================
  // 工具结果规范化
  // ==================================================================

  private normalizeToolResult(
    spec: AgentRunSpec,
    _toolCallId: string,
    toolName: string,
    result: unknown,
  ): unknown {
    let content = ensureNonemptyToolResult(toolName, result)
    if (typeof content === 'string' && content.length > spec.maxToolResultChars) {
      content = truncateText(content, spec.maxToolResultChars)
    }
    return content
  }

  // ==================================================================
  // 上下文治理 — 静态方法
  // ==================================================================

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
          continue
        }
      }
      updated.push({ ...msg })
    }

    return updated
  }

  static backfillMissingToolResults(
    messages: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const declared: { index: number; id: string; name: string }[] = []
    const fulfilled = new Set<string>()

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
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
      let insertAt = index + 1 + offset
      while (insertAt < updated.length && updated[insertAt]?.role === 'tool') {
        insertAt++
      }
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

  static microcompact(
    messages: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const compactableIndices: number[] = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
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
      const msg = updated[idx]!
      const content = msg.content as string | undefined
      if (typeof content !== 'string' || content.length < MICROCOMPACT_MIN_CHARS) {
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

  private snipHistory(
    spec: AgentRunSpec,
    messages: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    if (messages.length === 0 || !spec.contextWindowTokens) return messages

    const providerMaxTokens = 4096 // 默认值
    const maxOutput =
      typeof spec.maxTokens === 'number'
        ? spec.maxTokens
        : providerMaxTokens

    const budget =
      spec.contextBlockLimit ??
      spec.contextWindowTokens - maxOutput - SNIP_SAFETY_BUFFER

    if (budget <= 0) return messages

    const { tokens: estimate } = estimatePromptTokensChain(
      messages,
      spec.tools.getDefinitions() as any,
    )
    if (estimate <= budget) return messages

    const systemMessages = messages.filter((m) => m.role === 'system')
    const nonSystem = messages.filter((m) => m.role !== 'system')
    if (nonSystem.length === 0) return messages

    const systemTokens = systemMessages.reduce(
      (sum, m) => sum + AgentRunner.estimateSingleMessageTokens(m),
      0,
    )
    const remainingBudget = Math.max(128, budget - systemTokens)

    const kept: Record<string, unknown>[] = []
    let keptTokens = 0
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const msg = nonSystem[i]!
      const msgTokens = AgentRunner.estimateSingleMessageTokens(msg)
      if (kept.length > 0 && keptTokens + msgTokens > remainingBudget) {
        break
      }
      kept.unshift(msg)
      keptTokens += msgTokens
    }

    if (kept.length > 0) {
      let startIdx = -1
      for (let i = 0; i < kept.length; i++) {
        if (kept[i]!.role === 'user') {
          startIdx = i
          break
        }
      }
      if (startIdx >= 0) {
        kept.splice(0, startIdx)
      } else {
        // 从外部窗口恢复最近的 user 消息
        for (let i = nonSystem.length - 1; i >= 0; i--) {
          if (nonSystem[i]!.role === 'user') {
            const recovered = nonSystem.slice(i)
            kept.length = 0
            kept.push(...recovered)
            break
          }
        }
      }

      const legalStart = findLegalMessageStart(kept)
      if (legalStart > 0) {
        kept.splice(0, legalStart)
      }
    }

    if (kept.length === 0) {
      const fallback = nonSystem.slice(-Math.min(nonSystem.length, 4))
      kept.push(...fallback)
      const legalStart = findLegalMessageStart(kept)
      if (legalStart > 0) {
        kept.splice(0, legalStart)
      }
    }

    return [...systemMessages, ...kept]
  }

  // ==================================================================
  // 静态工具方法
  // ==================================================================

  static usageDict(
    usage: Record<string, unknown> | undefined | null,
  ): Record<string, number> {
    if (!usage) return {}
    const result: Record<string, number> = {}
    for (const [key, value] of Object.entries(usage)) {
      try {
        result[key] = parseInt(String(value ?? 0), 10) || 0
      } catch {
        // skip
      }
    }
    return result
  }

  static accumulateUsage(
    target: Record<string, number>,
    addition: Record<string, number>,
  ): void {
    for (const [key, value] of Object.entries(addition)) {
      target[key] = (target[key] ?? 0) + value
    }
  }

  static mergeUsageInto(
    target: Record<string, number>,
    addition: Record<string, number>,
  ): void {
    for (const [key, value] of Object.entries(addition)) {
      target[key] = (target[key] ?? 0) + value
    }
  }

  static estimateSingleMessageTokens(message: Record<string, unknown>): number {
    const content = message.content
    const parts: string[] = []

    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          (part as Record<string, unknown>).type === 'text'
        ) {
          const text = (part as Record<string, unknown>).text
          if (typeof text === 'string' && text) parts.push(text)
        }
      }
    } else if (content != null) {
      parts.push(JSON.stringify(content))
    }

    const payload = parts.join('\n')
    if (!payload) return 4
    return Math.max(4, Math.ceil(payload.length / 4) + 4)
  }

  static appendFinalMessage(
    messages: Record<string, unknown>[],
    content: string | null,
  ): void {
    if (!content) return
    const last = messages[messages.length - 1]
    if (
      last &&
      last.role === 'assistant' &&
      !last.tool_calls
    ) {
      if (last.content === content) return
      messages[messages.length - 1] = buildAssistantMessage(content)
      return
    }
    messages.push(buildAssistantMessage(content))
  }

  static appendModelErrorPlaceholder(
    messages: Record<string, unknown>[],
  ): void {
    const last = messages[messages.length - 1]
    if (last && last.role === 'assistant' && !last.tool_calls) return
    messages.push(buildAssistantMessage(PERSISTED_MODEL_ERROR_PLACEHOLDER))
  }

  static appendInjectedMessages(
    messages: Record<string, unknown>[],
    injections: Record<string, unknown>[],
  ): void {
    for (const injection of injections) {
      const last = messages[messages.length - 1]
      if (
        last &&
        injection.role === 'user' &&
        last.role === 'user'
      ) {
        const leftContent = last.content
        const rightContent = injection.content
        let merged: unknown
        if (typeof leftContent === 'string' && typeof rightContent === 'string') {
          merged = leftContent ? `${leftContent}\n\n${rightContent}` : rightContent
        } else {
          const leftBlocks = Array.isArray(leftContent)
            ? leftContent
            : leftContent != null
              ? [{ type: 'text', text: String(leftContent) }]
              : []
          const rightBlocks = Array.isArray(rightContent)
            ? rightContent
            : rightContent != null
              ? [{ type: 'text', text: String(rightContent) }]
              : []
          merged = [...leftBlocks, ...rightBlocks]
        }
        messages[messages.length - 1] = { ...last, content: merged }
        continue
      }
      messages.push({ ...injection })
    }
  }
}
