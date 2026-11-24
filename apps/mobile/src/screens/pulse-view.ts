import {
  type CapacityView,
  formatShare,
  formatUsd,
  type ProjectCostRow,
  type ProjectCostView,
  type UsageSummaryView,
} from '@podium/client-core/values'

/**
 * Presentation behind the Pulse tab [POD-2379]: ranges, the hero trace and the
 * copy. Every reading — quota rows, task and project costs, model shares and
 * the share rounding — is client-core's; this file only arranges it.
 */

/**
 * The range button offers ONLY the windows `usageSummary` already computes.
 * A third choice would need a new range query, which the data plan rules out.
 */
export type PulseRange = 'week' | 'fiveHour'

export const PULSE_RANGES: readonly { value: PulseRange; label: string; short: string }[] = [
  { value: 'week', label: 'Last 7 days', short: '7 days' },
  { value: 'fiveHour', label: 'Last 5 hours', short: '5 hours' },
]

export function rangeLabel(range: PulseRange): string {
  return PULSE_RANGES.find((r) => r.value === range)?.label ?? 'Last 7 days'
}

export function rangeShort(range: PulseRange): string {
  return PULSE_RANGES.find((r) => r.value === range)?.short ?? '7 days'
}

/** One bar of the hourly trace. `future` slots are drawn as the shaded tail. */
export interface TraceSlot {
  startMs: number
  costUsd: number
  future: boolean
}

/** A weekday column under the trace: name and that day's cost. */
export interface DayColumn {
  key: string
  weekday: string
  costUsd: number
}

export interface PulseHero {
  costUsd: number
  /** "3–9 Nov" for the week, "Last 5 hours" for the short range. */
  spanLabel: string
  slots: TraceSlot[]
  /** Empty for the five-hour range: five bars have no day boundaries. */
  days: DayColumn[]
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "3–9 Nov", or "28 Oct – 3 Nov" across a month boundary. */
export function daySpanLabel(summary: Pick<UsageSummaryView, 'days'>): string {
  const first = summary.days[0]?.hours[0]?.startMs
  const last = summary.days.at(-1)?.hours[0]?.startMs
  if (first === undefined || last === undefined) return ''
  const a = new Date(first)
  const b = new Date(last)
  if (a.getMonth() === b.getMonth()) {
    return `${a.getDate()}–${b.getDate()} ${MONTH[b.getMonth()]}`
  }
  return `${a.getDate()} ${MONTH[a.getMonth()]} – ${b.getDate()} ${MONTH[b.getMonth()]}`
}

/**
 * The hero for the chosen range.
 *
 * WEEK: every hour slot of the seven local days, oldest first, with the rest of
 * today kept as future slots so the trace keeps its full width and the shaded
 * tail says "not yet" instead of reading as a collapse in spend.
 *
 * FIVE HOURS: the last five slots up to the current hour. `usageSummary`'s
 * `fiveHour` window counts buckets whose hour starts within the last five
 * hours, which is exactly those five slots, so the bars sum to the figure.
 */
export function pulseHero(summary: UsageSummaryView, range: PulseRange): PulseHero {
  const all: TraceSlot[] = summary.days.flatMap((day) =>
    day.hours.map((h) => ({ startMs: h.startMs, costUsd: h.estCostUsd, future: h.future })),
  )
  if (range === 'fiveHour') {
    const past = all.filter((slot) => !slot.future)
    return {
      costUsd: summary.fiveHour.estCostUsd,
      spanLabel: 'Last 5 hours',
      slots: past.slice(-5),
      days: [],
    }
  }
  return {
    costUsd: summary.week.estCostUsd,
    spanLabel: daySpanLabel(summary),
    slots: all,
    days: summary.days.map((day) => ({
      key: day.day,
      weekday: WEEKDAY[new Date(day.hours[0]?.startMs ?? 0).getDay()] ?? '',
      costUsd: day.estCostUsd,
    })),
  }
}

/** The large title's subtitle line: "$1,284 in the last 7 days". */
export function pulseSubtitle(hero: PulseHero, range: PulseRange, cold: boolean): string {
  if (cold) return 'Taking a reading…'
  return `${formatUsd(hero.costUsd)} in the ${rangeLabel(range).toLowerCase()}`
}

/** The Quota header's one-line verdict: client-core's capacity headline. */
export interface QuotaVerdict {
  text: string
  /** Something is out or close: drawn in the signal tint. */
  signal: boolean
}

/**
 * The verdict is `capacityView`'s headline as-is [POD-2385]: the rule that it
 * never reads "Room to run" while a pool is out lives there, shared with the
 * desktop. This only decides whether there is a reading to show at all.
 */
export function quotaVerdict(view: CapacityView): QuotaVerdict | null {
  if (view.constraint === 'unknown') return null
  return { text: view.headline, signal: view.tone !== 'ok' || view.spentPools.length > 0 }
}

/** "14 tasks · claude-opus-5 most" — the Top projects row's subtitle. */
export function projectSubtitle(row: ProjectCostRow): string {
  const tasks = `${row.taskCount} ${row.taskCount === 1 ? 'task' : 'tasks'}`
  return row.topModel ? `${tasks} · ${row.topModel} most` : tasks
}

/** "82% attributed" for the Top projects header; nothing before a reading. */
export function attributedLabel(view: ProjectCostView | null): string | undefined {
  if (view?.attributedPercent == null) return undefined
  // The desktop's attribution rule: attributed share of the window, one decimal.
  return `${formatShare(view.attributedPercent, 100)} attributed`
}
