/**
 * Pure summaries for the server data bench (POD-6146): which minute records belong
 * to a load window, the per-round metrics, the totals diff and the A/B table.
 * Everything here is deterministic so `report.test.ts` can pin it.
 */

export interface LoopMinuteRecord {
  /** The minute's END rounded down to the minute — a label, not a boundary: a minute is
   *  60 one-second sample windows counted from accounting start, not a clock minute. */
  at: string
  /** When the `loop minute` log record was written, i.e. the minute's actual end. */
  ts?: string
  utilizationPct?: number
  blockedPct: number
  stalls: number
  rssBytes: number
  heapUsedBytes: number
  buckets?: Record<string, { wallMs: number; count: number }>
}

/** Longest a minute is taken to span: 60 sample windows, each delayed by at most a stall. */
export const MINUTE_SPAN_MS = 62_000

/** Records (from the log, with `ts`) whose whole minute lies inside [startMs, endMs]. */
export function minutesInside(records: readonly LoopMinuteRecord[], startMs: number, endMs: number): LoopMinuteRecord[] {
  return records.filter((record) => {
    if (!record.ts) return false
    const end = Date.parse(record.ts)
    return end - MINUTE_SPAN_MS >= startMs && end <= endMs
  })
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * Per-minute metrics of one round, as medians over its load-window minutes.
 *
 * A loop "minute" is 60 one-second sample windows, and under load the sample timer
 * runs late, so a record can span well over 60 s of wall time. Shares (utilization,
 * blocked) are already ratios of the record's own span; counts and wall totals are
 * scaled to 60 s of wall time using each record's span, which is the gap since the
 * previous record's `ts`. `spans` gives those gaps in ms, one per record.
 */
export function minuteMetrics(minutes: readonly LoopMinuteRecord[], spans: readonly number[]): Record<string, number> {
  const bucket = (record: LoopMinuteRecord, name: string) => record.buckets?.[name] ?? { wallMs: 0, count: 0 }
  const scaled = (pick: (record: LoopMinuteRecord) => number) => median(minutes.map((r, i) => (pick(r) * 60_000) / (spans[i] ?? 60_000)))
  const of = (pick: (record: LoopMinuteRecord) => number) => median(minutes.map(pick))
  return {
    minutes: minutes.length,
    minuteSpanS: median(spans) / 1000,
    utilizationPct: of((r) => r.utilizationPct ?? Number.NaN),
    blockedPct: of((r) => r.blockedPct),
    stallsPerMin: scaled((r) => r.stalls),
    sqlPerDaemonFrame: of((r) => bucket(r, 'ws.daemon').count ? bucket(r, 'sql').count / bucket(r, 'ws.daemon').count : Number.NaN),
  }
}

/** The span of each record: the gap to the previous record's `ts` (first record: `firstSpanMs`). */
export function minuteSpans(records: readonly LoopMinuteRecord[], all: readonly LoopMinuteRecord[]): number[] {
  return records.map((record) => {
    const index = all.indexOf(record)
    const previous = index > 0 ? all[index - 1] : undefined
    return previous?.ts && record.ts ? Date.parse(record.ts) - Date.parse(previous.ts) : 60_000
  })
}

/** Exact window rates from the attribution totals diffed over the window. */
export function windowRates(queries: Record<string, Cost>, tasks: Record<string, Cost>, windowMs: number): Record<string, number> {
  const perMin = (n: number) => (n * 60_000) / windowMs
  const sum = (costs: Record<string, Cost>, keep: (key: string) => boolean) => Object.entries(costs)
    .filter(([key]) => keep(key)).reduce((acc, [, c]) => ({ count: acc.count + c.count, wallMs: acc.wallMs + c.wallMs }), { count: 0, wallMs: 0 })
  const sql = sum(queries, () => true)
  const daemon = sum(tasks, (key) => key === 'ws.message.daemon' || key === 'ws.message.machine')
  const client = sum(tasks, (key) => key === 'ws.message.client')
  return {
    sqlStatementsPerMin: perMin(sql.count),
    sqlWallMsPerMin: perMin(sql.wallMs),
    daemonFramesPerMin: perMin(daemon.count),
    daemonWallMsPerMin: perMin(daemon.wallMs),
    clientFramesPerMin: perMin(client.count),
    windowSqlPerDaemonFrame: daemon.count ? sql.count / daemon.count : Number.NaN,
  }
}

export interface Cost { count: number; wallMs: number; rows?: number; maxMs?: number }

/** end − start per key, dropping keys that did not run in the window. */
export function diffTotals(start: Record<string, Cost>, end: Record<string, Cost>): Record<string, Cost> {
  const out: Record<string, Cost> = {}
  for (const [key, cost] of Object.entries(end)) {
    const before = start[key] ?? { count: 0, wallMs: 0, rows: 0 }
    const count = cost.count - before.count
    if (count <= 0) continue
    out[key] = { count, wallMs: cost.wallMs - before.wallMs, rows: (cost.rows ?? 0) - (before.rows ?? 0) }
  }
  return out
}

/**
 * The operation kind of a statement: verb plus first table, e.g. `select sessions`.
 * Statement keys are SQL text as the attribution layer records it.
 */
export function statementKind(sql: string): string {
  const text = sql.replaceAll('"', '').replaceAll('`', '').toLowerCase().trim()
  const verb = /^(with|select|insert|update|delete|replace|pragma|begin|commit|rollback|savepoint|release)\b/.exec(text)?.[1] ?? 'other'
  const table = verb === 'insert' || verb === 'replace'
    ? /\binto\s+([a-z_0-9]+)/.exec(text)?.[1]
    : verb === 'update'
      ? /^update\s+([a-z_0-9]+)/.exec(text)?.[1]
      : /\bfrom\s+([a-z_0-9]+)/.exec(text)?.[1]
  return table ? `${verb} ${table}` : verb
}

/** Statements per minute by operation kind, most frequent first. */
export function statementsByKind(window: Record<string, Cost>, minutes: number): Array<{ kind: string; perMin: number; wallMsPerMin: number }> {
  const kinds = new Map<string, { count: number; wallMs: number }>()
  for (const [sql, cost] of Object.entries(window)) {
    const kind = statementKind(sql)
    const entry = kinds.get(kind) ?? { count: 0, wallMs: 0 }
    entry.count += cost.count
    entry.wallMs += cost.wallMs
    kinds.set(kind, entry)
  }
  return [...kinds].map(([kind, cost]) => ({ kind, perMin: cost.count / minutes, wallMsPerMin: cost.wallMs / minutes }))
    .sort((a, b) => b.perMin - a.perMin || a.kind.localeCompare(b.kind))
}

/** What each reported metric counts; printed beside the numbers. */
export const METRIC_MEANING: Record<string, string> = {
  bootListenMs: 'process start to the `listen` boot stage (server:boot log), ms',
  rssAfterBootMiB: 'server RSS when startServer resolved, MiB',
  rssEndMiB: 'server RSS at the end of the load window, MiB',
  heapEndMiB: 'server heap used at the end of the load window, MiB',
  utilizationPct: 'event-loop utilization, median of window minutes (loop-server.ndjson)',
  blockedPct: 'share of the minute the loop was blocked, median of window minutes',
  stallsPerMin: 'event-loop stalls per 60 s of wall time, median of window minutes',
  minuteSpanS: 'wall seconds one loop minute (60 sample windows) took, median; >60 means the sampler ran late',
  sqlStatementsPerMin: 'SQL statements per minute over the exact window (attribution totals diff)',
  sqlWallMsPerMin: 'SQL wall ms per minute over the window (attribution totals diff)',
  daemonFramesPerMin: 'daemon WebSocket frames handled per minute over the window (ws.message.daemon task count)',
  daemonWallMsPerMin: 'ms per minute handling daemon frames over the window (ws.message.daemon task wall)',
  clientFramesPerMin: 'client WebSocket frames handled per minute over the window (ws.message.client task count)',
  daemonReconnects: 'times the server dropped a fake daemon during the round (each reconnects after 1 s); 0 unless overloaded',
  framesDroppedPerMin: 'daemon frames per minute that came due while their daemon was disconnected (not sent)',
  windowSqlPerDaemonFrame: 'all SQL statements in the window / daemon frames in the window',
  sqlPerDaemonFrame: 'SQL statements per daemon frame per loop minute (sql / ws.daemon bucket counts), median — the live figure\'s definition',
}

export interface RoundResult { arm: 'A' | 'B'; round: number; metrics: Record<string, number> }

/** Relative change B vs A in percent; NaN when A is 0 or missing. */
export function deltaPct(a: number, b: number): number {
  return a === 0 || !Number.isFinite(a) || !Number.isFinite(b) ? Number.NaN : ((b - a) / Math.abs(a)) * 100
}

const fmt = (value: number) => !Number.isFinite(value) ? '–' : Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2)

/**
 * The side-by-side table: per metric, the median over rounds for each arm, the
 * min–max over rounds, and B vs A. One row per metric in METRIC_MEANING order.
 */
export function sideBySide(rounds: readonly RoundResult[], shas: { A: string; B: string }): string {
  const lines = [
    `| metric | A ${shas.A.slice(0, 10)} median (min–max) | B ${shas.B.slice(0, 10)} median (min–max) | B vs A | what it counts |`,
    '|---|---:|---:|---:|---|',
  ]
  for (const [metric, meaning] of Object.entries(METRIC_MEANING)) {
    const values = (arm: 'A' | 'B') => rounds.filter((r) => r.arm === arm).map((r) => r.metrics[metric]).filter((v): v is number => Number.isFinite(v))
    const a = values('A')
    const b = values('B')
    if (a.length === 0 && b.length === 0) continue
    const cell = (xs: number[]) => xs.length ? `${fmt(median(xs))} (${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))})` : '–'
    const delta = deltaPct(median(a), median(b))
    lines.push(`| ${metric} | ${cell(a)} | ${cell(b)} | ${Number.isFinite(delta) ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%` : '–'} | ${meaning} |`)
  }
  return lines.join('\n')
}

/** The A B A B … order for `rounds` rounds of each arm. */
export function interleavedOrder(rounds: number): Array<{ arm: 'A' | 'B'; round: number }> {
  return Array.from({ length: rounds }, (_, round) => [{ arm: 'A' as const, round: round + 1 }, { arm: 'B' as const, round: round + 1 }]).flat()
}

/** The next whole minute at least `leadMs` from `nowMs`. */
export function nextMinuteBoundary(nowMs: number, leadMs: number): number {
  return Math.ceil((nowMs + leadMs) / 60_000) * 60_000
}
