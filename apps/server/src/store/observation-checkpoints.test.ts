import type { SessionObservationCheckpointV1 } from '@podium/protocol'
import { expect, it } from 'vitest'
import { SessionStore } from '../store'

const at = '2026-07-18T12:00:00.000Z'

it('durably fences observation generations and rejects stale checkpoint writes', () => {
  const store = new SessionStore(':memory:')
  try {
    const lease = store.observationCheckpoints.advanceGeneration('s1', 'codex', 'thread-1')
    expect(lease).toMatchObject({
      sessionId: 's1',
      provider: 'codex',
      providerSessionId: 'thread-1',
      bindingVersion: 1,
      observationGeneration: 1,
      checkpoint: null,
    })

    const checkpoint: SessionObservationCheckpointV1 = {
      schemaVersion: 1,
      podiumSessionId: 's1',
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
    store.observationCheckpoints.save(checkpoint)
    expect(store.observationCheckpoints.get('s1')?.checkpoint).toEqual(checkpoint)

    const nextLease = store.observationCheckpoints.advanceGeneration('s1', 'codex', 'thread-1')
    expect(nextLease.observationGeneration).toBe(2)
    expect(nextLease.checkpoint).toEqual(checkpoint)
    expect(() => store.observationCheckpoints.save(checkpoint)).toThrow(
      'observation checkpoint lease changed',
    )
    store.sessions.purgeSession('s1')
    expect(store.observationCheckpoints.get('s1')).toBeNull()
  } finally {
    store.close()
  }
})
