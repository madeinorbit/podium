/**
 * POD-7585: one start-up replay of the access moves over a full tail, with and
 * without the narrow read. Generated data on a disposable store, for an agent VM only:
 * bun --conditions=@podium/source scripts/server-data-bench/access-move-replay.ts
 * Prefix with PODIUM_TEST_STORE_ENGINE=pg for the Postgres leg.
 *
 * The store holds a change log of ACCESS_MOVE_REPLAY_BOUND rows, the longest
 * tail a replay evaluates: issue and session records with payloads of about
 * 2 KiB, and machine rows (what machine reports rewrite most often). One
 * machine row in fifty moves its custodian. The measured operation is the
 * replay of the whole tail, as a process runs it at start after a crash.
 *
 * Arms, in one process and on one database:
 *  - before: the first version of this issue, which read each page whole
 *    (`changesInRange`, payloads parsed) and evaluated the kinds that move access;
 *  - after: the production replay (`Authority.catchUpAccessMoves`), which reads
 *    each page by name only (`changeRefsInRange`) and re-reads the floor per page.
 * Five alternating pairs after one warm-up of each; setup is excluded. Both arms
 * must record the same moves. Reported per arm: the median wall time.
 */
import '../../test-hermetic-env'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MetadataEntityKind } from '@podium/protocol'
import {
  ACCESS_MOVE_REPLAY_BOUND,
  type AccessMoveLogPort,
  Authority,
  DeviceGradeUnscopedPolicy,
  type RecordSourcePort,
  type VisibilityAnchorPort,
} from '@podium/sync'
import { edgeMovesAccess, makeFeedVisibility } from '../../apps/server/src/feed-visibility'
import { EffectExecutorRegistry } from '../../apps/server/src/modules/effects/registry'
import type { SessionStore } from '../../apps/server/src/store'
import { databaseRecords } from '../../apps/server/src/sync/record-source'
import { TEST_MACHINE_ID } from '../../apps/server/src/test-support/machine-id'
import { openTestStore } from '../../apps/server/src/test-support/open-test-store'
import { testStoreEngine } from '../../apps/server/src/test-support/pg-test-database'
import { pgBunTestRun } from '../../apps/server/src/test-support/pg-test-host'
import { median } from './report'

/** `ACCESS_MOVE_REPLAY_SMOKE=1` checks the script at 2% of the size, once. */
const SMOKE = process.env.ACCESS_MOVE_REPLAY_SMOKE === '1'
const ROWS = SMOKE ? Math.round(ACCESS_MOVE_REPLAY_BOUND * 0.02) : ACCESS_MOVE_REPLAY_BOUND
const PAIRS = SMOKE ? 1 : 5
const PAGE = 1_000
const APPEND_BATCH = 100
const MACHINES = 40

type Arm = 'before' | 'after'
interface Sample {
  readonly arm: Arm
  readonly ms: number
  readonly humans: number
}

function rowOf(n: number) {
  const text = `Generated record ${n}. ${'Change log replay fixture. '.repeat(70)}`
  switch (n % 5) {
    case 0:
    case 1:
      return { entity: 'issueProjection', entityId: `issue-${n % 997}`, payload: { id: n, text } }
    case 2:
      return { entity: 'session', entityId: `session-${n % 1_499}`, payload: { id: n, text } }
    default: {
      const machine = n % MACHINES
      // Every fiftieth machine row moves its custodian; the rest rewrite it unchanged.
      const custodian = Math.floor(n / (MACHINES * 50)) % 2 === 0 ? 'u-ada' : 'u-lin'
      return {
        entity: 'machine',
        entityId: `machine-${machine}`,
        payload: { id: `machine-${machine}`, custodian, version: `1.0.${n}`, services: [] },
      }
    }
  }
}

async function seed(store: SessionStore): Promise<void> {
  for (let start = 0; start < ROWS; start += APPEND_BATCH) {
    const rows = Array.from({ length: Math.min(APPEND_BATCH, ROWS - start) }, (_, i) => {
      const row = rowOf(start + i)
      return {
        entity: row.entity as MetadataEntityKind,
        entityId: row.entityId,
        op: 'upsert' as const,
        payload: JSON.stringify(row.payload),
      }
    })
    await store.sync.appendChanges(rows, Date.parse('2026-11-24T00:00:00.000Z') + start)
  }
}

/** An access-move log in memory: each arm records into its own, so every run replays. */
function memoryMoves(): { port: AccessMoveLogPort; moves: Map<string, number> } {
  const moves = new Map<string, number>()
  const port: AccessMoveLogPort = {
    recordAccessMoves: async (batch) => {
      for (const [human, seq] of batch) moves.set(human, Math.max(moves.get(human) ?? 0, seq))
    },
    readRecordedThrough: async () => 0,
    raiseRecordingStart: async () => {
      throw new Error('the bench tail must be replayed, not skipped')
    },
    movesAccess: edgeMovesAccess,
  }
  return { port, moves }
}

/** The first version of the replay: whole rows, payloads parsed, then the same edges. */
async function replayWhole(store: SessionStore, anchors: VisibilityAnchorPort, head: number) {
  const moves = new Map<string, number>()
  let at = 0
  while (at < head) {
    const rows = await store.sync.changesInRange(at, head, PAGE)
    if (rows.length === 0) break
    const relevant = rows.filter(
      (row) => MetadataEntityKind.safeParse(row.entity).success && edgeMovesAccess(row.entity),
    )
    for (const row of rows) if (row.payload != null) JSON.parse(row.payload)
    const edges = await anchors.visibilityEdges(
      relevant.map((row) => ({
        entity: row.entity as MetadataEntityKind,
        entityId: row.entityId,
        seq: row.seq,
      })),
    )
    edges.forEach((edge, i) => {
      const seq = relevant[i]?.seq
      if (edge === null || seq === undefined) return
      for (const human of edge.audience)
        moves.set(String(human), Math.max(moves.get(String(human)) ?? 0, seq))
    })
    at = rows[rows.length - 1]?.seq ?? head
  }
  return moves
}

const cleanup = await pgBunTestRun()
const directory = await mkdtemp(join(tmpdir(), 'server-data-bench-access-move-replay-'))
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
    const head = await store.sync.maxChangeSeq()
    assert.equal(head, ROWS)
    const records = databaseRecords({
      store,
      effectExecutors: new EffectExecutorRegistry(),
      now: Date.now,
    })
    const { anchors } = makeFeedVisibility({
      store,
      audiencesFor: (kind, ids) => store.grants.visibilityAudiencesFor(kind, ids),
      authorizationRevision: () => store.grants.visibilityRevision(),
      currentRecords: records.build,
    })
    const run = async (arm: Arm): Promise<{ sample: Sample; moves: Map<string, number> }> => {
      const started = performance.now()
      let moves: Map<string, number>
      if (arm === 'before') {
        moves = await replayWhole(store, anchors, head)
      } else {
        const log = memoryMoves()
        const authority = new Authority({
          store: store.sync,
          now: Date.now,
          transact: async (fn) => await fn(),
          visibility: new DeviceGradeUnscopedPolicy(),
          anchors,
          accessMoves: log.port,
          records: {} as RecordSourcePort,
        })
        await authority.catchUpAccessMoves()
        assert.equal(authority.accessMovesRecordedThrough(), head)
        moves = log.moves
      }
      return { sample: { arm, ms: performance.now() - started, humans: moves.size }, moves }
    }

    // Warm-up, and the equivalence check: both arms record the same moves.
    const before = await run('before')
    const after = await run('after')
    assert.deepEqual([...after.moves].sort(), [...before.moves].sort())

    const samples: Sample[] = []
    for (let pair = 0; pair < PAIRS; pair++) {
      for (const arm of pair % 2 === 0
        ? (['before', 'after'] as const)
        : (['after', 'before'] as const))
        samples.push((await run(arm)).sample)
    }
    const summary = (arm: Arm) => {
      const of = samples.filter((sample) => sample.arm === arm)
      return { msMedian: Math.round(median(of.map((s) => s.ms))), humans: of[0]?.humans }
    }
    console.log(
      JSON.stringify(
        {
          bench: 'access-move-replay',
          engine,
          smoke: SMOKE,
          rows: ROWS,
          pairs: PAIRS,
          seedMs: Math.round(seedMs),
          before: summary('before'),
          after: summary('after'),
          samplesMs: samples.map((s) => `${s.arm} ${Math.round(s.ms)}`).join(', '),
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
