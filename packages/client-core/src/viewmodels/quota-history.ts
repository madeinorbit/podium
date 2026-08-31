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
   * `undefined` when neither an observed successor nor the provider gives us a
   * duration. A column that cannot claim a length must not be drawn as a
   * measured short one.
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

const trimZero = (s: string) => s.replace(/\.0$/, '')

/**
 * A LENGTH IN THE UNIT THAT CAN ACTUALLY CARRY IT.
 *
 * Every length here used to be printed in days, rounded, and a window that ran
 * for seven minutes therefore came out as `0 days` — a number that is not merely
 * imprecise but false, since the window plainly ran. A ledger of nominally weekly
 * pools still holds real sub-day windows (a Codex pool that rolls twice in an
 * afternoon), so the unit has to follow the magnitude.
 *
 * Under an hour it is minutes, under a day it is hours, and from a day up it is
 * days with one decimal while that decimal still means something. The parts come
 * back separately so a RANGE can print its unit once — `1.2–1.5 days`, not
 * `1.2 days–1.5 days` — and fall back to naming both when the ends disagree.
 */
export function durationParts(days: number): { value: string; unit: 'min' | 'h' | 'days' } {
  const minutes = days * 1440
  if (minutes < 60) return { value: String(Math.max(1, Math.round(minutes))), unit: 'min' }
  if (days < 1) return { value: String(Math.round(days * 24)), unit: 'h' }
  return { value: trimZero(days < 10 ? days.toFixed(1) : String(Math.round(days))), unit: 'days' }
}

/** One length, spelled out: `45 min` · `17 h` · `1.5 days`. Singular only here —
 *  a range keeps the plural so `1–2 days` does not have to break into two units. */
export function formatWindowDuration(days: number): string {
  const { value, unit } = durationParts(days)
  return `${value} ${unit === 'days' && value === '1' ? 'day' : unit}`
}

/** A span between two lengths, sharing the unit when both ends agree on one. */
export function formatDurationRange(lo: number, hi: number): string {
  const a = durationParts(lo)
  const b = durationParts(hi)
  if (a.value === b.value && a.unit === b.unit) return `${a.value} ${a.unit}`
  if (a.unit === b.unit) return `${a.value}–${b.value} ${b.unit}`
  return `${a.value} ${a.unit} – ${b.value} ${b.unit}`
}

/**
 * A window's length in days.
 *
 * A successor is stronger evidence than the provider's nominal duration: it
 * records when this observed period actually yielded to the next one. This is
 * how a nominal seven-day Codex pool that rolled after two days remains a
 * two-day column. It is capped at the provider duration because a long sampling
 * gap cannot prove the same period survived past its advertised maximum. The
 * provider duration is the fallback for the current row and for a history with
 * only one observation.
 */
export function windowDurationDays(
  row: QuotaWindowHistoryWire,
  successor?: QuotaWindowHistoryWire,
): number | undefined {
  const reported = row.windowMinutes > 0 ? row.windowMinutes / (24 * 60) : undefined
  if (successor) {
    const observed = Date.parse(successor.firstSeenAt) - Date.parse(row.firstSeenAt)
    if (Number.isFinite(observed) && observed > 0) {
      const observedDays = observed / DAY_MS
      return reported === undefined ? observedDays : Math.min(observedDays, reported)
    }
  }
  if (reported !== undefined) return reported
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
 *  - they vary and are not weekly → the observed range, `every 1.2–1.5 days`.
 *
 * And a fourth: fewer than two completed windows says NOTHING. One observation
 * cannot establish a rhythm, and silence is the honest output — the caller
 * renders no cadence at all rather than a hedge.
 *
 * The range reads `every …` because the bare one did not read as anything. Set
 * beside a harness name, `0-2 DAYS` looks like a label with its verb missing —
 * a duration, a limit, a countdown, no way to tell — where `EVERY 1.2–1.5 DAYS`
 * can only be a rhythm. (And the `0` was the other half of that complaint; see
 * {@link durationParts}.)
 */
export function cadenceLabel(durationsDays: number[]): string | undefined {
  const known = durationsDays.filter((d) => Number.isFinite(d) && d > 0)
  if (known.length < 2) return undefined
  const lo = Math.min(...known)
  const hi = Math.max(...known)
  if (lo >= 6.5 && hi <= 7.5) return 'Weekly'
  const mid = median(known) ?? 0
  if (mid >= 6 && mid <= 8) return 'typically weekly'
  return `every ${formatDurationRange(lo, hi)}`
}

/**
 * A POLL IS NOT A WINDOW.
 *
 * A row seen exactly once, holding 0%, records no reset and no spending. It is
 * what the fold used to produce when a rolling provider's reset time crept while
 * its pool sat empty (see `isCreep` in the fold): every fifteen-minute poll of an
 * idle Codex account opened another "window", and the chart drew each of them as
 * a column of no length and no fill. The fold no longer creates them, but the
 * ones already written down do not un-write themselves, and a stored artifact
 * would go on skewing the observed cadence for the ninety days it is retained.
 *
 * The NEWEST row in a strip is kept whatever it looks like: a window that really
 * did just open has exactly this shape for its first quarter of an hour, and it
 * is the one column the reader is most likely to be looking for.
 */
function dropPollArtifacts(ordered: QuotaWindowHistoryWire[]): QuotaWindowHistoryWire[] {
  return ordered.filter(
    (row, i) => i === ordered.length - 1 || row.sampleCount > 1 || row.peakPercent > 0,
  )
}

function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * Build the ledger.
 *
 * Rows arrive ordered by advertised reset time, which rolling providers can
 * move independently of the observed succession. This groups them into one
 * strip per (account, window), restores observation order, and marks where the
 * plan changed underneath.
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
    const ordered = dropPollArtifacts(
      [...list].sort(
        (a, b) =>
          Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt) ||
          Date.parse(a.resetsAt) - Date.parse(b.resetsAt),
      ),
    )
    const first = ordered[0]
    if (!first) continue
    const columns: QuotaLedgerColumn[] = ordered.map((row, i) => {
      const prev = ordered[i - 1]
      const next = ordered[i + 1]
      // A successor is the observed closing boundary for this row. Rolling
      // providers may advertise a later reset even after the pool has emptied.
      const observedEnd = next?.firstSeenAt ?? row.resetsAt
      const observedStart = next ? row.firstSeenAt : row.startedAt
      const span = formatLedgerSpan(observedStart, observedEnd)
      const closed = row.closed || next !== undefined
      return {
        ...row,
        // The endpoint's `closed` bit only says whether wall-clock time passed
        // the advertised reset. A successor also finalizes this observed period.
        closed,
        spanLabel: closed ? span : span ? `${span} · now` : 'now',
        endLabel: closed ? MONTH_DAY.format(new Date(observedEnd)) : 'now',
        planBreak: prev !== undefined && prev.plan !== undefined && prev.plan !== row.plan,
        durationDays: windowDurationDays(row, next),
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
