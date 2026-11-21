import { type ContextSummary, ContextSummary as ModelContextSummary } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { SessionConditionPayload } from '../planes/topics'
import {
  CAP_CONTEXT_OBSERVATION_V1,
  ContextDetailRequest,
  ContextDetailResult,
  ContextObservation,
  ContextSummaryReadResult,
  isDurableRuntimeEvent,
  RuntimeEvent,
  SessionSnapshot,
} from './runtime'

const sample = {
  id: 'native-sample-1',
  at: '2026-11-21T12:00:00.000Z',
  bindingVersion: 1,
  observerGeneration: 2,
  contextRevision: 3,
  turnEpoch: 4,
  nativeSessionId: 'primary-session',
}
const summary: ContextSummary = {
  version: 1,
  status: 'available',
  sample,
  model: { modelId: 'synthetic-model', providerId: 'synthetic-provider' },
  occupancy: {
    basis: 'last-request',
    usedTokens: { value: 13_000, accuracy: 'estimated', source: 'latest main request' },
  },
  effectiveCapacity: {
    value: 32_000,
    accuracy: 'reported',
    source: 'scoped configuration',
    basis: 'configured',
  },
}
const observation = {
  at: sample.at,
  observerGeneration: sample.observerGeneration,
  turnEpoch: sample.turnEpoch,
  provenance: 'live',
  cursor: { segmentId: 'segment-1', components: { seq: 6 } },
  context: summary,
}
const roundTrip = <T>(schema: z.ZodType<T>, value: unknown): T =>
  schema.parse(JSON.parse(JSON.stringify(value)))

describe('context wire vocabulary', () => {
  it('carries normalized observations and clears on retained coarse metadata', () => {
    const { context, ...causal } = observation
    const event = { ...causal, t: 'metadata', change: { kind: 'context-observation', context } }
    const parsed = roundTrip(RuntimeEvent, event)
    expect(parsed).toEqual(event)
    expect(isDurableRuntimeEvent(parsed)).toBe(true)
    expect(RuntimeEvent.safeParse({ ...event, observerGeneration: 99 }).success).toBe(false)
  })
  it('uses the model schema without changing partial observations or native identity', () => {
    expect(roundTrip(ContextObservation, observation)).toEqual(observation)
    expect(ModelContextSummary.parse(ContextObservation.parse(observation).context)).toEqual(
      summary,
    )
    expect(
      SessionConditionPayload.parse({ busy: false, requestsGated: 0, context: summary }).context,
    ).toEqual(summary)
    expect(CAP_CONTEXT_OBSERVATION_V1).toBe('context.observation.v1')
  })
  it('rejects samples from a different observer or turn while accepting stale retained samples', () => {
    expect(ContextObservation.safeParse({ ...observation, observerGeneration: 3 }).success).toBe(
      false,
    )
    expect(ContextObservation.safeParse({ ...observation, turnEpoch: 5 }).success).toBe(false)
    const stale = {
      ...summary,
      status: 'stale',
      reason: { code: 'offline', message: 'Native observer disconnected' },
    }
    expect(
      ContextObservation.safeParse({ ...observation, observerGeneration: 3, context: stale })
        .success,
    ).toBe(true)
    expect(
      roundTrip(ContextObservation, { ...observation, provenance: 'bootstrap' }),
    ).toHaveProperty('context.sample.at', sample.at)
  })
  it('round-trips explicit clears and refuses inconsistent clear generations', () => {
    const context = {
      version: 1,
      status: 'pending',
      revision: { bindingVersion: 1, observerGeneration: 2, contextRevision: 4, turnEpoch: 4 },
      reason: { code: 'compaction', message: 'Waiting for a valid post-compaction sample' },
      invalidation: { cause: 'compaction', previousSample: sample },
    }
    expect(roundTrip(ContextObservation, { ...observation, context })).toHaveProperty(
      'context.invalidation.previousSample.id',
      sample.id,
    )
    expect(
      ContextObservation.safeParse({ ...observation, context, observerGeneration: 3 }).success,
    ).toBe(false)
  })
  it('round-trips a snapshot with the original context envelope and accepts an old absent field', () => {
    const snapshot = {
      binding: {
        sessionId: 'sess_context_wire',
        driver: 'fake',
        family: 'server',
        harness: 'synthetic',
        workdir: '/work',
        resume: null,
        process: { key: 'synthetic-process' },
        bindingVersion: 1,
      },
      state: { phase: 'idle' },
      cursor: observation.cursor,
      observerGeneration: 2,
      turnEpoch: 4,
      interactions: [],
      at: sample.at,
      context: observation,
    }
    expect(roundTrip(SessionSnapshot, snapshot)).toEqual(snapshot)
    const { context: _context, ...old } = snapshot
    expect(SessionSnapshot.parse(old)).not.toHaveProperty('context')
    expect(SessionSnapshot.omit({ context: true }).parse(snapshot)).toEqual(old)
  })
  it('bounds detail requests, omits local cancellation signals and retains requested sample on refusal', () => {
    expect(roundTrip(ContextDetailRequest, { sample, timeoutMs: 2000, maxRows: 16 })).toEqual({
      sample,
      timeoutMs: 2000,
      maxRows: 16,
    })
    expect(ContextDetailRequest.safeParse({ sample, timeoutMs: 0, maxRows: 16 }).success).toBe(
      false,
    )
    expect(ContextDetailRequest.safeParse({ sample, timeoutMs: 2000, maxRows: 129 }).success).toBe(
      false,
    )
    expect(ContextDetailRequest.safeParse({ sample, timeoutMs: 60_001, maxRows: 1 }).success).toBe(
      false,
    )
    for (const status of ['cancelled', 'refused', 'superseded', 'unavailable', 'unsupported']) {
      const result = {
        version: 1,
        sample,
        status,
        reason: { code: status, message: 'The requested sample cannot be described' },
      }
      expect(roundTrip(ContextDetailResult, result)).toEqual(result)
    }
    expect(
      roundTrip(ContextSummaryReadResult, { status: 'observation', observation }),
    ).toHaveProperty('observation.context.sample.id', sample.id)
  })
  it('allows additive unknown native-neutral fields but refuses incompatible versions', () => {
    expect(
      roundTrip(ContextObservation, { ...observation, context: { ...summary, futureNote: true } }),
    ).toEqual(observation)
    expect(
      ContextObservation.safeParse({ ...observation, context: { ...summary, version: 2 } }).success,
    ).toBe(false)
    expect(ContextDetailResult.safeParse({ version: 1, sample, status: 'available' }).success).toBe(
      false,
    )
  })
})
