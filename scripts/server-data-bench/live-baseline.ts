/**
 * Summarize a COPY of a live server's loop minute file (POD-3810 accounting) into the
 * POD-6146 baseline tables: median and p90 per window. Read-only; run it on the VM
 * against files exported from the live host, never on the live host itself.
 *
 *   bun scripts/server-data-bench/live-baseline.ts --minutes=<loop-server.ndjson copy>
 *     --versions=<minute-versions.ndjson> --end=<ISO> [--since-restart=<ISO>]
 *
 * The minute file carries no build version. `--versions` is one `{"at","v"}` line per
 * `loop minute` journal record of the server (exported with
 * `journalctl --user -u podium.service -g '"loop minute"' -o cat | grep '"component":"server"' | jq -c '{at,v}'`),
 * so each minute is labeled with the build that wrote it.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from './seed'

export interface LiveMinute {
  at: string
  utilizationPct?: number
  blockedPct: number
  stalls: number
  rssBytes: number
  heapUsedBytes: number
  buckets?: Record<string, { wallMs: number; count: number }>
}

/** Linear-interpolated quantile, as numpy's default. */
export function quantile(values: readonly number[], q: number): number {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (xs.length === 0) return Number.NaN
  const k = (xs.length - 1) * q
  const lo = Math.floor(k)
  const hi = Math.min(lo + 1, xs.length - 1)
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (k - lo)
}

export const LIVE_COLUMNS: Array<[string, string, (m: LiveMinute) => number, number]> = [
  ['utilizationPct', 'utilizationPct', (m) => m.utilizationPct ?? Number.NaN, 1],
  ['blockedPct', 'blockedPct', (m) => m.blockedPct, 1],
  ['stalls', 'stalls/min', (m) => m.stalls, 0],
  ['sqlN', 'SQL statements/min', (m) => m.buckets?.sql?.count ?? 0, 0],
  ['sqlMs', 'SQL wall ms/min', (m) => m.buckets?.sql?.wallMs ?? 0, 0],
  ['daemonN', 'ws.daemon frames/min', (m) => m.buckets?.['ws.daemon']?.count ?? 0, 0],
  ['daemonMs', 'ws.daemon wall ms/min', (m) => m.buckets?.['ws.daemon']?.wallMs ?? 0, 0],
  ['perFrame', 'SQL statements per daemon frame', (m) => m.buckets?.['ws.daemon']?.count ? (m.buckets.sql?.count ?? 0) / m.buckets['ws.daemon'].count : Number.NaN, 2],
  ['rss', 'RSS MiB', (m) => m.rssBytes / 2 ** 20, 0],
  ['heap', 'heap used MiB', (m) => m.heapUsedBytes / 2 ** 20, 0],
]

export function windowTable(minutes: readonly LiveMinute[], versions: ReadonlyMap<string, string>, name: string, startMs: number, endMs: number): string {
  const inside = minutes.filter((m) => { const at = Date.parse(m.at); return at >= startMs && at < endMs })
  const builds = new Map<string, number>()
  for (const m of inside) { const v = versions.get(m.at) ?? 'unknown'; builds.set(v, (builds.get(v) ?? 0) + 1) }
  const expected = Math.round((endMs - startMs) / 60_000)
  const lines = [
    `### ${name}: ${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()}`,
    '',
    `${inside.length} of ${expected} minutes; builds: ${[...builds].map(([v, n]) => `${v} (${n})`).join(', ')}`,
    '',
    '| metric | median | p90 |',
    '|---|---:|---:|',
  ]
  for (const [, label, pick, digits] of LIVE_COLUMNS) {
    const values = inside.map(pick)
    lines.push(`| ${label} | ${quantile(values, 0.5).toFixed(digits)} | ${quantile(values, 0.9).toFixed(digits)} |`)
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  const minutes = readFileSync(args.minutes!, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as LiveMinute)
  const versions = new Map<string, string>()
  if (args.versions) {
    for (const line of readFileSync(args.versions, 'utf8').trim().split('\n')) {
      const { at, v } = JSON.parse(line) as { at: string; v: string }
      versions.set(at, versions.has(at) && versions.get(at) !== v ? `${versions.get(at)}+${v}` : v)
    }
  }
  const end = Date.parse(args.end!)
  const out = [windowTable(minutes, versions, '24 h', end - 24 * 3_600_000, end), windowTable(minutes, versions, '1 h', end - 3_600_000, end)]
  if (args['since-restart']) out.push(windowTable(minutes, versions, 'since the last restart', Date.parse(args['since-restart']), end))
  console.log(out.join('\n\n'))
}
