/**
 * A SESSION RECORD READS A FEW FIELDS OF ITS CHECKPOINT, NOT THE CHECKPOINT
 * (POD-7575, server-data rule 5).
 *
 * The browser's session list is built from `session` records (`build(ids)` for
 * a change, `streamAll` for a first download or a rebuild after an update).
 * Each record restores its observation checkpoint's turn state, provider time
 * and thread id. It used to read and parse the whole checkpoint, about 11 KB of
 * cursors and transition ids on a live install, which cost dev.56 1-2.5 s per
 * rebuild. The statement count stayed the same (one read per 500 ids), so only
 * a byte budget sees it: the bytes these reads carry must not grow with the
 * size of the checkpoints, and the checkpoint read must stay a few hundred
 * bytes per session.
 */
import { asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import type { SessionObservationCheckpointV1 } from '@podium/protocol'
import { fixtureWriteScope } from '@podium/sync/testing'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { countResultBytes, type ResultBytesTally } from '../test-support/statement-count'
import { type RecordReads, serverRecordBuilders } from './record-builders'

const AT = '2026-11-24T00:00:00.000Z'
const SESSIONS = 40
/** The bytes the checkpoint read may carry per session: its id and the record's fields. */
const CHECKPOINT_BYTES_PER_SESSION = 400

const registry = serverRecordBuilders()

interface Fixture {
  store: SessionStore
  reads: RecordReads
  ids: SessionId[]
}

/** `SESSIONS` exited sessions, each with a checkpoint padded to about `padding` bytes. */
async function world(padding: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const owner = await firstAdminMemberId(store)
  const ids: SessionId[] = []
  for (let i = 0; i < SESSIONS; i++) {
    const id = asSessionId(`bytes-${String(i).padStart(3, '0')}`)
    ids.push(id)
    await store.sessions.upsertSession(fixtureWriteScope(), {
      id,
      ownerUserId: owner,
      agentKind: 'codex',
      cwd: '/repo',
      title: `Session ${i}`,
      name: null,
      nameSource: null,
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'exited',
      exitCode: 0,
      spawnFailure: null,
      durableLabel: `label-${id}`,
      createdAt: AT,
      lastActiveAt: AT,
      geometry: { cols: 80, rows: 24 },
      archived: false,
      workState: null,
      machineId: store.hostMachine!.id,
      lastOutputAt: null,
      lastInputAt: null,
      lastResumedAt: null,
      spawnedBy: null,
    } as never)
    await store.observationCheckpoints.advanceGeneration(id, 'codex', `thread-${id}`)
    const checkpoint: SessionObservationCheckpointV1 = {
      schemaVersion: 1,
      podiumSessionId: id,
      provider: 'codex',
      providerSessionId: `thread-${id}`,
      bindingVersion: 1,
      lifecycleObservationGeneration: 1,
      // The bulk of a live checkpoint: cursors and the accepted transition ids.
      providerCursor: { segmentId: 'p'.repeat(padding / 2), components: { file: i } },
      bootstrapCursor: { segmentId: 'b'.repeat(padding / 2), components: { file: i } },
      lastAcceptedLiveCursor: null,
      turnEpoch: 1,
      providerTurnId: null,
      providerPromptId: null,
      turnState: { phase: 'idle', since: AT, workingMsTotal: 1000 + i, nativeSubagentCount: 0 },
      terminalFence: null,
      providerAt: AT,
      acceptedAt: AT,
      lastLiveReceiptAt: null,
      lastTransitionId: 'snapshot-1',
    }
    await store.observationCheckpoints.save(checkpoint)
  }
  const reads: RecordReads = { store, effectExecutors: { get: () => undefined }, now: Date.now }
  return { store, reads, ids }
}

/** The bytes of the queries that read the checkpoint table. */
function checkpointBytes(tally: ResultBytesTally): number {
  let bytes = 0
  for (const [key, weight] of tally.byQuery)
    if (key.includes('session_observation_checkpoints')) bytes += weight
  return bytes
}

async function weigh(
  padding: number,
  operation: (f: Fixture) => Promise<unknown[]>,
  plant?: (f: Fixture) => void,
): Promise<{ tally: ResultBytesTally; records: unknown[] }> {
  const f = await world(padding)
  try {
    plant?.(f)
    const { result, ...tally } = await countResultBytes(f.store, () => operation(f))
    expect(result).toHaveLength(SESSIONS)
    return { tally, records: result }
  } finally {
    await f.store.close()
  }
}

const buildSessions = async (f: Fixture): Promise<unknown[]> =>
  await registry.build(f.reads, 'session', f.ids)

const operations: [string, (f: Fixture) => Promise<unknown[]>][] = [
  ['build(session ids)', buildSessions],
  [
    'streamAll(session)',
    async (f) => {
      const out: unknown[] = []
      for await (const page of registry.streamAll(f.reads, 'session')) out.push(...page)
      return out
    },
  ],
]

describe('session records: checkpoint bytes (POD-7575)', () => {
  for (const [name, operation] of operations) {
    it(`${name} reads the same bytes for 1 KB and 64 KB checkpoints`, async () => {
      const small = await weigh(1_000, operation)
      const large = await weigh(64_000, operation)
      // The records are the same: nothing a record shows lives in the padding.
      expect(large.records).toEqual(small.records)
      expect(checkpointBytes(large.tally)).toBe(checkpointBytes(small.tally))
      expect(large.tally.bytes).toBe(small.tally.bytes)
      expect(checkpointBytes(large.tally)).toBeGreaterThan(0)
      expect(checkpointBytes(large.tally)).toBeLessThanOrEqual(
        SESSIONS * CHECKPOINT_BYTES_PER_SESSION,
      )
    })
  }

  it('the budget is armed: reading whole checkpoints fails it', async () => {
    const whole = await weigh(64_000, buildSessions, (f) => {
      const checkpoints = f.store.observationCheckpoints
      checkpoints.recordFactsOf = async (ids) => await checkpoints.checkpointsOf(ids)
    })
    expect(checkpointBytes(whole.tally)).toBeGreaterThan(SESSIONS * 64_000)
  })
})
