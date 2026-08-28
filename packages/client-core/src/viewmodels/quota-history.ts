/**
 * THE RESET LEDGER'S VIEW MODEL — window rows into per-harness strips.
 *
 * The unit is the window INSTANCE: one run of a pool from its start to the reset
 * that ended it. "How well did I use my quota" has exactly one honest answer per
 * instance, `peakPercent`, and the chart is those answers in a row.
 *
 * WEEKLY POOLS ONLY. Claude also reports a 5-hour session window; it resets
 * nearly five times a day and would swamp a strip with columns that say more
 * about when someone was at the keyboard than about how well a plan was used.
 * Filtered here rather than in the store, so the samples keep accruing and the
 * decision stays reversible.
 *
 * NO PER-HARNESS COLOUR, and no tone ramp. Podium has `--claude` and no
 * `--codex`/`--grok`, deliberately: harness identity is carried by monochrome
 * marks. Identity here comes from small multiples — one strip per pool, direct
 * labelled — so the whole figure stays one hue. And the live meter's amber/red
 * escalation must NOT be reused: there, near-full means "about to be cut off";
 * in a history chart a window that ended at 95% is the best possible outcome.
 * The mapping inverts, so reusing it would state the opposite of the truth.
 */

import type { AgentKind, QuotaWindowHistoryWire } from '@podium/model'

/** Windows the ledger charts. See the header: 5-hour sessions are out of scope. */
const LEDGER_WINDOW_KEYS = new Set(['weekly', 'weekly-all'])

export function isLedgerWindow(row: Pick<QuotaWindowHistoryWire, 'windowKey'>): boolean {
  return LEDGER_WINDOW_KEYS.has(row.windowKey)
}

export interface QuotaLedgerColumn extends QuotaWindowHistoryWire {
  /** `Aug 18 – 25`, or `Aug 18 – 25 · now` for the window still running. Used
   *  where there is room to read it: the tooltip and the headline reading. */
  spanLabel: string
  /**
   * The axis label — `Aug 25`, or `now` for the window still running.
   *
   * A column is 96px at most, and a full span does not fit in it: the labels
   * truncated to `Aug 24 – 31…`, which is worse than useless because the part it
   * cut is the part that distinguishes one column from the next. A ledger is a
   * sequence of consecutive windows, so the reset date alone identifies a column
   * unambiguously, and `spanLabel` still carries the whole period on hover.
   */
  endLabel: string
  /** The plan changed at this column, so the pool underneath it is a different
   *  size and the percentages either side are not comparable. */
  planBreak: boolean
  /**
   * How long this window ran, in days — the column's WIDTH.
   *
   * Linear, and it may be: only nominally-weekly pools reach this chart, so the
   * spread is about 1–7 days. A seven-day window really is drawn seven times the
   * width of a one-day one, which means the width can be read as a proportion
   * rather than a ranking. (Claude's 5-hour window would have made that a 33:1
   * ratio and forced a compressed scale — it is filtered out well before here.)
   *
   * `undefined` when the provider reported no duration: that is a legitimate
   * "it did not say", and a column that cannot claim a length must not be drawn
   * as a measured short one.
   */
  durationDays: number | undefined
}

export interface QuotaLedgerStrip {
  key: string
  agent: AgentKind
  /** `CC` · `CX` · `GR` — the mark the rest of the shell already uses. */
  mark: string
  agentLabel: string
  /**
   * What this pool's rhythm actually looks like — `Weekly`, `typically weekly`,
   * a range like `1–7 days`, or NOTHING when too little has been seen to say.
   *
   * Derived from the observed windows, never copied from the provider's own
   * label. See {@link cadenceLabel}.
   */
  windowLabel: string | undefined
  columns: QuotaLedgerColumn[]
  /** Completed windows only — a running window has no final answer yet. */
  completedCount: number
  averagePeak: number | undefined
  backfilledFrom: string | undefined
}

export interface QuotaLedgerView {
  strips: QuotaLedgerStrip[]
  /** Capacity spent across every completed window, weighted equally per window. */
  averagePeak: number | undefined
  completedCount: number
  bestPeak: number | undefined
  bestLabel: string | undefined
  /**
   * Whole windows' worth of plan left unspent — `(100 - average) × completed`.
   *
   * Expressed as windows rather than a percentage because "you threw away two
   * weeks' worth of plan" lands and "22% average shortfall" does not.
   */
  unusedWindows: number | undefined
  earliestAt: string | undefined
  hasBackfill: boolean
}

const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  shell: 'Shell',
}

const AGENT_MARK: Record<string, string> = {
  'claude-code': 'CC',
  codex: 'CX',
  grok: 'GR',
  opencode: 'OC',
  cursor: 'CU',
  shell: 'SH',
}

const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric' })

/** `Aug 18 – 25` when both ends share a month, `Aug 28 – Sep 4` when they do not.
 *  Named apart from `formatWindowSpan` in `viewmodels/usage`, which formats the
 *  trace's rolling 7-day span and means something different. */
export function formatLedgerSpan(startedAt: string | undefined, resetsAt: string): string {
  const end = new Date(resetsAt)
  if (Number.isNaN(end.getTime())) return ''
  if (!startedAt) return MONTH_DAY.format(end)
  const start = new Date(startedAt)
  if (Number.isNaN(start.getTime())) return MONTH_DAY.format(end)
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()
  return `${MONTH_DAY.format(start)} – ${sameMonth ? DAY.format(end) : MONTH_DAY.format(end)}`
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A window's length in days, or undefined when the provider reported none. */
export function windowDurationDays(row: QuotaWindowHistoryWire): number | undefined {
  if (row.windowMinutes > 0) return row.windowMinutes / (24 * 60)
  if (!row.startedAt) return undefined
  const span = Date.parse(row.resetsAt) - Date.parse(row.startedAt)
  return Number.isFinite(span) && span > 0 ? span / DAY_MS : undefined
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/**
 * WHAT THIS POOL'S RHYTHM ACTUALLY IS, from the windows we watched.
 *
 * The provider's own label is not evidence. Every harness here calls its big
 * pool "Weekly", and Codex was measured emptying its pool several times in one
 * afternoon while its reset time crept — printing "Weekly" over that would be
 * the chart asserting something its own columns contradict.
 *
 * Three answers, in descending confidence:
 *  - every window within half a day of seven → `Weekly`, said plainly;
 *  - they vary but sit around a week → `typically weekly`, which claims a
 *    tendency and not a rule;
 *  - they vary and are not weekly → the observed range, `1–7 days`.
 *
 * And a fourth: fewer than two completed windows says NOTHING. One observation
 * cannot establish a rhythm, and silence is the honest output — the caller
 * renders no cadence at all rather than a hedge.
 */
export function cadenceLabel(durationsDays: number[]): string | undefined {
  const known = durationsDays.filter((d) => Number.isFinite(d) && d > 0)
  if (known.length < 2) return undefined
  const lo = Math.min(...known)
  const hi = Math.max(...known)
  if (lo >= 6.5 && hi <= 7.5) return 'Weekly'
  const mid = median(known) ?? 0
  if (mid >= 6 && mid <= 8) return 'typically weekly'
  const round = (d: number) => (d < 1.5 ? d.toFixed(1).replace(/\.0$/, '') : String(Math.round(d)))
  return lo === hi ? `${round(lo)} days` : `${round(lo)}–${round(hi)} days`
}

function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * Build the ledger.
 *
 * Rows arrive oldest-first per series from the store; this groups them into one
 * strip per (account, window) and marks where the plan changed underneath.
 */
export function quotaLedger(rows: QuotaWindowHistoryWire[]): QuotaLedgerView {
  const byStrip = new Map<string, QuotaWindowHistoryWire[]>()
  for (const row of rows) {
    if (!isLedgerWindow(row)) continue
    const key = `${row.accountKey}::${row.windowKey}`
    const list = byStrip.get(key)
    if (list) list.push(row)
    else byStrip.set(key, [row])
  }

  const strips: QuotaLedgerStrip[] = []
  for (const [key, list] of byStrip) {
    const ordered = [...list].sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt))
    const first = ordered[0]
    if (!first) continue
    const columns: QuotaLedgerColumn[] = ordered.map((row, i) => {
      const prev = ordered[i - 1]
      const span = formatLedgerSpan(row.startedAt, row.resetsAt)
      return {
        ...row,
        spanLabel: row.closed ? span : span ? `${span} · now` : 'now',
        endLabel: row.closed ? MONTH_DAY.format(new Date(row.resetsAt)) : 'now',
        planBreak: prev !== undefined && prev.plan !== undefined && prev.plan !== row.plan,
        durationDays: windowDurationDays(row),
      }
    })
    const completed = columns.filter((c) => c.closed)
    const backfilled = ordered.filter((r) => r.source === 'backfill')
    strips.push({
      key,
      agent: first.agent,
      mark: AGENT_MARK[first.agent] ?? first.agent.slice(0, 2).toUpperCase(),
      agentLabel: AGENT_LABEL[first.agent] ?? first.agent,
      // Closed windows only: a running one is still growing, so its length so far
      // is not the length it will turn out to have had.
      windowLabel: cadenceLabel(
        completed.map((c) => c.durationDays).filter((d): d is number => d !== undefined),
      ),
      columns,
      completedCount: completed.length,
      averagePeak: mean(completed.map((c) => c.peakPercent)),
      backfilledFrom: backfilled[0]?.startedAt ?? backfilled[0]?.resetsAt,
    })
  }

  strips.sort((a, b) => a.agentLabel.localeCompare(b.agentLabel) || a.key.localeCompare(b.key))

  const allCompleted = strips.flatMap((s) => s.columns.filter((c) => c.closed))
  const average = mean(allCompleted.map((c) => c.peakPercent))
  const best = allCompleted.reduce<QuotaLedgerColumn | undefined>(
    (acc, c) => (acc === undefined || c.peakPercent > acc.peakPercent ? c : acc),
    undefined,
  )
  const earliest = strips
    .flatMap((s) => s.columns.map((c) => c.startedAt ?? c.resetsAt))
    .sort()
    .at(0)

  return {
    strips,
    averagePeak: average,
    completedCount: allCompleted.length,
    bestPeak: best?.peakPercent,
    bestLabel: best ? `${best.spanLabel} · ${AGENT_LABEL[best.agent] ?? best.agent}` : undefined,
    unusedWindows:
      average === undefined ? undefined : ((100 - average) / 100) * allCompleted.length,
    earliestAt: earliest,
    hasBackfill: strips.some((s) => s.backfilledFrom !== undefined),
  }
}
