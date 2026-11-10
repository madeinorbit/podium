/**
 * ONE START-UP LOAD, MEASURED (POD-6770, design POD-6253 §4).
 *
 * Runs the sync worker's own producer (`produceBootstrap`) once over a
 * database copy, for one member, on this thread, and prints one JSON line:
 * rows, records, bytes, wall time, the producer's phases and this process's
 * peak resident memory. One process per run, so the peak is the load's own.
 *
 * The same file runs on a commit that reads the stored copy of the last
 * published values and on one that builds the load from the model tables, so
 * the two can be measured against the same copy, interleaved:
 *
 *   bun --conditions=@podium/source apps/server/scripts/bootstrap-load.ts --db=<copy> [--user=<id>] [--effect-kinds=a,b]
 *
 * Run it on the bench VM, on a copy (never on a live database). The copy is
 * opened read-only.
 */

import { asUserId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { produceBootstrap } from '../src/sync-worker/producer'
import type { BootstrapMetrics, SyncJob } from '../src/sync-worker/types'

const args = new Map(
  process.argv.slice(2).flatMap((arg) => {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
    return match ? [[match[1]!, match[2] ?? ''] as const] : []
  }),
)
const dbPath = args.get('db')
if (!dbPath) {
  console.error('usage: bootstrap-load.ts --db=<copy> [--user=<id>] [--effect-kinds=a,b]')
  process.exit(2)
}

/** The member the load is for: the named one, else the earliest admin. */
function member(path: string): string {
  const named = args.get('user')
  if (named) return named
  const db = openDatabase(path, { readOnly: true })
  try {
    const row = db
      .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1")
      .get() as { id: string } | undefined
    if (!row) throw new Error('the copy holds no admin; pass --user=<id>')
    return row.id
  } finally {
    db.close()
  }
}

/** The effect kinds the copy holds: a served kind publishes its input. */
function effectKinds(path: string): string[] {
  const named = args.get('effect-kinds')
  if (named !== undefined) return named.split(',').filter(Boolean)
  const db = openDatabase(path, { readOnly: true })
  try {
    return (db.prepare('SELECT DISTINCT kind FROM effects').all() as { kind: string }[]).map(
      (row) => row.kind,
    )
  } finally {
    db.close()
  }
}

const user = member(dbPath)
const job: SyncJob = {
  transferId: 'bootstrap-load',
  principal: { ...DEVICE_GRADE_PRINCIPAL, user: asUserId(user) },
  feedId: 'bootstrap-load',
  epoch: 'bootstrap-load',
  encoding: 'identity',
  deadlineMs: Date.now() + 10 * 60_000,
}

const startRss = process.memoryUsage().rss
const started = performance.now()
let bytes = 0
let metrics: BootstrapMetrics | undefined
// The last argument is read by a producer that builds effect records; an
// older producer ignores it.
const produce = produceBootstrap as (...input: unknown[]) => AsyncGenerator<Uint8Array>
for await (const chunk of produce(
  dbPath,
  job,
  new AbortController().signal,
  () => {},
  (value: BootstrapMetrics) => {
    metrics = value
  },
  { effectKinds: effectKinds(dbPath) },
)) {
  bytes += chunk.byteLength
}
const ms = performance.now() - started
const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10

console.log(
  JSON.stringify({
    user,
    rows: metrics?.rows,
    records: metrics?.records,
    bytes,
    ms: Math.round(ms),
    outcome: metrics?.outcome,
    startRssMb: mb(startRss),
    // Kernel high-water mark of this process's resident memory (KiB on Linux).
    peakRssMb: Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10,
    peakHeapMb: mb(process.memoryUsage().heapUsed),
    phases: Object.fromEntries(
      Object.entries(metrics?.phases ?? {}).map(([name, phase]) => [name, Math.round(phase.ms)]),
    ),
  }),
)
