/**
 * POD-7575: a browser's session-list rebuild with and without whole checkpoints.
 * Generated data on a disposable store, for an agent VM only:
 * bun --conditions=@podium/source scripts/server-data-bench/session-records.ts
 * Prefix with PODIUM_TEST_STORE_ENGINE=pg for the Postgres leg.
 *
 * The store holds the POD-7414 §4 population: 6,992 sessions, 4,914 of them with
 * an observation checkpoint of about 11 KiB (cursors and 32 accepted transition
 * ids). The measured operation is what a browser's rebuild asks the server for:
 * every `session` record, streamed page by page (`streamAll`, as a first
 * download or a rebuild after an update reads them).
 *
 * Arms, in one process and on one database:
 *  - before: the records restore their checkpoints with the whole-checkpoint
 *    read (`checkpointsOf`, parsed against the full schema), as they did before
 *    this issue;
 *  - after: the production read (`recordFactsOf`), only the fields a record uses.
 * Five alternating pairs after one warm-up of each; setup is excluded. Both arms
 * must build the same records. Reported per arm: the median wall time of the
 * whole stream, the checkpoint statements' driver time and the bytes they
 * carried back.
 */
import '../../test-hermetic-env'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import type { SessionObservationCheckpointV1 } from '@podium/protocol'
import { fixtureWriteScope } from '@podium/sync/testing'
import type { SessionStore } from '../../apps/server/src/store'
import {
  probeStatements,
  type StatementProbeHolder,
} from '../../apps/server/src/store/executor/statement-probe'
import { type RecordReads, serverRecordBuilders } from '../../apps/server/src/sync/record-builders'
import { TEST_MACHINE_ID } from '../../apps/server/src/test-support/machine-id'
import { openTestStore } from '../../apps/server/src/test-support/open-test-store'
import { testStoreEngine } from '../../apps/server/src/test-support/pg-test-database'
import { pgBunTestRun } from '../../apps/server/src/test-support/pg-test-host'
import { resultBytesOf } from '../../apps/server/src/test-support/statement-count'
import { median } from './report'

/** `SESSION_RECORDS_SMOKE=1` checks the script at 2% of the sizes, once. */
const SMOKE = process.env.SESSION_RECORDS_SMOKE === '1'
const scale = (n: number) => (SMOKE ? Math.max(10, Math.round(n * 0.02)) : n)
const SESSIONS = scale(6_992)
const CHECKPOINTS = scale(4_914)
const PAIRS = SMOKE ? 1 : 5
const SEED_BATCH = 250
const AT = '2026-11-24T00:00:00.000Z'

function checkpointOf(id: SessionId, n: number): SessionObservationCheckpointV1 {
  // About 11 KiB, as on the live install: two long cursors and the transition window.
  const segment = (tag: string) => `${tag}-${'0123456789abcdef'.repeat(256)}`
  return {
    schemaVersion: 1,
    podiumSessionId: id,
    provider: 'codex',
    providerSessionId: `thread-${id}`,
    bindingVersion: 1,
    lifecycleObservationGeneration: 1,
    providerCursor: { segmentId: segment('provider'), components: { file: n, line: n * 7 } },
    bootstrapCursor: { segmentId: segment('bootstrap'), components: { file: n } },
    lastAcceptedLiveCursor: { segmentId: `live-${n}`, components: { file: n } },
    turnEpoch: n % 17,
    providerTurnId: `turn-${n}`,
    providerPromptId: null,
    turnState: {
      phase: n % 3 === 0 ? 'working' : 'idle',
      since: AT,
      workingMsTotal: 60_000 + n,
      nativeSubagentCount: 0,
    },
    terminalFence: null,
    providerAt: AT,
    acceptedAt: AT,
    lastLiveReceiptAt: AT,
    lastTransitionId: `transition-${n}-31`,
    acceptedTransitionIds: Array.from(
      { length: 32 },
      (_, k) => `transition-${n}-${k}-${'x'.repeat(48)}`,
    ),
  }
}

async function seed(store: SessionStore): Promise<void> {
  const owner = await firstAdminMemberId(store)
  const machineId = store.hostMachine?.id ?? TEST_MACHINE_ID
  // SEED_BATCH sessions per transaction: seeding the whole store in one transaction did not
  // finish in 20 minutes on Postgres, each captured insert slower than the one before.
  for (let from = 0; from < SESSIONS; from += SEED_BATCH) {
    await store.transact(async () => {
      for (let n = from; n < Math.min(SESSIONS, from + SEED_BATCH); n++) {
        const id = asSessionId(`bench-${String(n).padStart(5, '0')}`)
        await store.sessions.upsertSession(fixtureWriteScope(), {
          id,
          ownerUserId: owner,
          agentKind: n % 2 ? 'codex' : 'claude-code',
          cwd: `/repo/.worktrees/issue-${n % 400}`,
          title: `Session ${n}`,
          name: null,
          nameSource: null,
          originKind: 'spawn',
          conversationId: null,
          resumeKind: null,
          resumeValue: null,
          status: n % 9 === 0 ? 'hibernated' : 'exited',
          exitCode: 0,
          spawnFailure: null,
          durableLabel: `label-${id}`,
          createdAt: new Date(Date.parse(AT) - (SESSIONS - n) * 60_000).toISOString(),
          lastActiveAt: AT,
          geometry: { cols: 120, rows: 40 },
          archived: n % 4 === 0,
          workState: null,
          machineId,
          lastOutputAt: null,
          lastInputAt: null,
          lastResumedAt: null,
          spawnedBy: null,
        } as never)
        if (n < CHECKPOINTS) {
          await store.observationCheckpoints.advanceGeneration(id, 'codex', `thread-${id}`)
          await store.observationCheckpoints.save(checkpointOf(id, n))
        }
      }
    })
  }
}

const registry = serverRecordBuilders()

interface Sample {
  arm: 'before' | 'after'
  streamMs: number
  checkpointMs: number
  checkpointBytes: number
  checkpointStatements: number
  records: number
}

async function rebuild(
  store: SessionStore,
  reads: RecordReads,
  arm: Sample['arm'],
): Promise<{ sample: Sample; records: unknown[] }> {
  let checkpointMs = 0
  let checkpointBytes = 0
  let checkpointStatements = 0
  const detach = probeStatements(store as unknown as StatementProbeHolder, (observation) => {
    if (!observation.sql.includes('session_observation_checkpoints')) return
    checkpointMs += observation.durationMs
    checkpointBytes += resultBytesOf(observation.resultRows ?? [])
    checkpointStatements += 1
  })
  const records: unknown[] = []
  const started = performance.now()
  try {
    for await (const page of registry.streamAll(reads, 'session')) records.push(...page)
  } finally {
    detach()
  }
  const streamMs = performance.now() - started
  return {
    sample: {
      arm,
      streamMs,
      checkpointMs,
      checkpointBytes,
      checkpointStatements,
      records: records.length,
    },
    records,
  }
}

const cleanup = await pgBunTestRun()
const directory = await mkdtemp(join(tmpdir(), 'server-data-bench-session-records-'))
try {
  const engine = testStoreEngine()
  const store = await openTestStore(
    engine === 'pg' ? ':memory:' : join(directory, 'bench.db'),
    TEST_MACHINE_ID,
  )
  try {
    const seeded = performance.now()
    await seed(store)
    const seedMs = performance.now() - seeded
    const reads: RecordReads = { store, effectExecutors: { get: () => undefined }, now: Date.now }
    const checkpoints = store.observationCheckpoints
    const narrow = checkpoints.recordFactsOf.bind(checkpoints)
    // The pre-fix read: every checkpoint whole, parsed against the full schema.
    const whole: typeof narrow = async (ids) => await checkpoints.checkpointsOf(ids)
    const run = async (arm: Sample['arm']) => {
      checkpoints.recordFactsOf = arm === 'before' ? whole : narrow
      try {
        return await rebuild(store, reads, arm)
      } finally {
        checkpoints.recordFactsOf = narrow
      }
    }

    // Warm-up, and the equivalence check: both arms build the same records.
    const before = await run('before')
    const after = await run('after')
    assert.equal(after.records.length, SESSIONS)
    assert.deepEqual(after.records, before.records)

    const samples: Sample[] = []
    for (let pair = 0; pair < PAIRS; pair++) {
      for (const arm of pair % 2 === 0
        ? (['before', 'after'] as const)
        : (['after', 'before'] as const))
        samples.push((await run(arm)).sample)
    }
    const summary = (arm: Sample['arm']) => {
      const of = samples.filter((sample) => sample.arm === arm)
      return {
        streamMsMedian: Math.round(median(of.map((s) => s.streamMs))),
        checkpointMsMedian: Math.round(median(of.map((s) => s.checkpointMs)) * 10) / 10,
        checkpointBytes: of[0]?.checkpointBytes,
        checkpointStatements: of[0]?.checkpointStatements,
        records: of[0]?.records,
      }
    }
    console.log(
      JSON.stringify(
        {
          bench: 'session-records',
          engine,
          smoke: SMOKE,
          sessions: SESSIONS,
          checkpoints: CHECKPOINTS,
          checkpointJsonBytes: JSON.stringify(checkpointOf(asSessionId('bench-00000'), 0)).length,
          pairs: PAIRS,
          seedMs: Math.round(seedMs),
          before: summary('before'),
          after: summary('after'),
          samples,
        },
        null,
        2,
      ),
    )
  } finally {
    await store.close()
  }
} finally {
  await rm(directory, { recursive: true, force: true })
  await cleanup()
}
