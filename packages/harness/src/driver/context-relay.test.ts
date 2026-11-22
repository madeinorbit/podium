import { asSessionId } from '@podium/model'
import type { ContextObservation } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionBinding } from './binding.js'
import { createContextPayloadBuffer, RuntimeContextRelay } from './context-relay.js'
import type { SessionMetadataObservation } from './events.js'
import {
  contextFixtureAt,
  contextFixtureCausal,
  installContextFixture,
} from './testing/context-fixture.js'

const releases: (() => void)[] = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
})
function fixture() {
  const adapter = installContextFixture()
  releases.push(adapter.release)
  let binding: SessionBinding = {
    sessionId: asSessionId('invented-context-session'),
    harness: 'fixture',
    driver: 'generic-pty',
    family: 'terminal',
    workdir: '/tmp/invented',
    resume: { kind: 'claude-session', value: 'invented-primary' },
    process: { key: 'invented-process' },
    bindingVersion: 1,
  }
  let generation = 1
  let seq = 1
  const emitted: SessionMetadataObservation[] = []
  const relay = new RuntimeContextRelay({
    binding: () => binding,
    causal: () => contextFixtureCausal(seq++, generation),
    emit: (event) => emitted.push(event),
  })
  return {
    ...adapter,
    relay,
    emitted,
    rebind: () => {
      binding = { ...binding, bindingVersion: 2 }
      generation = 2
    },
  }
}
const raw = (id = 'invented-sample', percent = 12) => ({
  id,
  percent,
  nativeSessionId: 'invented-primary',
})

describe('generic context relay', () => {
  it('keeps native identity, event time, cursor and atomic summary on coarse delivery and replay', async () => {
    const f = fixture()
    const causal = contextFixtureCausal(10)
    f.relay.observe(raw(), causal)
    expect(f.emitted).toHaveLength(1)
    expect(f.emitted[0]).toMatchObject({
      ...causal,
      t: 'metadata',
      change: {
        kind: 'context-observation',
        context: {
          status: 'available',
          sample: {
            id: 'invented-sample',
            at: contextFixtureAt,
            nativeSessionId: 'invented-primary',
          },
          model: { modelId: 'invented-native-model' },
        },
      },
    })
    expect(await f.relay.replay()).toEqual({
      ...causal,
      context:
        f.emitted[0]?.change.kind === 'context-observation'
          ? f.emitted[0].change.context
          : undefined,
    })
  })
  it('replays opaque native frames received before binding with their original source time', () => {
    const f = fixture()
    let sourceAt = contextFixtureAt
    const buffer = createContextPayloadBuffer(() => sourceAt)
    buffer.push(raw('native-resume-replay'))
    sourceAt = '2026-11-22T12:00:00.000Z'
    buffer.bind((payload, source) =>
      f.relay.observe(payload, { ...contextFixtureCausal(10), ...source }),
    )
    expect(f.relay.snapshot()).toMatchObject({
      at: contextFixtureAt,
      provenance: 'bootstrap',
      context: {
        status: 'available',
        sample: { id: 'native-resume-replay', at: contextFixtureAt },
      },
    })
    const delivered = f.emitted.length
    buffer.bind(() => {
      throw new Error('Already drained native replay was repeated')
    })
    expect(f.emitted).toHaveLength(delivered)
  })
  it('rejects duplicate, reordered, child and obsolete-generation publications', () => {
    const f = fixture()
    f.relay.observe(raw('newer'), contextFixtureCausal(20))
    const current = f.relay.snapshot() as ContextObservation
    f.relay.observe(raw('older'), contextFixtureCausal(10))
    f.relay.observe(raw('newer', 99), contextFixtureCausal(30))
    f.relay.observe(
      { ...raw('child'), nativeSessionId: 'invented-child' },
      contextFixtureCausal(40),
    )
    f.bindings[0]?.publish({ ...current, observerGeneration: 2 })
    expect(f.relay.snapshot()).toEqual(current)
    expect(f.emitted).toHaveLength(1)
  })
  it('admits immutable enrichment on the same native cursor through an advancing context revision', () => {
    const f = fixture()
    f.relay.observe(raw('count-only'), contextFixtureCausal(10))
    const prior = f.relay.snapshot() as ContextObservation
    if (prior.context.status !== 'available') throw new Error('No invented native sample')
    f.bindings[0]?.publish({
      ...prior,
      context: {
        ...prior.context,
        sample: {
          ...prior.context.sample,
          id: 'capacity-enriched',
          contextRevision: prior.context.sample.contextRevision + 1,
        },
      },
    })
    expect(f.relay.snapshot()?.context).toMatchObject({
      sample: { id: 'capacity-enriched', contextRevision: 2 },
    })
    f.bindings[0]?.publish({ ...prior, cursor: contextFixtureCausal(100).cursor })
    expect(f.relay.snapshot()?.context).toMatchObject({ sample: { id: 'capacity-enriched' } })
  })
  it.each([
    'compaction',
    'reset',
    'rewind',
    'fork',
    'model-changed',
    'resume',
  ] as const)('clears at %s and rejects a late pre-boundary sample', (cause) => {
    const f = fixture()
    f.relay.observe(raw(), contextFixtureCausal(10))
    const prior = f.relay.snapshot() as ContextObservation
    f.relay.invalidate(cause, contextFixtureCausal(20))
    f.bindings[0]?.publish({ ...prior, cursor: contextFixtureCausal(100).cursor })
    expect(f.relay.snapshot()?.context).toMatchObject({
      status: 'pending',
      invalidation: { cause },
      revision: { contextRevision: 2 },
    })
    f.relay.observe(raw('post-boundary'), contextFixtureCausal(21))
    expect(f.relay.snapshot()?.context).toMatchObject({
      status: 'available',
      sample: { id: 'post-boundary', contextRevision: 2 },
    })
  })
  it('retains idle readings and legacy/requested model labels until an adapter-native transition, and aborts old binding publication', () => {
    const f = fixture()
    f.relay.observe(raw(), contextFixtureCausal(10))
    f.relay.event({ ...contextFixtureCausal(11), t: 'state', change: { kind: 'turn_completed' } })
    expect(f.relay.snapshot()?.context.status).toBe('available')
    f.relay.event({
      ...contextFixtureCausal(12),
      t: 'metadata',
      change: { kind: 'model', model: 'different-native-model', source: 'native' },
    })
    expect(f.relay.snapshot()?.context.status).toBe('available')
    f.relay.event({
      ...contextFixtureCausal(13),
      t: 'metadata',
      change: { kind: 'model', model: 'invented-provider/invented-native-model', source: 'native' },
    })
    expect(f.relay.snapshot()?.context).toMatchObject({
      status: 'available',
      model: { modelId: 'invented-native-model' },
    })
    f.relay.observe({ boundary: 'model-changed' }, contextFixtureCausal(14))
    expect(f.relay.snapshot()?.context.status).toBe('pending')
    const priorBinding = f.bindings[0]
    f.rebind()
    expect(f.relay.snapshot()?.context).toMatchObject({
      status: 'pending',
      revision: { bindingVersion: 2, observerGeneration: 2 },
    })
    expect(priorBinding?.signal.aborted).toBe(true)
    f.relay.observe(raw('new-binding'), contextFixtureCausal(20, 2))
    const current = f.relay.snapshot() as ContextObservation
    priorBinding?.publish({
      ...current,
      context: {
        version: 1,
        status: 'unsupported',
        reason: { code: 'late', message: 'Late old binding' },
      },
    })
    expect(f.relay.snapshot()).toEqual(current)
  })
  it('keeps a valid asynchronous post-compaction estimate through generic start/end notifications', async () => {
    const f = fixture()
    f.relay.observe(raw('pre-compaction'), contextFixtureCausal(10))
    const prior = f.relay.snapshot() as ContextObservation
    if (prior.context.status !== 'available') throw new Error('No invented native sample')
    const previousSummary = prior.context
    f.relay.observe({ boundary: 'compaction' }, contextFixtureCausal(11))
    f.relay.event({
      ...contextFixtureCausal(12),
      t: 'state',
      change: { kind: 'compaction', phase: 'start' },
    })
    await Promise.resolve().then(() =>
      f.bindings[0]?.publish({
        ...contextFixtureCausal(13),
        context: {
          ...previousSummary,
          sample: { ...previousSummary.sample, id: 'post-compaction-estimate', contextRevision: 2 },
        },
      }),
    )
    const end = {
      ...contextFixtureCausal(14),
      t: 'state' as const,
      change: { kind: 'compaction' as const, phase: 'end' as const },
    }
    f.relay.event(end)
    f.relay.event(end)
    f.bindings[0]?.publish({ ...prior, cursor: contextFixtureCausal(100).cursor })
    expect(f.relay.snapshot()?.context).toMatchObject({
      status: 'available',
      sample: { id: 'post-compaction-estimate', contextRevision: 2 },
    })
  })
  it('retains and restores the same immutable sample on same-cursor observation loss', async () => {
    const f = fixture()
    const causal = contextFixtureCausal(10)
    f.relay.observe(raw(), causal)
    const original = f.relay.snapshot()
    f.relay.lost(causal)
    expect(f.relay.snapshot()?.context).toMatchObject({
      status: 'stale',
      sample: { id: 'invented-sample', at: contextFixtureAt },
    })
    f.relay.lost(causal)
    expect(f.emitted).toHaveLength(2)
    await f.relay.reader.summary({ timeoutMs: 100 })
    expect(f.relay.snapshot()).toEqual(original)
    expect(f.emitted).toHaveLength(3)
  })
  it.each([
    'older-turn',
    'older-cursor',
  ] as const)('rejects a same-revision %s while cleared, and permits native release at the clear cursor', (late) => {
    const f = fixture()
    f.relay.observe(raw('before-clear'), contextFixtureCausal(10))
    const original = f.relay.snapshot() as ContextObservation
    if (original.context.status !== 'available') throw new Error('No invented native sample')
    const originalSummary = original.context
    const clear = { ...contextFixtureCausal(20), turnEpoch: 2 }
    f.relay.invalidate('reset', clear)
    const pending = f.relay.snapshot() as ContextObservation
    const sample = (seq: number, turnEpoch: number, id: string): ContextObservation => ({
      ...contextFixtureCausal(seq),
      turnEpoch,
      context: {
        ...originalSummary,
        status: 'available',
        sample: {
          ...originalSummary.sample,
          contextRevision: 2,
          turnEpoch,
          id,
        },
      },
    })
    f.bindings[0]?.publish(
      sample(late === 'older-cursor' ? 19 : 30, late === 'older-turn' ? 1 : 2, late),
    )
    expect(f.relay.snapshot()).toEqual(pending)
    const released = sample(20, 2, 'native-release')
    f.bindings[0]?.publish(released)
    expect(f.relay.snapshot()).toEqual(released)
    if (pending.context.status !== 'pending') throw new Error('No invented boundary')
    f.bindings[0]?.publish({
      ...contextFixtureCausal(40),
      turnEpoch: 1,
      context: { ...pending.context, revision: { ...pending.context.revision, turnEpoch: 1 } },
    })
    expect(f.relay.snapshot()).toEqual(released)
  })
  it.each([
    'resume',
    'binding-changed',
  ] as const)('allows the adapter to recover a prior attributable sample after %s without restamping', (cause) => {
    const f = fixture()
    f.relay.observe(raw('prior-native-sample'), contextFixtureCausal(10))
    const original = f.relay.snapshot() as ContextObservation
    if (original.context.status !== 'available') throw new Error('No invented native sample')
    f.relay.invalidate(cause, { ...contextFixtureCausal(20), turnEpoch: 2 })
    const recovered: ContextObservation = {
      ...original,
      context: {
        ...original.context,
        sample: { ...original.context.sample, contextRevision: 2 },
      },
    }
    f.bindings[0]?.publish(recovered)
    expect(f.relay.snapshot()).toEqual(recovered)
  })
  it('does not let a telemetry decoder failure interrupt native protocol delivery', () => {
    const f = fixture()
    f.relay.observe(raw(), contextFixtureCausal(10))
    expect(() => f.relay.observe({ crash: true }, contextFixtureCausal(11))).not.toThrow()
    expect(f.relay.snapshot()?.context).toMatchObject({
      status: 'stale',
      sample: { id: 'invented-sample' },
    })
  })
  it('bounds a stuck native probe without acquiring a process', async () => {
    vi.useFakeTimers()
    const adapter = installContextFixture()
    releases.push(adapter.release)
    const request = vi.fn(() => new Promise<unknown>(() => {}))
    const relay = new RuntimeContextRelay({
      binding: () => ({
        sessionId: asSessionId('bounded'),
        harness: 'fixture',
        driver: 'generic-pty',
        family: 'terminal',
        workdir: '/tmp/invented',
        resume: null,
        process: { key: 'bounded' },
        bindingVersion: 1,
      }),
      causal: () => contextFixtureCausal(1),
      probe: { request },
      emit: vi.fn(),
    })
    try {
      const read = relay.reader.summary({ timeoutMs: 25 })
      await vi.advanceTimersByTimeAsync(25)
      expect(await read).toMatchObject({ status: 'refused' })
      expect(request).toHaveBeenCalledOnce()
    } finally {
      relay.dispose()
      vi.useRealTimers()
    }
  })
})
