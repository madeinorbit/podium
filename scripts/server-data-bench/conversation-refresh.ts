/**
 * POD-7414 finding 5, generated data on a disposable store (agent VM only):
 * bun --conditions=@podium/source scripts/server-data-bench/conversation-refresh.ts
 * Prefix with PODIUM_TEST_STORE_ENGINE=pg for the Postgres leg.
 *
 * Compare the pre-fix refresh SQL with the production ensureMany refresh in
 * the same process and database. Report only the refresh statements' driver
 * wall time: the candidate's id lookups and offer folding are outside that
 * counter. Each sample re-offers all 11,347 segments twice. The report gives
 * that table size and two calls, but does not give their per-call offer counts.
 * Setup, verification and update-probe reads are outside the measured window.
 */
import '../../test-hermetic-env'
import assert from 'node:assert/strict'
import { asMachineId } from '@podium/model'
import { eq, sql } from 'drizzle-orm'
import { SELF_HOSTED_WORKSPACE_ID } from '../../apps/server/src/self-hosted-workspace'
import { dialectOf } from '../../apps/server/src/store/executor/dialect-prepared'
import {
  probeStatements,
  type StatementProbeHolder,
} from '../../apps/server/src/store/executor/statement-probe'
import {
  inWorkspace,
  param,
  prepared,
  type StoreDrizzle,
  type WorkspaceQueries,
} from '../../apps/server/src/store/executor/sync-drizzle'
import { openTestStore } from '../../apps/server/src/test-support/open-test-store'
import { testStoreEngine } from '../../apps/server/src/test-support/pg-test-database'
import { pgBunTestRun } from '../../apps/server/src/test-support/pg-test-host'
import { storeSql, updateCounter } from '../../apps/server/src/test-support/store-sql'

// Frozen pre-fix refreshSegmentFiles (parent b70fcea358). Keep the correlated
// scans so the benchmark measures the actual defect, on both SQL dialects.
const offeredRows = (db: StoreDrizzle) =>
  dialectOf(db) === 'pg'
    ? sql`json_array_elements(CAST(${sql.placeholder('rows')} AS json)) AS r(value)`
    : sql`json_each(${sql.placeholder('rows')})`
const offered = (db: StoreDrizzle, field: string, type?: 'bigint') =>
  dialectOf(db) !== 'pg'
    ? sql`value ->> ${`$.${field}`}`
    : type === undefined
      ? sql`(value ->> ${field})`
      : sql`CAST(value ->> ${field} AS bigint)`
const offeredKey = (db: StoreDrizzle, field: string) =>
  dialectOf(db) === 'pg' ? sql`${offered(db, field)} COLLATE "C"` : offered(db, field)
const beforeRefresh = prepared((db, t) => {
  const of = (field: string, type?: 'bigint') =>
    sql`(SELECT ${offered(db, field, type)} FROM ${offeredRows(db)} WHERE ${offeredKey(db, 'nativeId')} = ${t.conversationSegments.nativeId})`
  const path = sql`COALESCE(${of('path')}, ${t.conversationSegments.path})`
  const reportedBytes = sql`COALESCE(${of('reportedBytes', 'bigint')}, ${t.conversationSegments.reportedBytes})`
  const differs = dialectOf(db) === 'pg' ? sql`IS DISTINCT FROM` : sql`IS NOT`
  return db
    .update(t.conversationSegments)
    .set({ path, reportedBytes })
    .where(
      inWorkspace(
        t.conversationSegments,
        eq(t.conversationSegments.machineId, param(t.conversationSegments.machineId, 'machineId')),
        sql`${t.conversationSegments.nativeId} IN (SELECT ${offeredKey(db, 'nativeId')} FROM ${offeredRows(db)})`,
        sql`(${t.conversationSegments.path} ${differs} ${path} OR ${t.conversationSegments.reportedBytes} ${differs} ${reportedBytes})`,
      ),
    )
    .prepare()
})

const SEGMENTS = 11_347
const SCANS = 2
const PAIRS = 3
const machineId = asMachineId('refresh-benchmark-machine')
const entries = Array.from({ length: SEGMENTS }, (_, i) => ({
  nativeId: `native-${String(i).padStart(5, '0')}`,
  providerId: 'generated',
  path: `/transcripts/native-${i}.jsonl`,
  sizeBytes: i * 1024,
}))
const rows = JSON.stringify(
  entries.map(({ nativeId, path, sizeBytes }) => ({ nativeId, path, reportedBytes: sizeBytes })),
)
const cleanup = await pgBunTestRun()
try {
  const store = await openTestStore(':memory:')
  try {
    const registry = store.conversations.registry
    const ids = await registry.ensureMany(machineId, entries)
    const raw = storeSql(store)
    const snapshot = () =>
      raw.all(sql`SELECT native_id, path, reported_bytes FROM conversation_segments
        WHERE workspace_id = ${SELF_HOSTED_WORKSPACE_ID} AND machine_id = ${machineId}
        ORDER BY native_id`)
    const initial = await snapshot()
    assert.equal(initial.length, SEGMENTS)
    const writes = await updateCounter(store, ['conversation_segments'])
    // The test helper's workspace query capability, also used by repositories.
    const { queries } = store as unknown as { queries: WorkspaceQueries }
    const legacy = beforeRefresh(queries.db)
    const results: {
      pair: number
      arm: 'before' | 'after'
      refreshSqlMs: number
      statements: number
    }[] = []
    for (let pair = 0; pair < PAIRS; pair++) {
      const arms = pair % 2 === 0 ? (['before', 'after'] as const) : (['after', 'before'] as const)
      for (const arm of arms) {
        let refreshSqlMs = 0
        let statements = 0
        const detach = probeStatements(store as unknown as StatementProbeHolder, (observation) => {
          if (!/\bupdate "conversation_segments"/.test(observation.sql)) return
          assert.equal(observation.failed, false)
          refreshSqlMs += observation.durationMs
          statements++
        })
        try {
          for (let scan = 0; scan < SCANS; scan++) {
            await store.transact(async () => {
              if (arm === 'before') await legacy.run({ machineId, rows })
              else assert.deepEqual(await registry.ensureMany(machineId, entries), ids)
            })
          }
        } finally {
          detach()
        }
        assert.equal(statements, SCANS * (arm === 'before' ? 1 : Math.ceil(SEGMENTS / 500)))
        assert.equal(await writes(), 0)
        assert.deepEqual(await snapshot(), initial)
        const result = { pair, arm, refreshSqlMs, statements }
        results.push(result)
        console.log(JSON.stringify(result))
      }
    }
    const median = (arm: 'before' | 'after') => {
      const values = results
        .filter((result) => result.arm === arm)
        .map((result) => result.refreshSqlMs)
      values.sort((a, b) => a - b)
      return values[Math.floor(values.length / 2)] ?? 0
    }
    console.log(
      JSON.stringify({
        engine: testStoreEngine(),
        segments: SEGMENTS,
        scansPerSample: SCANS,
        pairs: PAIRS,
        beforeMedianSqlMs: median('before'),
        afterMedianSqlMs: median('after'),
        speedup: median('before') / median('after'),
        updatedRows: await writes(),
        verifiedSegments: initial.length,
        results,
      }),
    )
  } finally {
    await store.close()
  }
} finally {
  await cleanup()
}
