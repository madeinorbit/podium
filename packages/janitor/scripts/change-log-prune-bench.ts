/**
 * Compare the pre-tenant prune planner with the production planner on disposable
 * file-backed logs. Run on the benchmark host with the repository's lane helper:
 * bun --conditions=@podium/source packages/janitor/scripts/change-log-prune-bench.ts
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase, type SqlParam } from '@podium/runtime/sqlite'
import { ChangeLogPrunePlanner } from '../src/janitor'

const SAMPLES = 9
const WARMUPS = 3
const PAYLOAD_BYTES = 1_024
const migrationRoot = new URL('../../../apps/server/src/migrations/drizzle/', import.meta.url)
const migrationName = readdirSync(migrationRoot).find((name) =>
  name.endsWith('_changes-event-time-covering'),
)
if (!migrationName) throw new Error('covering age-index migration not found')
const migration = readFileSync(new URL(`${migrationName}/migration.sql`, migrationRoot), 'utf8')

async function timing(run: () => unknown | Promise<unknown>) {
  for (let i = 0; i < WARMUPS; i++) await run()
  const samples: number[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const start = performance.now()
    await run()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return { medianMs: samples[Math.floor(samples.length / 2)]!, maxMs: samples.at(-1)! }
}

function plan(db: SqlDatabase, sql: string, params: SqlParam[]) {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(
    (row) => row.detail,
  )
}

async function bench(rows: number) {
  console.error(`change-log-prune bench: ${rows} rows, ${PAYLOAD_BYTES}-byte payloads`)
  const directory = mkdtempSync(join(tmpdir(), 'change-log-prune-bench-'))
  const path = join(directory, 'bench.db')
  const db = openDatabase(path)
  try {
    db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA cache_size = -16384;
      CREATE TABLE changes (
        tenant_id TEXT NOT NULL, seq INTEGER NOT NULL, entity TEXT NOT NULL,
        entity_id TEXT NOT NULL, op TEXT NOT NULL, payload TEXT,
        event_time INTEGER NOT NULL, origin_id TEXT, causation_id TEXT, mutation_id TEXT,
        PRIMARY KEY (tenant_id, seq)
      );
      CREATE INDEX changes_entity ON changes (tenant_id, entity, entity_id, seq);
      CREATE INDEX changes_event_time ON changes (tenant_id, event_time);
      CREATE TABLE sync_feed (
        tenant_id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, epoch TEXT NOT NULL,
        minted_at INTEGER NOT NULL, head_seq INTEGER NOT NULL, floor_seq INTEGER NOT NULL
      );
    `)
    db.prepare(`
      WITH RECURSIVE numbers(seq) AS (
        SELECT 1 UNION ALL SELECT seq + 1 FROM numbers WHERE seq < ?
      )
      INSERT INTO changes
      SELECT 'local', seq, 'issueProjection', 'issue-' || seq, 'upsert', ?, seq, NULL, NULL, NULL
      FROM numbers
    `).run(rows, 'x'.repeat(PAYLOAD_BYTES))
    db.prepare("INSERT INTO sync_feed VALUES ('local', 'feed-bench', 'epoch-bench', 0, ?, 1)").run(
      rows,
    )
    const databaseMiB = statSync(path).size / 1_048_576
    const legacySql = [
      'SELECT COALESCE(MAX(seq), 0) AS m FROM changes',
      'SELECT MAX(seq) AS seq FROM changes WHERE event_time < ?',
      'SELECT MIN(seq) AS m FROM changes WHERE seq <= ?',
      'SELECT COUNT(*) AS n FROM changes WHERE seq <= ?',
    ]
    const legacy = legacySql.map((sql) => db.prepare(sql))
    const cutoffs = [0, Math.floor(rows / 2) + 1]
    const scenarios = []
    for (const cutoff of cutoffs) {
      const through = Math.max(rows - 500_000, cutoff - 1, 0)
      const params: SqlParam[][] = [[], [cutoff], [through], [through]]
      const statements = []
      for (let i = 0; i < legacySql.length; i++) {
        statements.push({
          sql: legacySql[i]!,
          plan: plan(db, legacySql[i]!, params[i]!),
          timing: await timing(() => legacy[i]!.get(...params[i]!)),
        })
      }
      const legacyTotal = await timing(() => {
        const head = legacy[0]!.get() as { m: number }
        const aged = legacy[1]!.get(cutoff) as { seq: number | null }
        const threshold = Math.max(head.m - 500_000, aged.seq ?? 0)
        if (threshold <= 0) return
        legacy[2]!.get(threshold)
        legacy[3]!.get(threshold)
      })
      scenarios.push({ agedRows: Math.max(cutoff - 1, 0), cutoff, legacyTotal, statements })
    }
    db.exec(migration)
    const preparedSql: string[] = []
    const traced: SqlDatabase = {
      prepare(sql) {
        preparedSql.push(sql)
        return db.prepare(sql)
      },
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
    }
    const planner = new ChangeLogPrunePlanner(traced)
    if (preparedSql.length !== 1) throw new Error('expected one prepared tenant-page query')
    const fixed = []
    for (const scenario of scenarios) {
      const input = {
        keepRows: 500_000,
        maxAgeMs: rows + 1_000 - scenario.cutoff,
        batchSize: 100,
        nowMs: rows + 1_000,
      }
      const details = plan(db, preparedSql[0]!, [scenario.cutoff, '', 25])
      if (details.some((detail) => /\bSCAN\b/.test(detail))) {
        throw new Error(`production planner scanned: ${details.join('; ')}`)
      }
      const batches = await planner.plan(input)
      fixed.push({
        agedRows: scenario.agedRows,
        plan: details,
        batchCount: batches.length,
        thresholdSeq: batches[0]?.thresholdSeq ?? 0,
        timing: await timing(() => planner.plan(input)),
      })
    }
    return { rows, databaseMiB, legacy: scenarios, fixed, productionSql: preparedSql[0] }
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

const results = []
for (const rows of [200_000, 500_000]) results.push(await bench(rows))
console.log(
  JSON.stringify(
    {
      benchmark: 'tenant change-log prune planner',
      bun: Bun.version,
      payloadBytes: PAYLOAD_BYTES,
      cache: 'warm OS cache; 16 MiB SQLite page cache',
      warmups: WARMUPS,
      samples: SAMPLES,
      migration: migrationName,
      results,
    },
    null,
    2,
  ),
)
