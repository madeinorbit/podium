import {
  type AccountQuotaGroup,
  agentLabel,
  formatReset,
  formatUsd,
  modelLimitNote,
  paceLabel,
  splitQuotaWindows,
  statusNote,
  type TaskCostRowView,
  taskCostRows,
  type UsageProvider,
  type UsageSummaryView,
  windowElapsedPercent,
  windowPace,
} from '@podium/client-core/values'
import type { AgentKind, TaskCostRowWire } from '@podium/model'

/**
 * Pure readings behind the Pulse tab [POD-2379]. Everything here is a
 * projection of values the shared client-core modules already compute: the
 * usage summary, the quota groups and the priced `cost.tasks` rows. No new
 * aggregate, no second rounding rule.
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

/** One gating window of one pool: the unit a person actually runs out of. */
export interface QuotaRowView {
  key: string
  agent: AgentKind
  /** "Claude Code · Weekly". */
  title: string
  /** Null for a pool we cannot read; the row then shows only its status line. */
  usedPercent: number | null
  /** The window is used up. P4's verdict reads this flag. */
  out: boolean
  /** 0–100 share of the window elapsed, for the pace tick. */
  elapsedPercent: number | null
  /** "On pace", "Used up", or the pool's status note. */
  paceText: string
  /** "Resets in 9h 4m". */
  resetText: string
  /** Set when the pool has already lost a model-scoped bucket. */
  modelNote: string | null
}

function capitalise(text: string): string {
  return text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : text
}

/**
 * Every readable pool's gating windows, tightest first, then a status row for
 * each pool we cannot read.
 *
 * Model-scoped windows are not rows: spending one drops that model, not the
 * harness (POD-271), so they become a note under the pool instead.
 */
export function quotaRows(groups: readonly AccountQuotaGroup[], nowMs: number): QuotaRowView[] {
  const readable: QuotaRowView[] = []
  const unreadable: QuotaRowView[] = []
  for (const group of groups) {
    const name = agentLabel(group.agent)
    if (group.status !== 'ok') {
      unreadable.push({
        key: `${group.key}:status`,
        agent: group.agent,
        title: name,
        usedPercent: null,
        out: false,
        elapsedPercent: null,
        paceText: statusNote(group),
        resetText: '',
        modelNote: null,
      })
      continue
    }
    const modelNote = modelLimitNote(group.agent, group.windows)
    for (const window of splitQuotaWindows(group.windows).gating) {
      const used = Math.max(0, Math.min(100, window.usedPercent))
      const out = window.usedPercent >= 100
      const pace = windowPace(window, nowMs)
      readable.push({
        key: `${group.key}:${window.key}`,
        agent: group.agent,
        title: `${name} · ${window.label}`,
        usedPercent: used,
        out,
        elapsedPercent: windowElapsedPercent(window.resetsAt, window.windowMinutes, nowMs),
        paceText: out ? 'Used up' : pace ? paceLabel(pace) : '',
        resetText: window.resetsAt ? capitalise(formatReset(window.resetsAt, nowMs)) : '',
        modelNote,
      })
    }
  }
  readable.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))
  return [...readable, ...unreadable]
}

/**
 * Top tasks: the priced `cost.tasks` rows ranked by each task's OWN cost inside
 * the harvest window (`windowCostUsd`), so a parent and its children are never
 * counted twice. Tasks with no spend in the window are left out.
 */
export function topTasks(rows: readonly TaskCostRowWire[] | null, limit = 5): TaskCostRowView[] {
  if (!rows) return []
  return taskCostRows(rows)
    .rows.filter((row) => row.windowCostUsd > 0)
    .sort((a, b) => b.windowCostUsd - a.windowCostUsd)
    .slice(0, limit)
}

export const PROVIDER_LABEL: Record<UsageProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
  other: 'Other',
}

export interface ModelRowView {
  model: string
  provider: string
  costUsd: number
  messages: number
  /** Share of the week's cost, 0–100. */
  sharePercent: number
  /** Bar width against the dearest model, 0–100. */
  barPercent: number
}

/** The week's models, dearest first, as shares of the same week total. */
export function modelRows(summary: UsageSummaryView, limit = 6): ModelRowView[] {
  const total = summary.week.estCostUsd
  const models = [...summary.models]
    .filter((m) => m.estCostUsd > 0 || m.messages > 0)
    .sort((a, b) => b.estCostUsd - a.estCostUsd)
    .slice(0, limit)
  const peak = models[0]?.estCostUsd ?? 0
  return models.map((m) => ({
    model: m.model,
    provider: PROVIDER_LABEL[m.provider],
    costUsd: m.estCostUsd,
    messages: m.messages,
    sharePercent: total > 0 ? (m.estCostUsd / total) * 100 : 0,
    barPercent: peak > 0 ? (m.estCostUsd / peak) * 100 : 0,
  }))
}

/** "48%", "<1%", "0%" — a share as the rows print it. */
export function formatPercent(value: number): string {
  if (value <= 0) return '0%'
  if (value < 1) return '<1%'
  return `${Math.round(value)}%`
}

/** The large title's subtitle line: "$1,284 in the last 7 days". */
export function pulseSubtitle(hero: PulseHero, range: PulseRange, cold: boolean): string {
  if (cold) return 'Taking a reading…'
  return `${formatUsd(hero.costUsd)} in the ${rangeLabel(range).toLowerCase()}`
}
