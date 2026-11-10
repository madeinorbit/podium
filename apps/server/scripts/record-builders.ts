/**
 * RECORD BUILDERS ON A DATABASE COPY (POD-6763, design POD-6253 §1).
 *
 * Two jobs, both read-only on the copy (it is opened with `readOnly`, inside
 * one read transaction, so every read shares one snapshot):
 *
 *   parity  For each of the 37 kinds built from the database, compare `build(ids)` and
 *           `streamAll()` with the `change_latest` payloads, record for record.
 *           The effect kind is built with the server's real effect executors,
 *           taken from a server booted on an empty temporary store.
 *
 *   load    One arm of the start-up load measurement, in its own process so
 *           its peak memory is its own: `--arm=latest` streams the producer's
 *           `change_latest` read (parse each payload, serialize the change);
 *           `--arm=builders` streams every kind's `streamAll()` and serializes
 *           the same change shape. Prints one JSON line: rows, bytes, ms and
 *           peak memory, in total and per kind.
 *
 *   bench   Runs `load` for both arms, interleaved latest/builders for
 *           `--rounds` rounds, and prints the medians side by side.
 *
 * Run on the bench VM (never on the operator's live machine, never on a live
 * database):
 *
 *   bun --conditions=@podium/source apps/server/scripts/record-builders.ts parity --db=<copy> [--immutable] [--kinds=a,b] [--out=<file.json>] [--samples=5] [--values]
 *   bun --conditions=@podium/source apps/server/scripts/record-builders.ts bench --db=<copy> [--rounds=3] [--out=<file.json>]
 *   bun --conditions=@podium/source apps/server/scripts/record-builders.ts load --db=<copy> --arm=latest|builders
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MetadataEntityKind } from '@podium/protocol'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { SyncRepository } from '@podium/sync/adapters/sqlite/sync-repository'
import { syncServerTables } from '../src/migrations/sync-server-tables'
import type { EffectExecutorRegistry } from '../src/modules/effects/registry'
import { createBunStoreExecutor } from '../src/store/executor/bun-driver'
import { DATABASE_ONLY_BUILDERS, serverRecordBuilders } from '../src/sync/record-builders'
import { atParity, type KindParity, kindParity } from '../src/sync/record-parity'
import { recordReadsOver } from '../src/sync-worker/record-reads'

const args = new Map(
  process.argv.slice(3).flatMap((arg) => {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
    return match ? [[match[1]!, match[2] ?? ''] as const] : []
  }),
)
const command = process.argv[2]
const dbPath = args.get('db')
if (!dbPath || !['parity', 'load', 'bench'].includes(command ?? '')) {
  console.error('usage: record-builders.ts parity|load|bench --db=<copy> [...]')
  process.exit(2)
}

const ALL_KINDS = DATABASE_ONLY_BUILDERS.map((builder) => builder.kind)
const kinds: MetadataEntityKind[] = args.has('kinds')
  ? (args.get('kinds')!.split(',') as MetadataEntityKind[])
  : ALL_KINDS

/** Open the copy read-only and fix one snapshot for every read that follows. */
function openSnapshot(path: string): SqlDatabase {
  // `--immutable` for a backup file nothing writes: no locks, no -wal/-shm touched.
  const db = openDatabase(path, { readOnly: true, immutable: args.has('immutable') })
  db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN')
  db.prepare("SELECT seq FROM sqlite_sequence WHERE name='changes'").get()
  return db
}

/**
 * The server's effect executors, from a server booted on an empty store and
 * stopped at once: the executors are code (each kind's input schema and
 * publish step), and a running server's timers would compete with the reads.
 */
async function realEffectExecutors(): Promise<EffectExecutorRegistry> {
  const { openTestStore } = await import('../src/test-support/open-test-store')
  const { SessionRegistry } = await import('../src/relay')
  const dir = mkdtempSync(join(tmpdir(), 'record-builders-executors-'))
  const store = await openTestStore(join(dir, 'podium.db'))
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  const executors = reg.modules.effects?.executors
  await reg.dispose()
  await store.close()
  rmSync(dir, { recursive: true, force: true })
  if (executors === undefined) throw new Error('the booted server has no effects module')
  return executors
}

/** A stand-in for the load measurement only: every kind publishes its stored
 *  input as is, which costs what the real mapping costs. */
const passthroughExecutors = {
  get: () => ({ input: { safeParse: (v: unknown) => ({ success: true, data: v }) } }),
} as unknown as EffectExecutorRegistry

/**
 * Fields left out of the comparison, per kind. The issue's four fat fields
 * leave the issue record in the slim-records phase (POD-6767), which changes
 * the projection both sides use; they are compared again once it lands.
 */
const IGNORED_FIELDS: Partial<Record<MetadataEntityKind, readonly string[]>> = {
  issueProjection: ['brief', 'panel', 'description', 'activityNotes'],
}

async function parity(): Promise<void> {
  const executors = await realEffectExecutors()
  const db = openSnapshot(dbPath!)
  const { reads, close } = recordReadsOver(db, { effectExecutors: executors })
  const sync = new SyncRepository(
    createBunStoreExecutor({ database: db }).queries,
    syncServerTables,
  )
  const registry = serverRecordBuilders()
  const results: KindParity[] = []
  const started = performance.now()
  try {
    for (const kind of kinds) {
      const t = performance.now()
      const published = (await sync.installedStatesOf(kind)).map((row) => ({
        entityId: row.entityId,
        payload: row.payload,
      }))
      const result = await kindParity(registry, reads, kind, published, {
        sampleLimit: Number(args.get('samples') ?? 5),
        keepValues: args.has('values'),
        ignoreFields: IGNORED_FIELDS[kind] ?? [],
      })
      results.push(result)
      console.error(
        `${kind}: published ${result.published}, equal ${result.equal}, differing ${result.differing}, ` +
          `not built ${result.notBuilt}, streamed ${result.streamed}, not published ${result.notPublished}, ` +
          `not streamed ${result.notStreamed} (${Math.round(performance.now() - t)} ms)`,
      )
    }
  } finally {
    db.exec('ROLLBACK')
    await close()
  }
  const report = {
    db: dbPath,
    at: new Date().toISOString(),
    ms: Math.round(performance.now() - started),
    atParity: results.filter(atParity).map((r) => r.kind),
    notAtParity: results.filter((r) => !atParity(r)).map((r) => r.kind),
    kinds: results,
  }
  const out = args.get('out')
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(table(results))
}

function table(results: readonly KindParity[]): string {
  const head = [
    'kind',
    'published',
    'equal',
    'byte-eq',
    'differ',
    'not built',
    'streamed',
    'not pub',
    'not str',
    'top differing fields',
  ]
  const rows = results.map((r) => [
    r.kind,
    r.published,
    r.equal,
    r.byteEqual,
    r.differing,
    r.notBuilt,
    r.streamed,
    r.notPublished,
    r.notStreamed,
    Object.entries(r.differingFields)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([field, n]) => `${field}:${n}`)
      .join(' '),
  ])
  return [head, ...rows].map((row) => `| ${row.join(' | ')} |`).join('\n')
}

// ---------------------------------------------------------------------------
// Start-up load
// ---------------------------------------------------------------------------

interface ArmResult {
  arm: 'latest' | 'builders'
  rows: number
  bytes: number
  ms: number
  /** Kernel high-water mark of this process's resident memory, MB. */
  peakRssMb: number
  /** Resident memory before the load began, MB. */
  startRssMb: number
  peakHeapMb: number
  perKind: Record<string, { rows: number; bytes: number; ms: number }>
}

const utf8 = new TextEncoder()
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10

function vmHwmMb(): number {
  try {
    const match = /VmHWM:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))
    return match ? Math.round((Number(match[1]) / 1024) * 10) / 10 : Number.NaN
  } catch {
    return Number.NaN
  }
}

async function load(): Promise<void> {
  const arm = args.get('arm') as ArmResult['arm']
  if (arm !== 'latest' && arm !== 'builders') throw new Error('--arm=latest|builders')
  const wanted = new Set<string>(kinds)
  const db = openSnapshot(dbPath!)
  const startRssMb = mb(process.memoryUsage().rss)
  let peakHeap = process.memoryUsage().heapUsed
  const sample = () => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)
  }
  const perKind: ArmResult['perKind'] = {}
  const entryOf = (kind: string) => {
    perKind[kind] ??= { rows: 0, bytes: 0, ms: 0 }
    return perKind[kind]
  }
  const count = (kind: string, bytes: number, ms = 0) => {
    const entry = entryOf(kind)
    entry.rows++
    entry.bytes += bytes
    entry.ms += ms
  }
  let rows = 0,
    bytes = 0
  const started = performance.now()
  if (arm === 'latest') {
    // The producer's pass two, without visibility: the same statement.
    const statement = db.prepare(
      'SELECT seq, entity, entity_id, payload FROM change_latest ORDER BY seq',
    )
    let n = 0
    for (const row of statement.iterate!() as IterableIterator<{
      seq: number
      entity: string
      entity_id: string
      payload: string
    }>) {
      if (!wanted.has(row.entity)) continue
      const change = {
        seq: row.seq,
        entity: row.entity,
        entityId: row.entity_id,
        op: 'upsert',
        value: JSON.parse(row.payload),
      }
      const size = utf8.encode(JSON.stringify(change)).byteLength
      rows++
      bytes += size
      count(row.entity, size)
      if (++n % 500 === 0) sample()
    }
    statement.finalize?.()
  } else {
    const { reads, close } = recordReadsOver(db, { effectExecutors: passthroughExecutors })
    const registry = serverRecordBuilders()
    for (const kind of kinds) {
      const t = performance.now()
      for await (const page of registry.streamAll(reads, kind)) {
        for (const record of page) {
          const change = {
            seq: 0,
            entity: kind,
            entityId: record.id,
            op: 'upsert',
            value: record.value,
          }
          const size = utf8.encode(JSON.stringify(change)).byteLength
          rows++
          bytes += size
          count(kind, size)
        }
        sample()
      }
      entryOf(kind).ms = Math.round(performance.now() - t)
    }
    await close().catch(() => {})
  }
  const ms = Math.round(performance.now() - started)
  sample()
  const result: ArmResult = {
    arm,
    rows,
    bytes,
    ms,
    peakRssMb: vmHwmMb(),
    startRssMb,
    peakHeapMb: mb(peakHeap),
    perKind,
  }
  console.log(JSON.stringify(result))
}

async function bench(): Promise<void> {
  const rounds = Number(args.get('rounds') ?? 3)
  const runs: ArmResult[] = []
  for (let round = 1; round <= rounds; round++) {
    for (const arm of round % 2
      ? (['latest', 'builders'] as const)
      : (['builders', 'latest'] as const)) {
      const child = spawnSync(
        process.execPath,
        [
          '--conditions=@podium/source',
          process.argv[1]!,
          'load',
          `--db=${dbPath}`,
          `--arm=${arm}`,
          ...(args.has('kinds') ? [`--kinds=${args.get('kinds')}`] : []),
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      )
      if (child.status !== 0) throw new Error(`${arm} round ${round} failed:\n${child.stderr}`)
      const line = child.stdout.trim().split('\n').at(-1)!
      const result = JSON.parse(line) as ArmResult
      runs.push(result)
      console.error(
        `round ${round} ${arm}: ${result.rows} rows, ${mb(result.bytes)} MB, ${result.ms} ms, peak RSS ${result.peakRssMb} MB`,
      )
    }
  }
  const med = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  }
  const summary = (arm: ArmResult['arm']) => {
    const of = runs.filter((run) => run.arm === arm)
    return {
      arm,
      rounds: of.length,
      rows: of[0]?.rows,
      mb: mb(of[0]?.bytes ?? 0),
      msMedian: med(of.map((run) => run.ms)),
      msAll: of.map((run) => run.ms),
      peakRssMbMedian: med(of.map((run) => run.peakRssMb)),
      startRssMbMedian: med(of.map((run) => run.startRssMb)),
      peakHeapMbMedian: med(of.map((run) => run.peakHeapMb)),
    }
  }
  const report = {
    db: dbPath,
    at: new Date().toISOString(),
    latest: summary('latest'),
    builders: summary('builders'),
    runs,
  }
  const out = args.get('out')
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ latest: report.latest, builders: report.builders }, null, 2))
}

if (command === 'parity') await parity()
else if (command === 'load') await load()
else await bench()
process.exit(0)
