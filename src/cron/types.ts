/**
 * Cron types — 1:1 port of nanobot/cron/types.py
 */

export interface CronSchedule {
  kind: 'at' | 'every' | 'cron'
  atMs?: number
  everyMs?: number
  expr?: string
  tz?: string
}

export interface CronPayload {
  kind: 'system_event' | 'agent_turn'
  message: string
  deliver: boolean
  channel?: string | null
  to?: string | null
}

export interface CronRunRecord {
  runAtMs: number
  status: 'ok' | 'error' | 'skipped'
  durationMs: number
  error?: string | null
}

export interface CronJobState {
  nextRunAtMs?: number | null
  lastRunAtMs?: number | null
  lastStatus?: 'ok' | 'error' | 'skipped' | null
  lastError?: string | null
  runHistory: CronRunRecord[]
}

export interface CronJob {
  id: string
  name: string
  enabled: boolean
  schedule: CronSchedule
  payload: CronPayload
  state: CronJobState
  createdAtMs: number
  updatedAtMs: number
  deleteAfterRun: boolean
}

export interface CronStore {
  version: number
  jobs: CronJob[]
}
