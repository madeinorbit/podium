import { asSessionId } from '@podium/model'
import type { SessionObservationCheckpointV1 } from '@podium/protocol'
import { expect, it } from 'vitest'

const at = '2026-07-18T12:00:00.000Z'

it('durably fences observation generations and rejects stale checkpoint writes', async () => {
  const store = await openTestStore(':memory:')
  try {
    const lease = await store.observationCheckpoints.advanceGeneration(asSessionId('s1'), 'codex', 'thread-1')
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
    expect((await store.observationCheckpoints.get(asSessionId('s1')))?.checkpoint).toEqual(checkpoint)

    const nextLease = await store.observationCheckpoints.advanceGeneration(asSessionId('s1'), 'codex', 'thread-1')
    expect(nextLease.observationGeneration).toBe(2)
    expect(nextLease.checkpoint).toEqual(checkpoint)
    expect(() => store.observationCheckpoints.save(checkpoint)).toThrow(
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
    await store.sessions.purgeSession(asSessionId('s1'))
    expect(await store.observationCheckpoints.get(asSessionId('s1'))).toBeNull()
  } finally {
    store.close()
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
    first.close()

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
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestStore } from '../test-support/open-test-store'
