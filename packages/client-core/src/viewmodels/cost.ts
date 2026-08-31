/**
 * WHAT A TASK COST, IN MONEY (POD-1858) — the client half of the cost read path.
 *
 * The server ships tokens and this module prices them, through
 * `bucketCostUsd` — THE price table, imported rather than restated. Its header
 * records why there must never be a second copy: two tables quote two dollar
 * figures for the same tokens the first time a model id lands on a different
 * row, and the sheet's total would stop agreeing with its own by-task
 * breakdown. This file adds no rate, no fallback and no rounding rule of its
 * own; it is arithmetic over that one table.
 *
 * SHARED, NOT WEB-LOCAL, for the same reason `usage.ts` is: the phone's Pulse
 * tab and the desktop's four cost surfaces ask the identical questions.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is decide how a figure is WORDED. `state`,
 * `floor` and `provisional` are passed through untouched — "No sessions", "Not
 * recorded" and the hedge sentence are the surface's copy, and a viewmodel that
 * pre-rendered them would put the same sentence in four places.
 */

import type {
  CostFloor,
  CostHarness,
  CostModelTotalWire,
  CostTotalsWire,
  SessionCostWire,
  TaskCostRowWire,
  TaskCostState,
  TaskCostWire,
} from '@podium/model'
import { bucketCostUsd, bucketProvider, type UsageProvider } from './usage'

/**
 * The API-equivalent cost of one model's token total.
 *
 * Routed through the bucket shape because that is the price table's argument —
 * an hour×model bucket and a per-task model total are the same six numbers, and
 * borrowing the function is what keeps them priced identically.
 */
export function modelTotalCostUsd(m: CostModelTotalWire): number {
  return bucketCostUsd({
    hour: '',
    model: m.model,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cacheReadTokens: m.cacheReadTokens,
    cacheCreationTokens: m.cacheCreationTokens,
    cacheCreation1hTokens: m.cacheCreation1hTokens,
    messages: m.messages,
  })
}

export const modelTotalTokens = (m: CostModelTotalWire): number =>
  m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens

export interface CostModelRow {
  model: string
  provider: UsageProvider
  estCostUsd: number
  totalTokens: number
  messages: number
}

/** One side of the rollup split, priced. */
export interface CostAmount {
  estCostUsd: number
  totalTokens: number
  messages: number
  sessionCount: number
  /** Dearest first — the model split the popover and the panel both draw. */
  models: CostModelRow[]
}

export interface SessionCostView {
  sessionId: string | null
  title: string | null
  harness: CostHarness
  running: boolean
  estCostUsd: number
  totalTokens: number
  messages: number
  firstTsMs: number
  lastTsMs: number
}

export interface TaskCostView {
  state: TaskCostState
  own: CostAmount
  rollup: CostAmount
  descendantCount: number
  provisional: boolean
  floor: CostFloor
  harnesses: CostHarness[]
  /** Own sessions, dearest first. */
  sessions: SessionCostView[]
  /** Rolled-up cost per reply; null when there are no replies to divide by. */
  ratePerReplyUsd: number | null
  /**
   * This task's rate over the cohort median — the "2.3× median" reading. Null
   * without a cohort, and null for a task with no replies: a multiple with no
   * denominator is the kind of number that gets screenshotted.
   */
  rateVsMedian: number | null
}

const EMPTY_AMOUNT: CostAmount = {
  estCostUsd: 0,
  totalTokens: 0,
  messages: 0,
  sessionCount: 0,
  models: [],
}

function amountOf(totals: CostTotalsWire): CostAmount {
  const models = totals.models
    .map(
      (m): CostModelRow => ({
        model: m.model,
        provider: bucketProvider(m.model),
        estCostUsd: modelTotalCostUsd(m),
        totalTokens: modelTotalTokens(m),
        messages: m.messages,
      }),
    )
    .sort((a, b) => b.estCostUsd - a.estCostUsd)
  return {
    estCostUsd: models.reduce((n, m) => n + m.estCostUsd, 0),
    totalTokens: models.reduce((n, m) => n + m.totalTokens, 0),
    messages: totals.messages,
    sessionCount: totals.sessionCount,
    models,
  }
}

/**
 * THE RATE COHORT'S ENTRY BAR — more than twenty replies.
 *
 * Measured over ALL-TIME figures, matching the per-task rate it is compared
 * against. A window cohort beside an all-time task rate would print a multiple
 * of two different things.
 *
 * A task with three replies has a rate, and it is noise: one expensive turn
 * moves it by a factor the reader would read as a finding. Measured over this
 * machine's corpus the qualifying set is ~200 tasks, which is a cohort; the
 * unfiltered set is dominated by tasks that barely ran.
 */
export const RATE_COHORT_MIN_REPLIES = 20

export interface CostCohort {
  /** Median USD per reply across qualifying tasks; null when none qualify. */
  medianUsdPerReply: number | null
  /** How many tasks the median was taken over — the honesty of the multiple. */
  taskCount: number
}

/** The cohort a "× median" reading is measured against. */
export function costCohort(rows: readonly TaskCostRowWire[]): CostCohort {
  const rates: number[] = []
  for (const row of rows) {
    if (row.messages <= RATE_COHORT_MIN_REPLIES) continue
    const usd = row.models.reduce((n, m) => n + modelTotalCostUsd(m), 0)
    if (usd > 0) rates.push(usd / row.messages)
  }
  if (rates.length === 0) return { medianUsdPerReply: null, taskCount: 0 }
  rates.sort((a, b) => a - b)
  const mid = rates.length >> 1
  const median =
    rates.length % 2 === 1
      ? (rates[mid] as number)
      : ((rates[mid - 1] as number) + (rates[mid] as number)) / 2
  return { medianUsdPerReply: median, taskCount: rates.length }
}

/** One task's wire, priced. `cohort` adds the comparative reading. */
export function taskCostView(wire: TaskCostWire, cohort?: CostCohort): TaskCostView {
  const own = wire.own.models.length === 0 ? EMPTY_AMOUNT : amountOf(wire.own)
  const rollup = wire.rollup.models.length === 0 ? EMPTY_AMOUNT : amountOf(wire.rollup)
  const ratePerReplyUsd = rollup.messages > 0 ? rollup.estCostUsd / rollup.messages : null
  const median = cohort?.medianUsdPerReply ?? null
  return {
    state: wire.state,
    own,
    rollup,
    descendantCount: wire.descendantCount,
    provisional: wire.provisional,
    floor: wire.floor,
    harnesses: wire.harnesses,
    sessions: wire.sessions
      .map((s): SessionCostView => sessionCostView(s))
      .sort((a, b) => b.estCostUsd - a.estCostUsd),
    ratePerReplyUsd,
    rateVsMedian:
      ratePerReplyUsd !== null && median !== null && median > 0 ? ratePerReplyUsd / median : null,
  }
}

function sessionCostView(s: SessionCostWire): SessionCostView {
  return {
    sessionId: s.sessionId,
    title: s.title,
    harness: s.harness,
    running: s.running,
    estCostUsd: s.models.reduce((n, m) => n + modelTotalCostUsd(m), 0),
    totalTokens: s.models.reduce((n, m) => n + modelTotalTokens(m), 0),
    messages: s.models.reduce((n, m) => n + m.messages, 0),
    firstTsMs: s.firstTsMs,
    lastTsMs: s.lastTsMs,
  }
}

export interface TaskCostRowView {
  issueId: string
  seq: number
  title: string
  stage: string
  estCostUsd: number
  totalTokens: number
  messages: number
  /** The same task inside the harvest's window — what the sheet's stats row
   *  compares against the host's own 7-day total. Zero for a task whose work
   *  is all older than the window, which is the honest reading. */
  windowCostUsd: number
  windowMessages: number
  sessionCount: number
  floor: CostFloor
  harnesses: CostHarness[]
  ratePerReplyUsd: number | null
  rateVsMedian: number | null
}

/**
 * The sheet's ranked table, dearest first, with the cohort computed from the
 * same rows — the multiple and the ranking are then guaranteed to be one
 * reading of one set rather than two answers taken at different moments.
 */
export function taskCostRows(rows: readonly TaskCostRowWire[]): {
  rows: TaskCostRowView[]
  cohort: CostCohort
} {
  const cohort = costCohort(rows)
  const median = cohort.medianUsdPerReply
  const priced = rows.map((row): TaskCostRowView => {
    const estCostUsd = row.models.reduce((n, m) => n + modelTotalCostUsd(m), 0)
    const rate = row.messages > 0 ? estCostUsd / row.messages : null
    return {
      issueId: row.issueId,
      seq: row.seq,
      title: row.title,
      stage: row.stage,
      estCostUsd,
      totalTokens: row.models.reduce((n, m) => n + modelTotalTokens(m), 0),
      messages: row.messages,
      windowCostUsd: row.windowModels.reduce((n, m) => n + modelTotalCostUsd(m), 0),
      windowMessages: row.windowMessages,
      sessionCount: row.sessionCount,
      floor: row.floor,
      harnesses: row.harnesses,
      ratePerReplyUsd: rate,
      rateVsMedian: rate !== null && median !== null && median > 0 ? rate / median : null,
    }
  })
  priced.sort((a, b) => b.estCostUsd - a.estCostUsd)
  return { rows: priced, cohort }
}
