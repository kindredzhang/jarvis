/**
 * CronService —— 定时任务服务
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

interface CronSchedule { kind: 'at' | 'every' | 'cron'; atMs?: number; everyMs?: number; expr?: string; tz?: string }
interface CronPayload { kind: string; message: string; deliver?: boolean; channel?: string; to?: string }
interface CronJob { id: string; name: string; enabled: boolean; schedule: CronSchedule; payload: CronPayload; nextRunAtMs?: number; lastRunAtMs?: number; lastStatus?: string; lastError?: string; createdAtMs: number; updatedAtMs: number; deleteAfterRun?: boolean }

export class CronService {
  private jobs: CronJob[] = []
  private storePath: string
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  maxSleepMs = 300_000
  onJob: ((job: CronJob) => Promise<void>) | null = null

  constructor(storePath: string) { this.storePath = storePath }

  private load() {
    if (!existsSync(this.storePath)) { this.jobs = []; return }
    try {
      const data = JSON.parse(readFileSync(this.storePath, 'utf-8'))
      this.jobs = (data.jobs ?? []).map((j: any) => ({ ...j, nextRunAtMs: j.nextRunAtMs ?? j.state?.nextRunAtMs }))
    } catch { this.jobs = [] }
  }
  private save() {
    mkdirSync(dirname(this.storePath), { recursive: true })
    writeFileSync(this.storePath, JSON.stringify({ jobs: this.jobs }, null, 2), 'utf-8')
  }

  start() {
    this.running = true; this.load(); this.recompute(); this.save(); this.arm()
  }
  stop() {
    this.running = false; if (this.timer) clearTimeout(this.timer)
  }

  private recompute() {
    const now = Date.now()
    for (const j of this.jobs) {
      if (!j.enabled) continue
      if (j.schedule.kind === 'every' && j.schedule.everyMs) j.nextRunAtMs = now + j.schedule.everyMs
      else if (j.schedule.kind === 'at') j.nextRunAtMs = j.schedule.atMs
    }
  }

  private nextWake(): number | null {
    const times = this.jobs.filter(j => j.enabled && j.nextRunAtMs).map(j => j.nextRunAtMs!).filter(Boolean)
    return times.length ? Math.min(...times) : Date.now() + this.maxSleepMs
  }

  private arm() {
    if (this.timer) clearTimeout(this.timer)
    if (!this.running) return
    const delay = Math.min(this.maxSleepMs, Math.max(0, this.nextWake()! - Date.now()))
    this.timer = setTimeout(() => { if (this.running) this.tick() }, delay)
  }

  private async tick() {
    this.load()
    const now = Date.now()
    for (const job of this.jobs.filter(j => j.enabled && j.nextRunAtMs && now >= j.nextRunAtMs)) {
      try {
        if (this.onJob) await this.onJob(job)
        job.lastStatus = 'ok'
      } catch (err: any) { job.lastStatus = 'error'; job.lastError = err.message }
      job.lastRunAtMs = now; job.updatedAtMs = now
      if (job.schedule.kind === 'every' && job.schedule.everyMs) job.nextRunAtMs = now + job.schedule.everyMs
      else { job.enabled = false; job.nextRunAtMs = undefined }
    }
    this.save(); this.arm()
  }

  listJobs() { return [...this.jobs] }
  addJob(name: string, message: string, schedule: { kind: 'at' | 'every'; atMs?: number; everyMs?: number }) {
    const job: CronJob = { id: Math.random().toString(36).slice(2, 10), name, enabled: true, schedule: { kind: schedule.kind, atMs: schedule.atMs, everyMs: schedule.everyMs }, payload: { kind: 'agent_turn', message }, createdAtMs: Date.now(), updatedAtMs: Date.now(), nextRunAtMs: (schedule.kind === 'every' && schedule.everyMs ? Date.now() + schedule.everyMs : schedule.atMs) }
    this.jobs.push(job); this.save(); this.arm()
    return job
  }
  removeJob(id: string) { this.jobs = this.jobs.filter(j => j.id !== id); this.save(); this.arm() }
}
