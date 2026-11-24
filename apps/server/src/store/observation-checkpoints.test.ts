import { asSessionId, firstAdminMemberId } from '@podium/model'
import type { SessionObservationCheckpointV1 } from '@podium/protocol'
import { expect, it } from 'vitest'

const at = '2026-07-18T12:00:00.000Z'

it('durably fences observation generations and rejects stale checkpoint writes', async () => {
  const store = await openTestStore(':memory:')
  try {
    const lease = await store.observationCheckpoints.advanceGeneration(
      asSessionId('s1'),
      'codex',
      'thread-1',
    )
    expect(lease).toMatchObject({
      sessionId: asSessionId('s1'),
      provider: 'codex',
      providerSessionId: 'thread-1',
      bindingVersion: 1,
      observationGeneration: 1,
      checkpoint: null,
    })

    const checkpoint: SessionObservationCheckpointV1 = {
      schemaVersion: 1,
      podiumSessionId: asSessionId('s1'),
      provider: 'codex',
      providerSessionId: 'thread-1',
      bindingVersion: 1,
      lifecycleObservationGeneration: 1,
      providerCursor: { segmentId: 'rollout-1', components: { file: 42 } },
      bootstrapCursor: { segmentId: 'rollout-1', components: { file: 42 } },
      lastAcceptedLiveCursor: null,
      turnEpoch: 0,
      providerTurnId: null,
      providerPromptId: null,
      turnState: {
        phase: 'idle',
        since: at,
        workingMsTotal: 123,
        nativeSubagentCount: 0,
      },
      terminalFence: null,
      providerAt: at,
      acceptedAt: at,
      lastLiveReceiptAt: null,
      lastTransitionId: 'snapshot-42',
    }
    await store.observationCheckpoints.save(checkpoint)
    expect((await store.observationCheckpoints.get(asSessionId('s1')))?.checkpoint).toEqual(
      checkpoint,
    )

    const nextLease = await store.observationCheckpoints.advanceGeneration(
      asSessionId('s1'),
      'codex',
      'thread-1',
    )
    expect(nextLease.observationGeneration).toBe(2)
    expect(nextLease.checkpoint).toEqual(checkpoint)
    await expect(store.observationCheckpoints.save(checkpoint)).rejects.toThrow(
      'observation checkpoint lease changed',
    )
    const rebound = await store.observationCheckpoints.rebindExact({
      sessionId: asSessionId('s1'),
      provider: 'codex',
      providerSessionId: 'thread-1',
      bindingVersion: 1,
      observationGeneration: 2,
      nextProviderSessionId: 'thread-2',
    })
    expect(rebound).toMatchObject({
      kind: 'accepted',
      disposition: 'advanced',
      lease: {
        providerSessionId: 'thread-2',
        bindingVersion: 2,
        observationGeneration: 3,
        checkpoint: null,
      },
    })
    expect(
      await store.observationCheckpoints.rebindExact({
        sessionId: asSessionId('s1'),
        provider: 'codex',
        providerSessionId: 'thread-1',
        bindingVersion: 1,
        observationGeneration: 2,
        nextProviderSessionId: 'thread-3',
      }),
    ).toMatchObject({
      kind: 'rejected',
      rejectionReason: 'stale_observer_generation',
      lease: { providerSessionId: 'thread-2', bindingVersion: 2, observationGeneration: 3 },
    })
    expect(
      await store.observationCheckpoints.rebindExact({
        sessionId: asSessionId('s1'),
        provider: 'codex',
        providerSessionId: 'thread-2',
        bindingVersion: 2,
        observationGeneration: 3,
        nextProviderSessionId: 'thread-2',
      }),
    ).toMatchObject({
      kind: 'accepted',
      disposition: 'unchanged',
      lease: { bindingVersion: 2, observationGeneration: 3, checkpoint: null },
    })
    await store.sessions.purgeSession(fixtureWriteScope(), asSessionId('s1'))
    expect(await store.observationCheckpoints.get(asSessionId('s1'))).toBeNull()
  } finally {
    await store.close()
  }
})

it('reads only the record fields of a checkpoint, scoped as the full read (POD-7575)', async () => {
  const store = await openTestStore(':memory:')
  try {
    const owner = await firstAdminMemberId(store)
    const full = asSessionId('f-full')
    const corrupt = asSessionId('f-corrupt')
    const deleted = asSessionId('f-deleted')
    const threadLess = asSessionId('f-thread-less')
    const ids = [full, corrupt, asSessionId('f-lease-only'), deleted, threadLess]
    for (const id of ids) {
      await store.sessions.upsertSession(fixtureWriteScope(), {
        id,
        ownerUserId: owner,
        agentKind: 'codex',
        cwd: '/repo',
        title: id,
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
        createdAt: at,
        lastActiveAt: at,
        geometry: { cols: 80, rows: 24 },
        archived: false,
        workState: null,
        machineId: store.hostMachine!.id,
        lastOutputAt: null,
        lastInputAt: null,
        lastResumedAt: null,
        spawnedBy: null,
      } as never)
      await store.observationCheckpoints.advanceGeneration(
        id,
        'codex',
        id === threadLess ? null : `thread-${id}`,
      )
    }
    const checkpointOf = (
      id: string,
      overrides: Partial<SessionObservationCheckpointV1> = {},
    ): SessionObservationCheckpointV1 => ({
      schemaVersion: 1,
      podiumSessionId: asSessionId(id),
      provider: 'codex',
      providerSessionId: `thread-${id}`,
      bindingVersion: 1,
      lifecycleObservationGeneration: 1,
      // What makes a live checkpoint about 11 KB: cursors and transition ids.
      providerCursor: { segmentId: 'x'.repeat(4096), components: { file: 42 } },
      bootstrapCursor: { segmentId: 'y'.repeat(4096), components: { file: 42 } },
      lastAcceptedLiveCursor: null,
      turnEpoch: 3,
      providerTurnId: null,
      providerPromptId: null,
      turnState: { phase: 'idle', since: at, workingMsTotal: 4567, nativeSubagentCount: 0 },
      terminalFence: null,
      providerAt: at,
      acceptedAt: at,
      lastLiveReceiptAt: null,
      lastTransitionId: 'snapshot-1',
      acceptedTransitionIds: Array.from({ length: 32 }, (_, n) => `transition-${n}`),
      ...overrides,
    })
    await store.observationCheckpoints.save(checkpointOf(full))
    await store.observationCheckpoints.save(
      checkpointOf(corrupt, { turnState: { phase: 'nonsense' } as never }),
    )
    await store.observationCheckpoints.save(checkpointOf(deleted))
    await store.observationCheckpoints.save(
      checkpointOf(threadLess, { providerSessionId: null, providerAt: null }),
    )
    await store.sessions.softDeleteSessions(fixtureWriteScope(), [deleted], at, 'standalone')

    const facts = await store.observationCheckpoints.recordFactsOf(ids)
    const checkpoints = await store.observationCheckpoints.checkpointsOf(ids)
    // The same sessions as the full read: no lease-only, deleted or corrupt one.
    expect([...facts.keys()].sort()).toEqual([...checkpoints.keys()].sort())
    expect([...facts.keys()].sort()).toEqual([full, threadLess].sort())
    for (const [id, checkpoint] of checkpoints) {
      expect(facts.get(id)).toEqual({
        turnState: checkpoint.turnState,
        providerAt: checkpoint.providerAt,
        providerSessionId: checkpoint.providerSessionId,
      })
    }
  } finally {
    await store.close()
  }
})

it('keeps exact rebind retries idempotent across repository reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-observation-rebind-'))
  const path = join(dir, 'podium.sqlite')
  try {
    const first = await openTestStore(path)
    await first.observationCheckpoints.advanceGeneration(asSessionId('s1'), 'codex', null)
    expect(
      await first.observationCheckpoints.rebindExact({
        sessionId: asSessionId('s1'),
        provider: 'codex',
        providerSessionId: null,
        bindingVersion: 1,
        observationGeneration: 1,
        nextProviderSessionId: 'thread-1',
      }),
    ).toMatchObject({
      kind: 'accepted',
      disposition: 'advanced',
      lease: { providerSessionId: 'thread-1', bindingVersion: 2, observationGeneration: 2 },
    })
    await first.close()

    const reopened = await openTestStore(path)
    expect(
      await reopened.observationCheckpoints.rebindExact({
        sessionId: asSessionId('s1'),
        provider: 'codex',
        providerSessionId: null,
        bindingVersion: 1,
        observationGeneration: 1,
        nextProviderSessionId: 'thread-1',
      }),
    ).toMatchObject({
      kind: 'accepted',
      disposition: 'duplicate',
      lease: { providerSessionId: 'thread-1', bindingVersion: 2, observationGeneration: 2 },
    })
    expect(
      await reopened.observationCheckpoints.rebindExact({
        sessionId: asSessionId('s1'),
        provider: 'codex',
        providerSessionId: null,
        bindingVersion: 1,
        observationGeneration: 1,
        nextProviderSessionId: 'thread-2',
      }),
    ).toMatchObject({ kind: 'rejected', rejectionReason: 'stale_observer_generation' })
    await reopened.observationCheckpoints.rebindExact({
      sessionId: asSessionId('s1'),
      provider: 'codex',
      providerSessionId: 'thread-1',
      bindingVersion: 2,
      observationGeneration: 2,
      nextProviderSessionId: 'thread-2',
    })
    expect(
      await reopened.observationCheckpoints.rebindExact({
        sessionId: asSessionId('s1'),
        provider: 'codex',
        providerSessionId: null,
        bindingVersion: 1,
        observationGeneration: 1,
        nextProviderSessionId: 'thread-1',
      }),
    ).toMatchObject({ kind: 'rejected', rejectionReason: 'stale_observer_generation' })
    await reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// POD-7574: a daemon attach fences every survivor it probes, a set at a time.
describe('advanceGenerations', () => {
  const ids = (n: number, prefix = 'g') =>
    Array.from({ length: n }, (_, index) => asSessionId(`${prefix}${index}`))

  it('fences each session as advanceGeneration would, in one call', async () => {
    const store = await openTestStore(':memory:')
    try {
      const oc = store.observationCheckpoints
      const [known, unnamed, missing, kept] = ids(4)
      await oc.advanceGeneration(known!, 'codex', 'thread-known')
      await oc.advanceGeneration(known!, 'codex', 'thread-known')
      await oc.advanceGeneration(unnamed!, 'claude-code', null)
      await oc.advanceGeneration(kept!, 'codex', 'thread-kept')
      const leases = await oc.advanceGenerations([
        { sessionId: known!, provider: 'codex', providerSessionId: 'thread-known' },
        { sessionId: unnamed!, provider: 'claude-code', providerSessionId: 'thread-learned' },
        { sessionId: missing!, provider: 'codex', providerSessionId: 'thread-new' },
        // A stored provider id is never replaced by a conflicting hint.
        { sessionId: kept!, provider: 'codex', providerSessionId: 'thread-other' },
      ])
      expect([...leases.keys()].sort()).toEqual([known, unnamed, missing, kept].sort())
      expect(leases.get(known!)).toMatchObject({
        provider: 'codex',
        providerSessionId: 'thread-known',
        observationGeneration: 3,
      })
      expect(leases.get(unnamed!)).toMatchObject({
        provider: 'claude-code',
        providerSessionId: 'thread-learned',
        observationGeneration: 2,
      })
      expect(leases.get(missing!)).toMatchObject({
        provider: 'codex',
        providerSessionId: 'thread-new',
        bindingVersion: 1,
        observationGeneration: 1,
      })
      expect(leases.get(kept!)).toMatchObject({
        providerSessionId: 'thread-kept',
        observationGeneration: 2,
      })
      for (const [sessionId, lease] of leases) expect(await oc.get(sessionId)).toEqual(lease)
      expect(await oc.advanceGenerations([])).toEqual(new Map())
    } finally {
      await store.close()
    }
  })

  it('cancels a consumed proof and leaves an unconsumed one', async () => {
    const store = await openTestStore(':memory:')
    try {
      const oc = store.observationCheckpoints
      const [spent, armed] = ids(2, 'proof')
      for (const sessionId of [spent!, armed!]) {
        await oc.advanceGeneration(sessionId, 'codex', `thread-${sessionId}`)
        await oc.save(terminalCheckpoint(sessionId))
        await oc.recordTerminalCandidate(terminalFactsOf(sessionId), at)
        expect(await oc.confirmTerminalCandidate(terminalFactsOf(sessionId), 1, at)).toBe(
          'confirmed',
        )
      }
      expect(await oc.consumeTerminalCandidate(terminalFactsOf(spent!), at)).toBe(true)
      await oc.advanceGenerations(
        [spent!, armed!].map((sessionId) => ({
          sessionId,
          provider: 'codex' as const,
          providerSessionId: `thread-${sessionId}`,
        })),
      )
      expect(await oc.getTerminalCandidate(spent!)).toBeNull()
      expect((await oc.getTerminalCandidate(armed!))?.consumedAt).toBeNull()
    } finally {
      await store.close()
    }
  })

  // Review F5: where advanceGeneration throws, the set fence fails that row alone.
  it('leaves a lease another provider holds untouched, and fences the rest', async () => {
    const store = await openTestStore(':memory:')
    try {
      const oc = store.observationCheckpoints
      const [mine, theirs] = ids(2, 'p')
      await oc.advanceGeneration(mine!, 'codex', 'thread-mine')
      await oc.advanceGeneration(theirs!, 'claude-code', 'thread-theirs')
      const before = await oc.get(theirs!)
      const leases = await oc.advanceGenerations([
        { sessionId: mine!, provider: 'codex', providerSessionId: 'thread-mine' },
        { sessionId: theirs!, provider: 'codex', providerSessionId: 'thread-theirs' },
      ])
      expect([...leases.keys()]).toEqual([mine])
      expect(leases.get(mine!)?.observationGeneration).toBe(2)
      expect(await oc.get(theirs!)).toEqual(before)
      expect(
        await oc.advanceGenerations([
          { sessionId: theirs!, provider: 'codex', providerSessionId: 'thread-theirs' },
        ]),
      ).toEqual(new Map())
    } finally {
      await store.close()
    }
  })

  it('runs the same statements for 5 and 200 sessions', async () => {
    await expectConstantStatements(
      {
        name: 'advanceGenerations',
        async setup(size) {
          const store = await openTestStore(':memory:')
          const sessions = ids(size, 'n')
          for (const [index, sessionId] of sessions.entries()) {
            await store.observationCheckpoints.advanceGeneration(
              sessionId,
              index % 2 === 0 ? 'codex' : 'claude-code',
              `thread-${sessionId}`,
            )
          }
          return { store, sessions }
        },
        target: ({ store }) => store,
        run: ({ store, sessions }) =>
          store.observationCheckpoints.advanceGenerations(
            sessions.map((sessionId, index) => ({
              sessionId,
              provider: index % 2 === 0 ? ('codex' as const) : ('claude-code' as const),
              providerSessionId: `thread-${sessionId}`,
            })),
          ),
        check: (result, _fixture, size) => {
          const leases = result as Map<string, { observationGeneration: number }>
          expect(leases.size).toBe(size)
          for (const lease of leases.values()) expect(lease.observationGeneration).toBe(2)
        },
        teardown: ({ store }) => store.close(),
      },
      5,
    )
  })
})

function terminalFactsOf(sessionId: SessionId): TerminalCandidateFacts {
  return {
    ...terminalFacts('a', sessionId),
    providerSessionId: `thread-${sessionId}`,
    lastTransitionId: `last-${sessionId}`,
    terminalTransitionId: `terminal-${sessionId}`,
  }
}

function terminalCheckpoint(sessionId: SessionId): SessionObservationCheckpointV1 {
  const facts = terminalFactsOf(sessionId)
  return {
    ...seededCheckpoint('a', 1, sessionId),
    providerSessionId: facts.providerSessionId,
    providerCursor: facts.providerCursor,
    lastTransitionId: facts.lastTransitionId,
    terminalFence: {
      turnEpoch: 1,
      providerCursor: facts.providerCursor,
      verdict: 'done',
      transitionId: facts.terminalTransitionId,
    },
  } as SessionObservationCheckpointV1
}

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { describe } from 'vitest'
import { openTestStore } from '../test-support/open-test-store'
import { expectConstantStatements } from '../test-support/statement-count'
import {
  checkpoint as seededCheckpoint,
  terminalFacts,
} from '../test-support/workspace-seeds/events'
import type { TerminalCandidateFacts } from './types'
