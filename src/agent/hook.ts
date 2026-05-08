/**
 * AgentHook —— Agent 运行生命周期钩子
 *
 * 提供 beforeIteration / onStream / onStreamEnd / beforeExecuteTools /
 * afterIteration / finalizeContent 等生命周期回调。
 *
 * CompositeHook 将调用扇出到有序钩子列表，具备 per-hook 错误隔离。
 * reraise=true 的钩子会传播异常（不捕获）。
 * finalizeContent 是管道模式（不隔离错误）。
 */

import type { LLMResponse, ToolCallRequest } from '../providers/types'

// ---- AgentHookContext ----

export interface AgentHookContext {
  iteration: number
  messages: Record<string, unknown>[]
  response: LLMResponse | null
  usage: Record<string, number>
  toolCalls: ToolCallRequest[]
  toolResults: unknown[]
  toolEvents: ToolEvent[]
  finalContent: string | null
  stopReason: string | null
  error: string | null
}

export interface ToolEvent {
  name: string
  status: string
  detail: string
}

// ---- AgentHook ----

export class AgentHook {
  readonly reraise: boolean

  constructor(reraise = false) {
    this.reraise = reraise
  }

  wantsStreaming(): boolean {
    return false
  }

  async beforeIteration(_context: AgentHookContext): Promise<void> {}

  async onStream(_context: AgentHookContext, _delta: string): Promise<void> {}

  async onStreamEnd(
    _context: AgentHookContext,
    _resuming: boolean,
  ): Promise<void> {}

  async beforeExecuteTools(_context: AgentHookContext): Promise<void> {}

  async afterIteration(_context: AgentHookContext): Promise<void> {}

  finalizeContent(
    _context: AgentHookContext,
    content: string | null,
  ): string | null {
    return content
  }
}

// ---- CompositeHook ----

export class CompositeHook extends AgentHook {
  private hooks: AgentHook[]

  constructor(hooks: AgentHook[]) {
    super()
    this.hooks = [...hooks]
  }

  override wantsStreaming(): boolean {
    return this.hooks.some((h) => h.wantsStreaming())
  }

  private async forEachHookSafe(
    method: string,
    ...args: unknown[]
  ): Promise<void> {
    for (const h of this.hooks) {
      if (h.reraise) {
        await (h as any)[method](...args)
        continue
      }
      try {
        await (h as any)[method](...args)
      } catch (err) {
        console.error(
          `AgentHook.${method} error in ${h.constructor.name}:`,
          err,
        )
      }
    }
  }

  override async beforeIteration(context: AgentHookContext): Promise<void> {
    await this.forEachHookSafe('beforeIteration', context)
  }

  override async onStream(context: AgentHookContext, delta: string): Promise<void> {
    await this.forEachHookSafe('onStream', context, delta)
  }

  override async onStreamEnd(
    context: AgentHookContext,
    resuming: boolean,
  ): Promise<void> {
    await this.forEachHookSafe('onStreamEnd', context, resuming)
  }

  override async beforeExecuteTools(context: AgentHookContext): Promise<void> {
    await this.forEachHookSafe('beforeExecuteTools', context)
  }

  override async afterIteration(context: AgentHookContext): Promise<void> {
    await this.forEachHookSafe('afterIteration', context)
  }

  override finalizeContent(
    context: AgentHookContext,
    content: string | null,
  ): string | null {
    let result = content
    for (const h of this.hooks) {
      result = h.finalizeContent(context, result)
    }
    return result
  }
}
