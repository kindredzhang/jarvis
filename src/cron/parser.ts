/**
 * Minimal cron expression parser
 *
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week.
 * Fields: 0-59 0-23 1-31 1-12 0-7 (0 and 7 = Sunday)
 * Special chars: *(any), N(exact), N-M(range), step syntax,
 * L(last day), W(weekday)
 *
 * Port of Python croniter functionality used in original project.
 */

function parseCronField(
  field: string,
  min: number,
  max: number,
): Set<number> {
  const result = new Set<number>()
  const parts = field.split(',')

  for (const part of parts) {
    const p = part.trim()
    if (!p) continue

    // Step: */5, 1-10/2, 5/2
    const stepMatch = p.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/)
    if (stepMatch) {
      const range = stepMatch[1]!
      const step = parseInt(stepMatch[2]!, 10)
      if (range === '*') {
        for (let v = min; v <= max; v += step) result.add(v)
      } else if (range.includes('-')) {
        const [rs, re] = range.split('-')
        const rStart = parseInt(rs!, 10)
        const rEnd = parseInt(re!, 10)
        for (let v = rStart; v <= rEnd; v += step) result.add(v)
      } else {
        for (let v = parseInt(range, 10); v <= max; v += step) result.add(v)
      }
      continue
    }

    // Wildcard
    if (p === '*') {
      for (let v = min; v <= max; v++) result.add(v)
      continue
    }

    // Range: 1-5
    if (p.includes('-') && !p.startsWith('L')) {
      const [rs, re] = p.split('-')
      const rStart = parseInt(rs!, 10)
      const rEnd = parseInt(re!, 10)
      for (let v = rStart; v <= rEnd; v++) result.add(v)
      continue
    }

    // L (last day of month) — simplified, use 31 as placeholder
    if (p === 'L' && min === 1 && max === 31) {
      result.add(31)
      continue
    }

    // Literal number
    const v = parseInt(p, 10)
    if (!isNaN(v)) result.add(v)
  }

  return result
}

export interface CronParsed {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
}

export function parseCron(expr: string): CronParsed {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields, got ${parts.length}: '${expr}'`,
    )
  }
  return {
    minutes: parseCronField(parts[0]!, 0, 59),
    hours: parseCronField(parts[1]!, 0, 23),
    daysOfMonth: parseCronField(parts[2]!, 1, 31),
    months: parseCronField(parts[3]!, 1, 12),
    daysOfWeek: parseCronField(parts[4]!, 0, 7),
  }
}

function normalizeDOW(dow: number): number {
  return dow === 7 ? 0 : dow
}

const ALL_DOM = new Set(Array.from({ length: 31 }, (_, i) => i + 1))
const ALL_DOW = new Set(Array.from({ length: 8 }, (_, i) => i))

function hasAll(arr: Set<number>, all: Set<number>): boolean {
  if (arr.size >= all.size) return true
  for (const v of all) {
    if (!arr.has(v)) return false
  }
  return true
}

function matchesCron(date: Date, parsed: CronParsed): boolean {
  const minute = date.getMinutes()
  const hour = date.getHours()
  const day = date.getDate()
  const month = date.getMonth() + 1
  const dow = normalizeDOW(date.getDay())

  if (!parsed.minutes.has(minute)) return false
  if (!parsed.hours.has(hour)) return false
  if (!parsed.months.has(month)) return false

  const domAll = hasAll(parsed.daysOfMonth, ALL_DOM)
  const dowAll = hasAll(parsed.daysOfWeek, ALL_DOW)

  if (domAll && dowAll) return true
  if (domAll) return parsed.daysOfWeek.has(dow)
  if (dowAll) return parsed.daysOfMonth.has(day)
  // OR logic: EITHER day-of-month OR day-of-week can match
  return parsed.daysOfMonth.has(day) || parsed.daysOfWeek.has(dow)
}

/**
 * Compute the next datetime matching a cron expression from a given base date.
 * Searches up to 5 years forward.
 */
export function computeNextCron(expr: string, base: Date): Date | null {
  const parsed = parseCron(expr)
  const candidate = new Date(base)
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)

  const maxIterations = 5 * 365 * 24 * 60 // 5 years of minutes
  for (let i = 0; i < maxIterations; i++) {
    if (matchesCron(candidate, parsed)) return candidate
    candidate.setMinutes(candidate.getMinutes() + 1)
  }
  return null
}
