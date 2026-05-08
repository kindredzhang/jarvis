/**
 * HeartbeatService —— 定时唤醒 Agent 检查任务
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LLMProvider } from '../providers/base'

export class HeartbeatService {
  private workspace: string
  private provider: LLMProvider
  private model: string
  private intervalMs: number
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  onExecute: ((tasks: string) => Promise<string>) | null = null
  onNotify: ((msg: string) => Promise<void>) | null = null

  constructor(opts: { workspace: string; provider: LLMProvider; model: string; intervalS?: number }) {
    this.workspace = opts.workspace; this.provider = opts.provider; this.model = opts.model; this.intervalMs = (opts.intervalS ?? 1800) * 1000
  }

  private get hbFile() { return join(this.workspace, 'HEARTBEAT.md') }

  async start() {
    this.running = true; this.schedule(); console.log('[Heartbeat] started')
  }
  stop() { this.running = false; if (this.timer) clearTimeout(this.timer) }

  private schedule() {
    if (!this.running) return
    this.timer = setTimeout(() => { if (this.running) this.tick() }, this.intervalMs)
  }

  private async tick() {
    try {
      const content = existsSync(this.hbFile) ? readFileSync(this.hbFile, 'utf-8') : null
      if (!content) return

      const response = await this.provider.generate([
        { role: 'system', content: 'You are a heartbeat agent. Decide if there are active tasks.' },
        { role: 'user', content: `Current time: ${new Date().toISOString()}\n\nReview:\n${content}\n\nReply "run" if tasks exist, "skip" otherwise.` },
      ])
      const text = response.content ?? ''
      if (!text.toLowerCase().includes('run')) return
      if (this.onExecute) {
        const result = await this.onExecute(text)
        if (result && this.onNotify) await this.onNotify(result)
      }
    } catch { /* heartbeat error ignored */ }
  }
}
