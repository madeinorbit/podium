/**
 * A small, hand-rolled 5-field cron parser (#470) [spec:SP-17db].
 *
 * Deliberately no dependency: the scheduler needs exactly two things — "is this
 * expression valid?" (composer + create/update validation) and "what is the first
 * occurrence strictly after T?" (the re-arm) — and a 60-line parser we own is
 * cheaper to reason about (and to test at the DST/leap-day boundaries) than a
 * transitive dependency.
 *
 * Grammar per field: `*`, `n`, `a-b`, `*<slash>s`, `a-b<slash>s`, and comma lists of
 * those. Fields, in order: minute (0–59), hour (0–23), day-of-month (1–31),
 * month (1–12), day-of-week (0–6, Sunday = 0; 7 is accepted as Sunday).
 *
 * Time base: SERVER-LOCAL time [spec:SP-17db] — no per-automation timezone in this
 * pass. Occurrences are built with the local-time Date constructor, so a DST jump
 * behaves the way the platform does (a skipped 02:30 lands at 03:30 on the spring
 * forward; an ambiguous autumn 02:30 resolves to the first pass). Cron's classic
 * behavior, and honest for a home-server scheduler.
 */

export interface CronSpec {
  /** Sorted, de-duplicated matching values per field. */
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  /** Was day-of-month restricted (not `*`)? Drives the classic OR rule below. */
  domRestricted: boolean
  dowRestricted: boolean
}

interface FieldRange {
  name: string
  min: number
  max: number
}

const FIELDS: FieldRange[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 }, // 7 = Sunday, normalized to 0
]

/** Widest sensible search horizon: 4 years covers `0 0 29 2 *` (Feb 29) from any
 *  start date, and bounds the loop for an expression that can never match. */
const MAX_DAYS_AHEAD = 4 * 366 + 1

class CronError extends Error {}

/** Parse one field into its sorted matching values. Throws CronError on garbage. */
function parseField(raw: string, field: FieldRange): number[] {
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    const [rangePart, stepPart, ...rest] = part.split('/')
    if (rest.length > 0 || rangePart === undefined) {
      throw new CronError(`invalid ${field.name} field: ${part}`)
    }
    let step = 1
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) {
        throw new CronError(`invalid step in ${field.name} field: ${part}`)
      }
      step = Number(stepPart)
    }
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = field.min
      hi = field.max
    } else {
      const match = rangePart.match(/^(\d+)(?:-(\d+))?$/)
      if (!match) throw new CronError(`invalid ${field.name} field: ${part}`)
      lo = Number(match[1])
      hi = match[2] !== undefined ? Number(match[2]) : lo
      // `5/15` (a bare value with a step) means "from 5 to the field max, every 15"
      // — the same reading vixie cron gives it.
      if (match[2] === undefined && stepPart !== undefined) hi = field.max
    }
    if (lo < field.min || hi > field.max || lo > hi) {
      throw new CronError(`${field.name} out of range (${field.min}-${field.max}): ${part}`)
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return [...values].sort((a, b) => a - b)
}

/**
 * Parse a 5-field cron expression. Throws (with a human-readable message that is
 * safe to surface in the composer) when the expression is not valid.
 */
export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronError(
      `cron must have 5 fields (minute hour day month weekday), got ${expr.trim() === '' ? 0 : parts.length}`,
    )
  }
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string]
  const daysOfWeek = parseField(dow, FIELDS[4]!).map((d) => d % 7)
  return {
    minutes: parseField(minute, FIELDS[0]!),
    hours: parseField(hour, FIELDS[1]!),
    daysOfMonth: parseField(dom, FIELDS[2]!),
    months: parseField(month, FIELDS[3]!),
    daysOfWeek: [...new Set(daysOfWeek)].sort((a, b) => a - b),
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  }
}

/** True when the expression parses. The composer's and the service's validation seam. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

/**
 * Does this calendar day match? The classic (and surprising) cron rule: when BOTH
 * day-of-month and day-of-week are restricted the day matches if EITHER does —
 * `0 0 1 * 1` fires on the 1st *and* on every Monday. When only one is restricted
 * (the common case), only that one applies.
 */
function dayMatches(spec: CronSpec, day: Date): boolean {
  if (!spec.months.includes(day.getMonth() + 1)) return false
  const dom = spec.daysOfMonth.includes(day.getDate())
  const dow = spec.daysOfWeek.includes(day.getDay())
  if (spec.domRestricted && spec.dowRestricted) return dom || dow
  if (spec.domRestricted) return dom
  if (spec.dowRestricted) return dow
  return true
}

/**
 * The first occurrence STRICTLY after `after`, in server-local time. Returns null
 * when the expression cannot match within the search horizon (e.g. `0 0 30 2 *` —
 * February 30th). Strictness is what keeps a fired automation from re-firing on
 * the same minute in a tight loop [spec:SP-17db].
 */
export function nextAfter(spec: CronSpec, after: Date): Date | null {
  // Round up to the next whole minute: cron has minute granularity, and `after` is
  // a wall-clock instant that may sit mid-minute.
  const floor = new Date(after.getTime())
  floor.setSeconds(0, 0)
  floor.setMinutes(floor.getMinutes() + 1)
  for (let offset = 0; offset < MAX_DAYS_AHEAD; offset++) {
    const day = new Date(floor.getFullYear(), floor.getMonth(), floor.getDate() + offset)
    if (!dayMatches(spec, day)) continue
    for (const h of spec.hours) {
      for (const m of spec.minutes) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0)
        if (candidate.getTime() >= floor.getTime()) return candidate
      }
    }
  }
  return null
}

/** Convenience for the callers that only hold the raw expression. Throws on an
 *  invalid expression (the service validates on create/update, so a throw here
 *  means a hand-edited row). */
export function nextRunAfter(expr: string, after: Date): Date | null {
  return nextAfter(parseCron(expr), after)
}

/**
 * The rate floor (#470) [spec:SP-17db]: an automation may not be scheduled to fire
 * more often than once every 5 minutes.
 *
 * This is a SAFETY limit, not a taste one. Every fire spawns a real agent session
 * that costs real tokens; `* * * * *` is a 1440-sessions-per-day footgun that a
 * single empty cron box used to be able to arm.
 */
export const MIN_SCHEDULE_INTERVAL_MS = 5 * 60_000

/** Occurrences to walk before giving up — bounds a pathological expression. A dense
 *  legal cron (`*<slash>5 * * * *`) has 288 in the window; the cap is far above it, and the
 *  scan short-circuits the moment it finds a violation. */
const MAX_OCCURRENCES_SCANNED = 2000

/** How far past the first occurrence to look for the tightest gap. A cron's
 *  (hour, minute) fire pattern repeats identically on every matching day, so one
 *  day plus an hour of slack sees every intra-day gap AND the midnight wrap
 *  (`59 23 * * *` + `0 0 * * *` is a 1-minute gap across the day boundary). */
const GAP_SCAN_HORIZON_MS = 25 * 60 * 60_000

/**
 * The tightest gap between two consecutive fires of this schedule, or null when it
 * fires at most once in the scan horizon (weekly, monthly, never) — such a schedule
 * cannot violate the floor.
 *
 * Anchored at the FIRST occurrence rather than at `from`: anchoring at wall-clock
 * "now" would make the answer depend on the moment the operator clicked Create.
 * `0,1 9 * * *` (two fires a minute apart, every morning) reads as a 24-hour gap
 * from a 09:00:30 "now" and a 1-minute gap from any other — a validator that says
 * yes or no depending on the second it ran is not a validator.
 */
export function minIntervalMs(spec: CronSpec, from: Date = new Date()): number | null {
  const first = nextAfter(spec, from)
  if (!first) return null // never fires
  const horizon = first.getTime() + GAP_SCAN_HORIZON_MS
  let prev = first
  let min = Number.POSITIVE_INFINITY
  for (let i = 0; i < MAX_OCCURRENCES_SCANNED; i++) {
    const next = nextAfter(spec, prev)
    if (!next || next.getTime() > horizon) break
    min = Math.min(min, next.getTime() - prev.getTime())
    if (min < MIN_SCHEDULE_INTERVAL_MS) break // a violation is a violation — stop early
    prev = next
  }
  return Number.isFinite(min) ? min : null
}

/**
 * Does this expression respect the rate floor? An expression that does not PARSE
 * returns true — it is invalid for a different reason, and the parse error is the
 * one worth showing (this is the zod refine's contract: one failure, one message).
 */
export function respectsScheduleFloor(expr: string, from: Date = new Date()): boolean {
  let spec: CronSpec
  try {
    spec = parseCron(expr)
  } catch {
    return true
  }
  const gap = minIntervalMs(spec, from)
  return gap === null || gap >= MIN_SCHEDULE_INTERVAL_MS
}

/** The human message the composer and the tRPC edge both show for a floor violation. */
export const SCHEDULE_FLOOR_MESSAGE =
  'schedule is too frequent — an automation may fire at most once every 5 minutes (each fire spawns a real agent session)'

/** Throws when `expr` fires more often than the floor allows. The service's guard:
 *  the zod edge rejects this first for tRPC callers, but the invariant belongs to
 *  the service too, so no future caller can persist a runaway schedule. */
export function assertScheduleFloor(expr: string, from: Date = new Date()): void {
  if (!respectsScheduleFloor(expr, from)) throw new CronError(SCHEDULE_FLOOR_MESSAGE)
}
