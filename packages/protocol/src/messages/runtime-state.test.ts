import { describe, expect, it } from 'vitest'
import { parseControlMessage, parseDaemonMessage } from './codec.js'
import {
  ACCEPTED_TRANSITION_ID_WINDOW_SIZE,
  AgentObservationRebindAckMessage,
  AgentObservationRebindMessage,
  SessionObservationCheckpointV1,
} from './runtime-state.js'

const checkpoint = {
  schemaVersion: 1 as const,
  podiumSessionId: 'podium-1',
  provider: 'codex' as const,
  providerSessionId: 'thread-1',
  bindingVersion: 1,
  lifecycleObservationGeneration: 7,
  providerCursor: { segmentId: 'segment-1', components: { file: 20 } },
  bootstrapCursor: { segmentId: 'segment-1', components: { file: 10 } },
  lastAcceptedLiveCursor: { segmentId: 'segment-1', components: { file: 20 } },
  turnEpoch: 1,
  providerTurnId: null,
  providerPromptId: null,
  turnState: {
    phase: 'working' as const,
    since: '2026-07-18T12:00:00.000Z',
    workingMsTotal: 0,
    nativeSubagentCount: 0,
  },
  terminalFence: null,
  providerAt: '2026-07-18T12:00:00.000Z',
  acceptedAt: '2026-07-18T12:00:00.000Z',
  lastLiveReceiptAt: '2026-07-18T12:00:00.000Z',
  lastTransitionId: 'turn-1-open',
}

describe('SessionObservationCheckpointV1', () => {
  it('round-trips the bounded accepted transition history', () => {
    const value = { ...checkpoint, acceptedTransitionIds: ['turn-1-open', 'snapshot-10'] }
    expect(SessionObservationCheckpointV1.parse(JSON.parse(JSON.stringify(value)))).toEqual(value)
  })

  it('accepts legacy checkpoints without transition history', () => {
    expect(SessionObservationCheckpointV1.parse(checkpoint)).toEqual(checkpoint)
  })

  it('rejects transition histories beyond the durable bound', () => {
    expect(
      SessionObservationCheckpointV1.safeParse({
        ...checkpoint,
        acceptedTransitionIds: Array.from(
          { length: ACCEPTED_TRANSITION_ID_WINDOW_SIZE + 1 },
          (_, index) => `transition-${index}`,
        ),
      }).success,
    ).toBe(false)
  })
})

describe('causal observation wire compatibility', () => {
  it('accepts legacy spawn and reattach controls without checkpoints', () => {
    expect(
      parseControlMessage(
        JSON.stringify({
          type: 'spawn',
          sessionId: 'podium-1',
          agentKind: 'codex',
          cwd: '/repo',
          geometry: { cols: 80, rows: 24 },
        }),
      ),
    ).not.toHaveProperty('observationCheckpoint')
    expect(
      parseControlMessage(
        JSON.stringify({
          type: 'reattach',
          sessionId: 'podium-1',
          durableLabel: 'podium-podium-1',
          agentKind: 'codex',
          cwd: '/repo',
          geometry: { cols: 80, rows: 24 },
        }),
      ),
    ).not.toHaveProperty('observationCheckpoint')
  })

  it('round-trips exact rebind requests and acknowledgements', () => {
    const request = AgentObservationRebindMessage.parse({
      type: 'agentObservationRebind',
      sessionId: 'podium-1',
      provider: 'codex',
      providerSessionId: 'thread-1',
      observerGeneration: 7,
      bindingVersion: 2,
      nextProviderSessionId: 'thread-2',
      resumeKind: 'codex-thread',
      rebindId: 'rebind-1',
    })
    expect(parseDaemonMessage(JSON.stringify(request))).toEqual(request)
    const ack = AgentObservationRebindAckMessage.parse({
      type: 'agentObservationRebindAck',
      sessionId: 'podium-1',
      provider: 'codex',
      rebindId: 'rebind-1',
      priorObserverGeneration: 7,
      priorBindingVersion: 2,
      nextProviderSessionId: 'thread-2',
      providerSessionId: 'thread-2',
      result: 'accepted',
      observerGeneration: 8,
      bindingVersion: 3,
      checkpoint: null,
    })
    expect(parseControlMessage(JSON.stringify(ack))).toEqual(ack)
  })
})
