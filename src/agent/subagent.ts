/**
 * SubagentManager —— 子代理管理
 *
 * 在后台执行独立的任务，完成后通过回调通知主 Agent。
 * 每个子代理持有自己的 ToolRegistry（文件工具 + 执行工具），
 * 运行独立的 ReAct 循环。
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * - 无 SkillsLoader / 技能摘要
 * - 无 SkillsLoader / 技能摘要
 * - 无 MessageBus 注入（通过 onResult 回调通知）
 * - 无 ContextBuilder.buildRuntimeContext 注入
 * - 无 WebSearch / WebFetch 工具注册
 * - 无 cancel_by_session 完善实现
 * - 无 _format_partial_progress 详细进度格式化
 * - 无 asyncio.Task（用 Promise + resolve 回调）
 */

import { AgentRunner, type AgentRunSpec, type AgentRunResult } from './runner'
import { AgentLoop } from './loop'
import { type ToolEvent } from './hook'
import { ToolRegistry } from './tools/registry'
import {
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  ListDirTool,
} from './tools/fs'
import { GlobTool, GrepTool } from './tools/search'
import { ExecTool } from './tools/shell'
import { TemplateEngine } from '../utils/template'

// ---- 状态类型 ----

export interface SubagentStatus {
  taskId: string
  label: string
  taskDescription: string
  startedAt: number
  phase: 'initializing' | 'running' | 'done' | 'error'
  iteration: number
  toolEvents: ToolEvent[]
  usage: Record<string, number>
  stopReason: string | null
  error: string | null
}

/** 子代理结果回调 */
export type SubagentResultCallback = (
  taskId: string,
  result: string,
  status: 'ok' | 'error',
) => void

// ---- SubagentManager ----

export class SubagentManager {
  private provider: { generate: Function }
  private workspace: string
  private model: string
  private maxToolResultChars: number
  private runner: AgentRunner
  private onResult: SubagentResultCallback | null = null
  private tpl = new TemplateEngine()

  /** 运行中的任务 */
  private runningTasks = new Map<string, Promise<void>>()
  /** 任务状态 */
  private taskStatuses = new Map<string, SubagentStatus>()
  /** 按 sessionKey 分组的任务 */
  private sessionTasks = new Map<string, Set<string>>()

  constructor(options: {
    provider: { generate: Function }
    workspace: string
    model: string
    maxToolResultChars?: number
    onResult?: SubagentResultCallback
  }) {
    this.provider = options.provider
    this.workspace = options.workspace
    this.model = options.model
    this.maxToolResultChars = options.maxToolResultChars ?? 16_000
    this.onResult = options.onResult ?? null
    this.runner = new AgentRunner(options.provider as any)
  }

  /** 设置结果回调 */
  setOnResult(callback: SubagentResultCallback): void {
    this.onResult = callback
  }

  /**
   * 生成一个子代理执行任务
   * @param task 任务描述
   * @param options 可选参数
   * @returns 任务 ID 字符串
   */
  async spawn(
    task: string,
    options?: {
      label?: string
      sessionKey?: string
    },
  ): Promise<string> {
    const taskId = this._generateId()
    const label = options?.label ?? (task.length > 30 ? task.slice(0, 30) + '...' : task)

    const status: SubagentStatus = {
      taskId,
      label,
      taskDescription: task,
      startedAt: Date.now(),
      phase: 'initializing',
      iteration: 0,
      toolEvents: [],
      usage: {},
      stopReason: null,
      error: null,
    }
    this.taskStatuses.set(taskId, status)

    const runPromise = this._runSubagent(taskId, task, label, status)
    this.runningTasks.set(taskId, runPromise)

    if (options?.sessionKey) {
      const sessions = this.sessionTasks.get(options.sessionKey) ?? new Set()
      sessions.add(taskId)
      this.sessionTasks.set(options.sessionKey, sessions)
    }

    // Cleanup when done
    runPromise.finally(() => {
      this.runningTasks.delete(taskId)
      this.taskStatuses.delete(taskId)
    })

    return `Subagent [${label}] started (id: ${taskId}). I'll notify you when it completes.`
  }

  /** 获取运行中的任务数 */
  getRunningCount(): number {
    return this.runningTasks.size
  }

  /** 获取特定 session 的运行中任务数 */
  getRunningCountBySession(sessionKey: string): number {
    const tids = this.sessionTasks.get(sessionKey)
    if (!tids) return 0
    let count = 0
    for (const tid of tids) {
      const p = this.runningTasks.get(tid)
      if (p) {
        // Check if still running by checking if it's settled
        const isRunning = true // simplified - Bun doesn't let us check Promise state
        if (isRunning) count++
      }
    }
    return count
  }

  /** 取消某个 session 的所有子代理 */
  async cancelBySession(sessionKey: string): Promise<number> {
    const tids = this.sessionTasks.get(sessionKey)
    if (!tids) return 0
    // Note: In Bun/JS there's no general way to cancel a running promise
    // We just clean up the tracking
    this.sessionTasks.delete(sessionKey)
    return tids.size
  }

  // ---- 内部方法 ----

  private async _runSubagent(
    taskId: string,
    task: string,
    label: string,
    status: SubagentStatus,
  ): Promise<void> {
    status.phase = 'running'

    try {
      const tools = this._buildTools()
      const systemPrompt = this._buildSubagentPrompt()

      const spec: AgentRunSpec = {
        initialMessages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: task },
        ],
        tools,
        model: this.model,
        maxIterations: 15,
        maxToolResultChars: this.maxToolResultChars,
        failOnToolError: true,
      }

      const result = await this.runner.run(spec)
      status.iteration = result.toolsUsed.length
      status.usage = result.usage ?? {}
      status.stopReason = result.stopReason
      status.phase = 'done'

      if (result.stopReason === 'tool_error') {
        status.toolEvents = [...(result.toolEvents ?? [])]
        const errMsg = result.error ?? 'Subagent execution failed.'
        await this._announceResult(taskId, label, task, errMsg, 'error')
        return
      }
      if (result.stopReason === 'error') {
        const errMsg = result.error ?? 'Subagent execution failed.'
        await this._announceResult(taskId, label, task, errMsg, 'error')
        return
      }

      const finalContent = result.finalContent ?? 'Task completed but no final response was generated.'
      await this._announceResult(taskId, label, task, finalContent, 'ok')
    } catch (err: unknown) {
      status.phase = 'error'
      status.error = err instanceof Error ? err.message : String(err)
      await this._announceResult(taskId, label, task, `Error: ${status.error}`, 'error')
    }
  }

  private async _announceResult(
    taskId: string,
    label: string,
    task: string,
    result: string,
    status: 'ok' | 'error',
  ): Promise<void> {
    const statusText = status === 'ok' ? 'completed successfully' : 'failed'

    const content = [
      `[Subagent '${label}' ${statusText}]`,
      '',
      `Task: ${task}`,
      '',
      'Result:',
      result,
      '',
      'Summarize this naturally for the user. Keep it brief (1-2 sentences).',
      'Do not mention technical details like "subagent" or task IDs.',
    ].join('\n')

    if (this.onResult) {
      this.onResult(taskId, content, status)
    }
  }

  private _buildTools(): ToolRegistry {
    const tools = new ToolRegistry()
    tools.register(new ReadFileTool(this.workspace))
    tools.register(new WriteFileTool(this.workspace))
    tools.register(new EditFileTool(this.workspace))
    tools.register(new ListDirTool(this.workspace))
    tools.register(new GlobTool())
    tools.register(new GrepTool())
    tools.register(new ExecTool({ workingDir: this.workspace }))
    return tools
  }

  private _buildSubagentPrompt(): string {
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ')
    return this.tpl.render('agent/subagent_system.md', {
      timeCtx: now,
      workspace: this.workspace,
      skillsSummary: '',
    })
  }

  private _generateId(): string {
    return Math.random().toString(36).slice(2, 10)
  }
}
