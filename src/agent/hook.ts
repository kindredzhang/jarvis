/**
 * AgentHook —— Agent 运行生命周期钩子
 *
 * 提供 beforeIteration / onStream / beforeExecuteTools / afterIteration 等
 * 生命周期回调，用于流式输出、进度追踪、工具调用监控。
 */
export interface AgentHookContext {
  iteration: number
  messages: Record<string, unknown>[]
  response?: { content: string | null; finishReason: string; toolCalls: unknown[] }
  toolCalls: { name: string; arguments: Record<string, unknown> }[]
  toolResults: unknown[]
  toolEvents: { name: string; status: string; detail: string }[]
  usage: Record<string, number>
  finalContent: string | null
  stopReason: string | null
  error: string | null
}

export class AgentHook {
  reraise = false
  wantsStreaming(): boolean { return false }
  async beforeIteration(_ctx: AgentHookContext) {}
  async onStream(_ctx: AgentHookContext, _delta: string) {}
  async onStreamEnd(_ctx: AgentHookContext, _resuming: boolean) {}
  async beforeExecuteTools(_ctx: AgentHookContext) {}
  async afterIteration(_ctx: AgentHookContext) {}
  finalizeContent(_ctx: AgentHookContext, content: string | null): string | null { return content }
}

export class CompositeHook extends AgentHook {
  private hooks: AgentHook[]
  constructor(hooks: AgentHook[]) { super(); this.hooks = hooks }
  wantsStreaming(): boolean { return this.hooks.some((h) => h.wantsStreaming()) }
  private async _safe(method: string, ...args: any[]) {
    for (const h of this.hooks) {
      try { await (h as any)[method](...args) } catch { /* isolate hook errors */ }
    }
  }
  async beforeIteration(ctx: AgentHookContext) { await this._safe('beforeIteration', ctx) }
  async onStream(ctx: AgentHookContext, delta: string) { await this._safe('onStream', ctx, delta) }
  async onStreamEnd(ctx: AgentHookContext, resuming: boolean) { await this._safe('onStreamEnd', ctx, resuming) }
  async beforeExecuteTools(ctx: AgentHookContext) { await this._safe('beforeExecuteTools', ctx) }
  async afterIteration(ctx: AgentHookContext) { await this._safe('afterIteration', ctx) }
  finalizeContent(ctx: AgentHookContext, content: string | null): string | null {
    for (const h of this.hooks) content = h.finalizeContent(ctx, content)
    return content
  }
}
