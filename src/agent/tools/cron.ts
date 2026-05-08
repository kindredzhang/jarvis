/**
 * CronTool —— schedule reminders and recurring tasks
 *
 * Ported from Python original agent/tools/cron.py (279 lines).
 */

import { Tool, defineParams } from './base'
import type { CronService } from '../../cron/service'
import type { CronSchedule, CronJob } from '../../cron/types'

const _CRON_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'list', 'remove'],
      description: 'Action to perform',
    },
    name: {
      type: 'string',
      description:
        "Optional short human-readable label for the job " +
        "(e.g., 'weather-monitor', 'daily-standup'). Defaults to first 30 chars of message.",
    },
    message: {
      type: 'string',
      description:
        "REQUIRED when action='add'. Instruction for the agent to execute when the job triggers " +
        "(e.g., 'Send a reminder to WeChat: xxx' or 'Check system status and report'). " +
        "Not used for action='list' or action='remove'.",
    },
    every_seconds: {
      type: 'integer',
      description: 'Interval in seconds (for recurring tasks)',
    },
    cron_expr: {
      type: 'string',
      description: "Cron expression like '0 9 * * *' (for scheduled tasks)",
    },
    tz: {
      type: 'string',
      description:
        "Optional IANA timezone for cron expressions (e.g. 'America/Vancouver'). " +
        "When omitted with cron_expr, the tool's default timezone applies.",
    },
    at: {
      type: 'string',
      description:
        "ISO datetime for one-time execution (e.g. '2026-02-12T10:30:00'). " +
        "Naive values use the tool's default timezone.",
    },
    deliver: {
      type: 'boolean',
      description: 'Whether to deliver the execution result to the user channel (default true)',
    },
    job_id: {
      type: 'string',
      description: "REQUIRED when action='remove'. Job ID to remove (obtain via action='list').",
    },
  },
  required: ['action'],
  description:
    "Action-specific parameters: add requires a non-empty message plus one schedule " +
    "(every_seconds, cron_expr, or at); remove requires job_id; list only needs action. " +
    "Per-action requirements are enforced at runtime so the " +
    "top-level schema stays compatible with providers that " +
    "reject oneOf/anyOf/allOf/enum/not at the root of function parameters.",
} as const

export class CronTool extends Tool {
  readonly name = 'cron'
  readonly parameters = defineParams({ ..._CRON_PARAMETERS })

  private cron: CronService
  private defaultTimezone: string
  private _channel = ''
  private _chatId = ''
  private _inCronContext = false

  constructor(cronService: CronService, defaultTimezone = 'UTC') {
    super()
    this.cron = cronService
    this.defaultTimezone = defaultTimezone
  }

  get description(): string {
    return (
      'Schedule reminders and recurring tasks. Actions: add, list, remove. ' +
      `If tz is omitted, cron expressions and naive ISO times default to ${this.defaultTimezone}.`
    )
  }

  setContext(channel: string, chatId: string): void {
    this._channel = channel
    this._chatId = chatId
  }

  setCronContext(active: boolean): void {
    this._inCronContext = active
  }

  // ---- Parameter validation ----

  override validateParams(params: Record<string, unknown>): string[] {
    const errors = super.validateParams(params)
    const action = params.action as string | undefined
    if (action === 'add' && !String(params.message ?? '').trim()) {
      errors.push("message is required when action='add'")
    }
    if (action === 'remove' && !String(params.job_id ?? '').trim()) {
      errors.push("job_id is required when action='remove'")
    }
    return errors
  }

  // ---- Execute ----

  async execute(
    args: Record<string, unknown>,
  ): Promise<string> {
    const action = (args.action as string) ?? ''
    const name = (args.name as string) ?? null
    const message = (args.message as string) ?? ''
    const everySeconds = args.every_seconds as number | undefined
    const cronExpr = (args.cron_expr as string) ?? null
    const tz = (args.tz as string) ?? null
    const at = (args.at as string) ?? null
    const jobId = (args.job_id as string) ?? null
    const deliver = (args.deliver as boolean) ?? true

    if (action === 'add') {
      if (this._inCronContext) {
        return 'Error: cannot schedule new jobs from within a cron job execution'
      }
      return this._addJob(name, message, everySeconds, cronExpr, tz, at, deliver)
    }
    if (action === 'list') return this._listJobs()
    if (action === 'remove') return this._removeJob(jobId)
    return `Unknown action: ${action}`
  }

  // ---- Add ----

  private _addJob(
    name: string | null,
    message: string,
    everySeconds: number | undefined,
    cronExpr: string | null,
    tz: string | null,
    at: string | null,
    deliver: boolean,
  ): string {
    if (!message) {
      return (
        "Error: cron action='add' requires a non-empty 'message' parameter " +
        'describing what to do when the job triggers ' +
        '(e.g. the reminder text). Retry including message="...".'
      )
    }
    if (!this._channel || !this._chatId) {
      return 'Error: no session context (channel/chat_id)'
    }
    if (tz && !cronExpr) {
      return 'Error: tz can only be used with cron_expr'
    }
    if (tz) {
      const err = CronTool._validateTimezone(tz)
      if (err) return err
    }

    // Build schedule
    let deleteAfter = false
    let schedule: CronSchedule

    if (everySeconds !== undefined && everySeconds > 0) {
      schedule = { kind: 'every', everyMs: everySeconds * 1000 }
    } else if (cronExpr) {
      const effectiveTz = tz || this.defaultTimezone
      const err = CronTool._validateTimezone(effectiveTz)
      if (err) return err
      schedule = { kind: 'cron', expr: cronExpr, tz: effectiveTz }
    } else if (at) {
      try {
        const dt = new Date(at)
        if (isNaN(dt.getTime())) {
          return `Error: invalid ISO datetime format '${at}'. Expected format: YYYY-MM-DDTHH:MM:SS`
        }
        const atMs = dt.getTime()
        schedule = { kind: 'at', atMs }
        deleteAfter = true
      } catch {
        return `Error: invalid ISO datetime format '${at}'. Expected format: YYYY-MM-DDTHH:MM:SS`
      }
    } else {
      return 'Error: either every_seconds, cron_expr, or at is required'
    }

    const job = this.cron.addJob({
      name: name || message.slice(0, 30),
      schedule,
      message,
      deliver,
      channel: this._channel,
      to: this._chatId,
      deleteAfterRun: deleteAfter,
    })
    return `Created job '${job.name}' (id: ${job.id})`
  }

  // ---- Formatting ----

  private _formatTiming(schedule: CronSchedule): string {
    if (schedule.kind === 'cron') {
      const tz = schedule.tz ? ` (${schedule.tz})` : ''
      return `cron: ${schedule.expr}${tz}`
    }
    if (schedule.kind === 'every' && schedule.everyMs) {
      const ms = schedule.everyMs
      if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`
      if (ms % 60_000 === 0) return `every ${ms / 60_000}m`
      if (ms % 1000 === 0) return `every ${ms / 1000}s`
      return `every ${ms}ms`
    }
    if (schedule.kind === 'at' && schedule.atMs) {
      return `at ${CronTool._formatTimestamp(schedule.atMs, this._displayTimezone(schedule))}`
    }
    return schedule.kind
  }

  private _displayTimezone(schedule: CronSchedule): string {
    return schedule.tz || this.defaultTimezone
  }

  static _formatTimestamp(ms: number, tzName: string): string {
    const date = new Date(ms)
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tzName,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    const parts = formatter.formatToParts(date)
    const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]))
    return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second} (${tzName})`
  }

  private _formatState(job: CronJob): string[] {
    const lines: string[] = []
    const displayTz = this._displayTimezone(job.schedule)
    if (job.state.lastRunAtMs) {
      let info =
        `  Last run: ${CronTool._formatTimestamp(job.state.lastRunAtMs, displayTz)}` +
        ` — ${job.state.lastStatus || 'unknown'}`
      if (job.state.lastError) info += ` (${job.state.lastError})`
      lines.push(info)
    }
    if (job.state.nextRunAtMs) {
      lines.push(`  Next run: ${CronTool._formatTimestamp(job.state.nextRunAtMs, displayTz)}`)
    }
    return lines
  }

  static _systemJobPurpose(job: CronJob): string {
    if (job.name === 'dream') return 'Dream memory consolidation for long-term memory.'
    return 'System-managed internal job.'
  }

  static _validateTimezone(tz: string): string | null {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
    } catch {
      return `Error: unknown timezone '${tz}'`
    }
    return null
  }

  // ---- List ----

  private _listJobs(): string {
    const jobs = this.cron.listJobs()
    if (jobs.length === 0) return 'No scheduled jobs.'
    const lines: string[] = []
    for (const j of jobs) {
      const timing = this._formatTiming(j.schedule)
      const parts = [`- ${j.name} (id: ${j.id}, ${timing})`]
      if (j.payload.kind === 'system_event') {
        parts.push(`  Purpose: ${CronTool._systemJobPurpose(j)}`)
        parts.push('  Protected: visible for inspection, but cannot be removed.')
      }
      parts.push(...this._formatState(j))
      lines.push(parts.join('\n'))
    }
    return 'Scheduled jobs:\n' + lines.join('\n')
  }

  // ---- Remove ----

  private _removeJob(jobId: string | null): string {
    if (!jobId) return 'Error: job_id is required for remove'
    const result = this.cron.removeJob(jobId)
    if (result === 'removed') return `Removed job ${jobId}`
    if (result === 'protected') {
      const job = this.cron.getJob(jobId)
      if (job && job.name === 'dream') {
        return (
          'Cannot remove job `dream`.\n' +
          'This is a system-managed Dream memory consolidation job for long-term memory.\n' +
          'It remains visible so you can inspect it, but it cannot be removed.'
        )
      }
      return `Cannot remove job \`${jobId}\`.\nThis is a protected system-managed cron job.`
    }
    return `Job ${jobId} not found`
  }
}
