/**
 * CronService —— 定时任务服务
 *
 * Ported from Python original cron/service.py (558 lines).
 * Manages and executes scheduled jobs with file persistence,
 * system job protection, run history tracking, and cross-process
 * action queue via action.jsonl.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { CronJob, CronSchedule, CronPayload, CronJobState, CronStore } from './types'
import { computeNextCron } from './parser'

// ---- Helpers ----

function nowMs(): number {
  return Date.now()
}

function validateSchedule(schedule: CronSchedule): void {
  if (schedule.tz && schedule.kind !== 'cron') {
    throw new Error('tz can only be used with cron schedules')
  }
  if (schedule.kind === 'cron' && schedule.tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: schedule.tz })
    } catch {
      throw new Error(`unknown timezone '${schedule.tz}'`)
    }
  }
}

function computeNextRun(schedule: CronSchedule, baseMs: number): number | null {
  if (schedule.kind === 'at') {
    if (schedule.atMs && schedule.atMs > baseMs) return schedule.atMs
    return null
  }
  if (schedule.kind === 'every') {
    if (!schedule.everyMs || schedule.everyMs <= 0) return null
    return baseMs + schedule.everyMs
  }
  if (schedule.kind === 'cron' && schedule.expr) {
    const next = computeNextCron(schedule.expr, new Date(baseMs))
    return next ? next.getTime() : null
  }
  return null
}

// ---- CronService ----

const MAX_RUN_HISTORY = 20

export class CronService {
  private storePath: string
  private actionPath: string
  onJob: ((job: CronJob) => Promise<string | null>) | null = null
  maxSleepMs: number

  private store: CronStore | null = null
  private running = false
  private timerActive = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    storePath: string,
    options?: { maxSleepMs?: number },
  ) {
    this.storePath = storePath
    this.actionPath = join(dirname(storePath), 'action.jsonl')
    this.maxSleepMs = options?.maxSleepMs ?? 300_000
  }

  // ---- Persistence ----

  private loadJobs(): { jobs: CronJob[]; version: number } {
    if (!existsSync(this.storePath)) return { jobs: [], version: 1 }
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf-8'))
      const version = raw.version ?? 1
      const jobs: CronJob[] = (raw.jobs ?? []).map((j: Record<string, unknown>) => ({
        id: j.id as string,
        name: j.name as string,
        enabled: (j.enabled as boolean) ?? true,
        schedule: {
          kind: ((j.schedule as Record<string, unknown>)?.kind ?? 'every') as 'at' | 'every' | 'cron',
          atMs: (j.schedule as Record<string, unknown>)?.atMs as number | undefined,
          everyMs: (j.schedule as Record<string, unknown>)?.everyMs as number | undefined,
          expr: (j.schedule as Record<string, unknown>)?.expr as string | undefined,
          tz: (j.schedule as Record<string, unknown>)?.tz as string | undefined,
        },
        payload: {
          kind: ((j.payload as Record<string, unknown>)?.kind ?? 'agent_turn') as 'system_event' | 'agent_turn',
          message: ((j.payload as Record<string, unknown>)?.message ?? '') as string,
          deliver: ((j.payload as Record<string, unknown>)?.deliver ?? false) as boolean,
          channel: (j.payload as Record<string, unknown>)?.channel as string | null | undefined,
          to: (j.payload as Record<string, unknown>)?.to as string | null | undefined,
        },
        state: {
          nextRunAtMs: ((j.state as Record<string, unknown>)?.nextRunAtMs ?? (j as Record<string, unknown>).nextRunAtMs) as number | null | undefined,
          lastRunAtMs: (j.state as Record<string, unknown>)?.lastRunAtMs as number | null | undefined,
          lastStatus: (j.state as Record<string, unknown>)?.lastStatus as 'ok' | 'error' | 'skipped' | null | undefined,
          lastError: (j.state as Record<string, unknown>)?.lastError as string | null | undefined,
          runHistory: ((j.state as Record<string, unknown>)?.runHistory ?? []) as Array<{ runAtMs: number; status: string; durationMs?: number; error?: string | null }>,
        },
        createdAtMs: j.createdAtMs as number ?? 0,
        updatedAtMs: j.updatedAtMs as number ?? 0,
        deleteAfterRun: (j.deleteAfterRun as boolean) ?? false,
      }))
      return { jobs, version }
    } catch {
      return { jobs: [], version: 1 }
    }
  }

  private saveStore(): void {
    if (!this.store) return
    mkdirSync(dirname(this.storePath), { recursive: true })
    const data = {
      version: this.store.version,
      jobs: this.store.jobs.map((j) => ({
        id: j.id,
        name: j.name,
        enabled: j.enabled,
        schedule: {
          kind: j.schedule.kind,
          atMs: j.schedule.atMs,
          everyMs: j.schedule.everyMs,
          expr: j.schedule.expr,
          tz: j.schedule.tz,
        },
        payload: {
          kind: j.payload.kind,
          message: j.payload.message,
          deliver: j.payload.deliver,
          channel: j.payload.channel,
          to: j.payload.to,
        },
        state: {
          nextRunAtMs: j.state.nextRunAtMs,
          lastRunAtMs: j.state.lastRunAtMs,
          lastStatus: j.state.lastStatus,
          lastError: j.state.lastError,
          runHistory: j.state.runHistory.slice(-MAX_RUN_HISTORY),
        },
        createdAtMs: j.createdAtMs,
        updatedAtMs: j.updatedAtMs,
        deleteAfterRun: j.deleteAfterRun,
      })),
    }
    writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  private mergeAction(): void {
    if (!existsSync(this.actionPath)) return
    if (!this.store) return

    const jobsMap = new Map<string, CronJob>()
    for (const j of this.store.jobs) jobsMap.set(j.id, j)

    try {
      const content = readFileSync(this.actionPath, 'utf-8')
      let changed = false
      for (const line of content.split('\n').filter(Boolean)) {
        try {
          const action = JSON.parse(line)
          if (!action.action) continue
          if (action.action === 'del') {
            jobsMap.delete(action.params?.job_id)
            changed = true
          } else {
            // add / update
            const params = action.params ?? {}
            if (params.id) {
              const job = reconstructJob(params)
              jobsMap.set(job.id, job)
              changed = true
            }
          }
        } catch {
          // skip corrupt line
        }
      }
      if (changed) {
        this.store.jobs = Array.from(jobsMap.values())
        writeFileSync(this.actionPath, '', 'utf-8')
        this.saveStore()
      }
    } catch {
      // ignore
    }
  }

  private loadStore(): CronStore {
    if (this.timerActive && this.store) return this.store
    const { jobs, version } = this.loadJobs()
    this.store = { version, jobs }
    this.mergeAction()
    return this.store
  }

  // ---- Timer ----

  private recomputeNextRuns(): void {
    if (!this.store) return
    const now = nowMs()
    for (const job of this.store.jobs) {
      if (job.enabled) {
        job.state.nextRunAtMs = computeNextRun(job.schedule, now)
      }
    }
  }

  private getNextWakeMs(): number | null {
    if (!this.store) return null
    const times = this.store.jobs
      .filter((j) => j.enabled && j.state.nextRunAtMs != null)
      .map((j) => j.state.nextRunAtMs!)
    return times.length ? Math.min(...times) : null
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.running) return

    const nextWake = this.getNextWakeMs()
    let delayMs = this.maxSleepMs
    if (nextWake != null) {
      delayMs = Math.min(this.maxSleepMs, Math.max(0, nextWake - nowMs()))
    }
    this.timer = setTimeout(() => {
      if (this.running) this.onTimer()
    }, delayMs)
  }

  private async onTimer(): Promise<void> {
    this.loadStore()
    if (!this.store) {
      this.armTimer()
      return
    }
    this.timerActive = true
    try {
      const now = nowMs()
      const dueJobs = this.store.jobs.filter(
        (j) => j.enabled && j.state.nextRunAtMs != null && now >= j.state.nextRunAtMs!,
      )
      for (const job of dueJobs) {
        await this.executeJob(job)
      }
      this.saveStore()
    } finally {
      this.timerActive = false
    }
    this.armTimer()
  }

  private async executeJob(job: CronJob): Promise<void> {
    const startMs = nowMs()
    console.info(`Cron: executing job '${job.name}' (${job.id})`)

    try {
      if (this.onJob) {
        await this.onJob(job)
      }
      job.state.lastStatus = 'ok'
      job.state.lastError = null
      console.info(`Cron: job '${job.name}' completed`)
    } catch (err: unknown) {
      job.state.lastStatus = 'error'
      job.state.lastError = err instanceof Error ? err.message : String(err)
      console.error(`Cron: job '${job.name}' failed: ${job.state.lastError}`)
    }

    const endMs = nowMs()
    job.state.lastRunAtMs = startMs
    job.updatedAtMs = endMs

    job.state.runHistory.push({
      runAtMs: startMs,
      status: job.state.lastStatus ?? 'ok',
      durationMs: endMs - startMs,
      error: job.state.lastError,
    })
    job.state.runHistory = job.state.runHistory.slice(-MAX_RUN_HISTORY)

    // Handle one-shot jobs
    if (job.schedule.kind === 'at') {
      if (job.deleteAfterRun) {
        this.store!.jobs = this.store!.jobs.filter((j) => j.id !== job.id)
      } else {
        job.enabled = false
        job.state.nextRunAtMs = null
      }
    } else {
      job.state.nextRunAtMs = computeNextRun(job.schedule, nowMs())
    }
  }

  // ---- Public API ----

  start(): void {
    this.running = true
    this.loadStore()
    this.recomputeNextRuns()
    this.saveStore()
    this.armTimer()
    console.info(`Cron service started with ${this.store ? this.store.jobs.length : 0} jobs`)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  listJobs(includeDisabled = false): CronJob[] {
    const store = this.loadStore()
    const jobs = includeDisabled ? store.jobs : store.jobs.filter((j) => j.enabled)
    return [...jobs].sort(
      (a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity),
    )
  }

  addJob(params: {
    name: string
    schedule: CronSchedule
    message: string
    deliver?: boolean
    channel?: string | null
    to?: string | null
    deleteAfterRun?: boolean
  }): CronJob {
    validateSchedule(params.schedule)
    const now = nowMs()

    const job: CronJob = {
      id: Math.random().toString(36).slice(2, 10),
      name: params.name,
      enabled: true,
      schedule: params.schedule,
      payload: {
        kind: 'agent_turn',
        message: params.message,
        deliver: params.deliver ?? false,
        channel: params.channel ?? null,
        to: params.to ?? null,
      },
      state: {
        nextRunAtMs: computeNextRun(params.schedule, now),
        runHistory: [],
      },
      createdAtMs: now,
      updatedAtMs: now,
      deleteAfterRun: params.deleteAfterRun ?? false,
    }

    if (this.running) {
      const store = this.loadStore()
      store.jobs.push(job)
      this.saveStore()
      this.armTimer()
    } else {
      this.appendAction('add', job)
    }

    console.info(`Cron: added job '${params.name}' (${job.id})`)
    return job
  }

  registerSystemJob(job: CronJob): CronJob {
    const now = nowMs()
    job.state.nextRunAtMs = computeNextRun(job.schedule, now)
    job.createdAtMs = now
    job.updatedAtMs = now
    const store = this.loadStore()
    store.jobs = store.jobs.filter((j) => j.id !== job.id)
    store.jobs.push(job)
    this.saveStore()
    this.armTimer()
    console.info(`Cron: registered system job '${job.name}' (${job.id})`)
    return job
  }

  removeJob(jobId: string): 'removed' | 'protected' | 'not_found' {
    const store = this.loadStore()
    const job = store.jobs.find((j) => j.id === jobId)
    if (!job) return 'not_found'
    if (job.payload.kind === 'system_event') {
      console.info(`Cron: refused to remove protected system job ${jobId}`)
      return 'protected'
    }
    const before = store.jobs.length
    store.jobs = store.jobs.filter((j) => j.id !== jobId)
    if (store.jobs.length < before) {
      if (this.running) {
        this.saveStore()
        this.armTimer()
      } else {
        this.appendAction('del', { job_id: jobId })
      }
      console.info(`Cron: removed job ${jobId}`)
      return 'removed'
    }
    return 'not_found'
  }

  enableJob(jobId: string, enabled = true): CronJob | null {
    const store = this.loadStore()
    const job = store.jobs.find((j) => j.id === jobId)
    if (!job) return null
    job.enabled = enabled
    job.updatedAtMs = nowMs()
    if (enabled) {
      job.state.nextRunAtMs = computeNextRun(job.schedule, nowMs())
    } else {
      job.state.nextRunAtMs = null
    }
    if (this.running) {
      this.saveStore()
      this.armTimer()
    } else {
      this.appendAction('update', job)
    }
    return job
  }

  updateJob(
    jobId: string,
    updates: {
      name?: string
      schedule?: CronSchedule
      message?: string
      deliver?: boolean
      channel?: 'unchanged' | string | null
      to?: 'unchanged' | string | null
      deleteAfterRun?: boolean
    },
  ): CronJob | 'not_found' | 'protected' {
    const store = this.loadStore()
    const job = store.jobs.find((j) => j.id === jobId)
    if (!job) return 'not_found'
    if (job.payload.kind === 'system_event') return 'protected'

    if (updates.schedule !== undefined) {
      validateSchedule(updates.schedule)
      job.schedule = updates.schedule
    }
    if (updates.name !== undefined) job.name = updates.name
    if (updates.message !== undefined) job.payload.message = updates.message
    if (updates.deliver !== undefined) job.payload.deliver = updates.deliver
    if (updates.channel !== 'unchanged' && updates.channel !== undefined) {
      job.payload.channel = updates.channel
    }
    if (updates.to !== 'unchanged' && updates.to !== undefined) {
      job.payload.to = updates.to
    }
    if (updates.deleteAfterRun !== undefined) job.deleteAfterRun = updates.deleteAfterRun

    job.updatedAtMs = nowMs()
    if (job.enabled) {
      job.state.nextRunAtMs = computeNextRun(job.schedule, nowMs())
    }

    if (this.running) {
      this.saveStore()
      this.armTimer()
    } else {
      this.appendAction('update', job)
    }
    console.info(`Cron: updated job '${job.name}' (${job.id})`)
    return job
  }

  async runJob(jobId: string, force = false): Promise<boolean> {
    const wasRunning = this.running
    this.running = true
    try {
      const store = this.loadStore()
      for (const job of store.jobs) {
        if (job.id === jobId) {
          if (!force && !job.enabled) return false
          await this.executeJob(job)
          this.saveStore()
          return true
        }
      }
      return false
    } finally {
      this.running = wasRunning
      if (wasRunning) this.armTimer()
    }
  }

  getJob(jobId: string): CronJob | undefined {
    const store = this.loadStore()
    return store.jobs.find((j) => j.id === jobId)
  }

  status(): { enabled: boolean; jobs: number; nextWakeAtMs: number | null } {
    const store = this.loadStore()
    return {
      enabled: this.running,
      jobs: store.jobs.length,
      nextWakeAtMs: this.getNextWakeMs(),
    }
  }

  // ---- Action queue for cross-process operations ----

  private appendAction(
    action: 'add' | 'del' | 'update',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any,
  ): void {
    mkdirSync(dirname(this.actionPath), { recursive: true })
    appendFileSync(this.actionPath, JSON.stringify({ action, params }) + '\n', 'utf-8')
  }
}

// ---- Helper: reconstruct a CronJob from its serialized form ----

function reconstructJob(params: Record<string, unknown>): CronJob {
  return {
    id: params.id as string,
    name: params.name as string,
    enabled: (params.enabled as boolean) ?? true,
    schedule: params.schedule as CronSchedule ?? { kind: 'every' },
    payload: params.payload as CronPayload ?? { kind: 'agent_turn', message: '', deliver: false },
    state: params.state as CronJobState ?? { runHistory: [] },
    createdAtMs: params.createdAtMs as number ?? 0,
    updatedAtMs: params.updatedAtMs as number ?? 0,
    deleteAfterRun: (params.deleteAfterRun as boolean) ?? false,
  }
}
