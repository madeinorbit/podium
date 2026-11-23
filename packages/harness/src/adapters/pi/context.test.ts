import { ContextDetailResult, ContextSummary } from '@podium/model'
import type { CausalEnvelope } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { ContextObservation } from '../../context-types.js'
import type { AcceptedDriverId } from '../../manifest.js'
import fixtures from './__fixtures__/context-observations.json' with { type: 'json' }
import { piContext } from './context.js'
import { piRequestAccounting } from './context-native.js'
import { piManifest } from './index.js'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing Pi fixture/result')
  return value
}
const terminal = fixtures.terminal as Record<string, unknown>[]
const first = required(terminal.find((row) => row.event === 'turn_end'))
const firstStart = required(
  terminal.find(
    (row) =>
      row.event === 'message_start' && (row.message as { role?: string })?.role === 'assistant',
  ),
)
const sessionId = String(first.sessionId)
function causal(sequence: number): CausalEnvelope {
  return {
    at: new Date(
      Number((firstStart.message as { timestamp: number }).timestamp) - 100 + sequence,
    ).toISOString(),
    cursor: { segmentId: 'pi-test', components: { seq: sequence } },
    provenance: 'live',
    observerGeneration: 1,
    turnEpoch: 0,
  }
}
function bind(
  driver: AcceptedDriverId = 'generic-pty',
  nativeSessionId = sessionId,
  at = Number((firstStart.message as { timestamp: number }).timestamp) - 200,
) {
  const declaration = piContext.forDriver(driver)
  if (!declaration.supported) throw new Error(declaration.reason)
  const lifetime = new AbortController()
  const publish = vi.fn()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at)
  let bound: ReturnType<typeof declaration.value.bind>
  try {
    bound = declaration.value.bind({
      harness: 'pi',
      driver,
      nativeSessionId,
      revision: { bindingVersion: 1, observerGeneration: 1, contextRevision: 0, turnEpoch: 0 },
      signal: lifetime.signal,
      publish,
    })
  } finally {
    clock.mockRestore()
  }
  return {
    lifetime,
    publish,
    bound,
  }
}
function harness() {
  const binding = bind()
  let sequence = 0
  const send = (row: Record<string, unknown>) => {
    const envelope = causal(++sequence)
    const result = binding.bound.observe({ ...row, sequence, at: envelope.at }, envelope)
    if (result) ContextSummary.parse(result.context)
    return result
  }
  send(required(terminal[0]))
  const ready = () => {
    send(firstStart)
    return required(send(first))
  }
  return { ...binding, send, ready }
}
function sample(observation: ContextObservation) {
  if (observation.context.status !== 'available') throw new Error(observation.context.status)
  return observation.context.sample
}

describe('Pi native context strategy', () => {
  it('replays native occupancy decreases, trailing input, model and compaction boundaries', async () => {
    const { bound } = bind()
    const observed: ContextObservation[] = []
    for (const row of terminal) {
      const result = bound.observe(row, { ...causal(Number(row.sequence)), at: String(row.at) })
      if (result) {
        ContextSummary.parse(result.context)
        observed.push(result)
      }
    }
    const counts = observed.flatMap(({ context: s }) =>
      s.status === 'available' ? [s.occupancy.usedTokens?.value] : [],
    )
    expect(counts).toEqual([1320, 1363, 790, 460])
    const available = observed.filter((row) => row.context.status === 'available')
    expect(available[0]?.context).toMatchObject({
      model: { providerId: 'probe7397', modelId: 'cedar-a' },
      effectiveCapacity: { value: 16000, basis: 'native' },
      occupancy: {
        basis: 'native-estimate',
        usedTokens: { value: 1320, accuracy: 'estimated' },
        percent: { value: 8.25, accuracy: 'estimated' },
        remainingTokens: { value: 14680, accuracy: 'estimated' },
      },
    })
    expect(
      observed.some(
        ({ context: s }) =>
          s.status === 'pending' &&
          s.model?.modelId === 'cedar-b' &&
          s.effectiveCapacity?.value === 32000,
      ),
    ).toBe(true)
    const last = required(available.at(-1))
    expect(last.context).toMatchObject({
      model: { providerId: 'probe7397', modelId: 'cedar-b' },
      occupancy: { usedTokens: { value: 460 } },
    })
    const detail = await bound.detail({ sample: sample(last), timeoutMs: 100, maxRows: 5 })
    expect(ContextDetailResult.parse(detail)).toMatchObject({
      status: 'available',
      lastRequest: {
        input: { value: 400 },
        output: { value: 60 },
        cacheRead: { value: 80 },
        reasoning: { value: 20 },
      },
    })
  })

  it('keeps inclusive request input/cache and output/reasoning separate from occupancy and lifetime totals', async () => {
    const h = harness()
    const value = h.ready()
    const detail = await h.bound.detail({ sample: sample(value), timeoutMs: 100, maxRows: 1 })
    expect(detail).toMatchObject({
      status: 'available',
      lastRequest: {
        input: { value: 1200 },
        output: { value: 120 },
        cacheRead: { value: 300 },
        cacheWrite: { value: 0 },
        reasoning: { value: 40 },
        model: { modelId: 'cedar-a', providerId: 'probe7397' },
      },
    })
    expect(
      h.send({ type: 'get_session_stats', tokens: { total: 2110 }, usage: { totalTokens: 2110 } }),
    ).toBeUndefined()
    expect(await h.bound.summary({ timeoutMs: 10 })).toEqual({
      status: 'observation',
      observation: value,
    })
    expect(h.publish).not.toHaveBeenCalled()
  })

  it('keeps the captured changed-model print resume pending until its new compatible response', () => {
    const { bound } = bind('headless')
    const available: ContextObservation[] = []
    for (const row of fixtures.resume) {
      const result = bound.observe(row, { ...causal(row.sequence), at: row.at })
      if (result?.context.status === 'available') available.push(result)
      else if (result) expect(result.context.status).toBe('pending')
    }
    expect(available).toHaveLength(1)
    expect(available[0]?.context).toMatchObject({
      status: 'available',
      model: { modelId: 'cedar-a', providerId: 'probe7397' },
      effectiveCapacity: { value: 16000 },
      occupancy: { usedTokens: { value: 460 } },
    })
  })

  it('does not use pre-persistence message_end or an old post-compaction anchor', () => {
    const h = harness()
    h.send(firstStart)
    expect(h.send({ ...first, event: 'message_end', anchor: undefined })?.context.status).toBe(
      'pending',
    )
    const valid = required(h.send(first))
    expect(valid.context.status).toBe('available')
    h.send({
      ...first,
      event: 'session_compact',
      compactionId: 'new-compact',
      contextUsage: { tokens: null, percent: null, contextWindow: 16000 },
    })
    expect(h.send({ ...first, compactionId: 'new-compact' })?.context.status).toBe('pending')
    h.send({
      ...firstStart,
      compactionId: 'new-compact',
      message: {
        ...(firstStart.message as object),
        timestamp: Number((firstStart.message as { timestamp: number }).timestamp) + 1000,
      },
    })
    expect(
      h.send({
        ...first,
        compactionId: 'new-compact',
        anchor: {
          ...(first.anchor as object),
          id: 'post-compact',
          timestamp: Number((firstStart.message as { timestamp: number }).timestamp) + 1000,
        },
      })?.context.status,
    ).toBe('available')
  })

  it('does not relabel the old model count, even with a newly reported window', () => {
    const h = harness()
    h.ready()
    const switched = {
      ...first,
      event: 'model_select',
      model: { id: 'cedar-b', provider: 'probe7397' },
      contextUsage: { tokens: 1320, percent: 4.125, contextWindow: 32000 },
    }
    expect(h.send(switched)?.context).toMatchObject({
      status: 'pending',
      model: { modelId: 'cedar-b' },
      effectiveCapacity: { value: 32000 },
    })
    expect(h.send({ ...switched, event: 'agent_settled' })?.context.status).toBe('pending')
  })

  it('retains an idle quit sample but clears shutdown for a session replacement', async () => {
    const h = harness()
    const value = h.ready()
    expect(h.send({ ...first, event: 'session_shutdown', reason: 'quit' })).toBeUndefined()
    expect(await h.bound.summary({ timeoutMs: 10 })).toEqual({
      status: 'observation',
      observation: value,
    })
    expect(h.send({ ...first, event: 'session_shutdown', reason: 'fork' })?.context).toMatchObject({
      status: 'pending',
      invalidation: { cause: 'fork' },
    })
  })

  it('also fences a capacity change under the same native model identity', () => {
    const h = harness()
    h.ready()
    expect(
      h.send({ ...first, contextUsage: { tokens: 1320, percent: 4.125, contextWindow: 32000 } })
        ?.context,
    ).toMatchObject({
      status: 'pending',
      invalidation: { cause: 'model-changed' },
      effectiveCapacity: { value: 32000 },
    })
  })

  it('requires a new response on startup resume, fork, rewind and rebind', async () => {
    for (const event of [
      'session_start',
      'session_before_fork',
      'session_before_tree',
      'session_tree',
    ]) {
      const h = harness()
      const old = h.ready()
      const boundary = required(h.send({ ...first, event, reason: 'startup' }))
      expect(boundary.context.status).toBe('pending')
      expect(h.send(first)?.context.status).toBe('pending')
      expect(
        await h.bound.detail({ sample: sample(old), timeoutMs: 10, maxRows: 1 }),
      ).toMatchObject({ status: 'superseded' })
    }
    const h = harness()
    h.ready()
    const clear = h.bound.invalidate('binding-changed', causal(50))
    expect(clear.context.status).toBe('pending')
    expect(h.send(first)).toBeUndefined()
    const other = bind()
    expect(other.bound.observe(first, causal(50))).toBeUndefined()
  })

  it('rejects duplicate, late, child, old-generation and replay payloads', async () => {
    const h = harness()
    const firstValue = h.ready()
    expect(h.send(first)).toBeUndefined()
    expect(h.bound.observe({ ...first, sequence: 1 }, causal(20))).toBeUndefined()
    expect(h.send({ ...first, sessionId: 'child' })).toBeUndefined()
    expect(
      h.bound.observe({ ...first, sequence: 99 }, { ...causal(20), observerGeneration: 2 }),
    ).toBeUndefined()
    expect(
      h.bound.observe({ ...first, sequence: 99 }, { ...causal(20), provenance: 'replay' }),
    ).toBeUndefined()
    expect(await h.bound.summary({ timeoutMs: 10 })).toEqual({
      status: 'observation',
      observation: firstValue,
    })
  })

  it('retires the preceding extension run and cannot resurrect a resumed historical response', () => {
    const h = harness()
    h.ready()
    expect(
      h.send({ ...first, runId: 'new-print-process', event: 'session_start', reason: 'startup' })
        ?.context.status,
    ).toBe('pending')
    expect(h.send(first)).toBeUndefined()
    expect(h.send({ ...first, runId: 'new-print-process' })?.context.status).toBe('pending')
  })

  it('cannot admit a delayed start whose native request predates an external boundary', () => {
    const h = harness()
    h.ready()
    h.bound.invalidate('reset', causal(500))
    expect(h.send(firstStart)).toBeUndefined()
    expect(h.send(first)).toBeUndefined()
  })

  it('recovers a late bind from a live request start without trusting a historical idle snapshot', () => {
    const { bound } = bind()
    expect(bound.observe(first, causal(1))).toBeUndefined()
    const timestamp = Number((firstStart.message as { timestamp: number }).timestamp)
    bound.observe({ ...firstStart, at: new Date(timestamp + 1).toISOString() }, causal(2))
    const result = bound.observe({ ...first, at: new Date(timestamp + 2).toISOString() }, causal(3))
    expect(result?.context.status).toBe('available')
  })

  it('rejects a previous writer callback even when delivered with the new binding generation', () => {
    const { bound } = bind(
      'generic-pty',
      sessionId,
      Number((firstStart.message as { timestamp: number }).timestamp) + 1000,
    )
    expect(bound.observe(firstStart, causal(1))).toBeUndefined()
    expect(bound.observe(first, causal(2))).toBeUndefined()
  })

  it('distinguishes native null, missing and estimated zero; retains over-capacity percentages', () => {
    const h = harness()
    h.ready()
    expect(
      h.send({ ...first, contextUsage: { tokens: null, percent: null, contextWindow: 16000 } })
        ?.context.status,
    ).toBe('pending')
    expect(h.send({ ...first, contextUsage: { contextWindow: 16000 } })?.context.status).toBe(
      'unavailable',
    )
    h.send(firstStart)
    expect(
      h.send({ ...first, contextUsage: { tokens: 0, percent: 0, contextWindow: 16000 } })?.context,
    ).toMatchObject({
      status: 'available',
      occupancy: { usedTokens: { value: 0, accuracy: 'estimated' }, percent: { value: 0 } },
    })
    expect(
      h.send({ ...first, contextUsage: { tokens: 20000, percent: 125, contextWindow: 16000 } })
        ?.context,
    ).toMatchObject({
      status: 'available',
      occupancy: {
        usedTokens: { value: 20000 },
        percent: { value: 125 },
        remainingTokens: { value: 0 },
      },
    })
  })

  it.each([
    undefined,
    -1,
    Infinity,
    NaN,
    '1320',
  ])('rejects malformed native token value %s', (tokens) => {
    const h = harness()
    h.ready()
    expect(
      h.send({ ...first, contextUsage: { tokens, percent: 8.25, contextWindow: 16000 } })?.context
        .status,
    ).toBe('unavailable')
  })

  it.each([
    undefined,
    0,
    -1,
    Infinity,
  ])('rejects unavailable/nonpositive native window %s', (contextWindow) => {
    const h = harness()
    h.ready()
    expect(
      h.send({ ...first, contextUsage: { tokens: 1320, percent: 8.25, contextWindow } })?.context
        .status,
    ).toBe('unavailable')
  })

  it.each(fixtures.unverified)('declines unmeasured version %s', (piVersion) => {
    const h = harness()
    expect(h.send({ ...first, piVersion })?.context).toMatchObject({
      status: 'unavailable',
      reason: { code: 'unverified-native-version' },
    })
  })

  it('is passive and bounded, with no IO, listener or process on bind/read/dispose', async () => {
    const h = harness()
    const value = h.ready()
    expect(await h.bound.detail({ sample: sample(value), timeoutMs: 0, maxRows: 1 })).toMatchObject(
      { status: 'refused' },
    )
    expect(
      await h.bound.detail({ sample: sample(value), timeoutMs: 10, maxRows: 129 }),
    ).toMatchObject({ status: 'refused' })
    expect(await h.bound.summary({ timeoutMs: 60_001 })).toMatchObject({ status: 'refused' })
    h.lifetime.abort()
    expect(h.send(first)).toBeUndefined()
    expect(await h.bound.summary({ timeoutMs: 10 })).toMatchObject({ status: 'cancelled' })
    expect(
      await h.bound.detail({ sample: sample(value), timeoutMs: 10, maxRows: 1 }),
    ).toMatchObject({ status: 'cancelled' })
    expect(h.publish).not.toHaveBeenCalled()
  })
})

describe('Pi constrained print context', () => {
  it('uses one live assistant request as a partial estimate, without a model limit', () => {
    const header = required(fixtures.restrictedStream[0])
    const { bound } = bind('headless', String('id' in header ? header.id : ''))
    const results = fixtures.restrictedStream
      .map((raw, i) => bound.observe(raw, causal(i + 1)))
      .filter(Boolean)
    const last = required(results.at(-1))
    expect(ContextSummary.parse(last.context)).toMatchObject({
      status: 'available',
      model: { modelId: 'cedar-a' },
      occupancy: { basis: 'last-request', usedTokens: { value: 460, accuracy: 'estimated' } },
    })
    expect(last.context).not.toHaveProperty('effectiveCapacity')
    expect(last.context).not.toHaveProperty('occupancy.percent')
  })
  it('does not read persisted session totals or accept a stream without its primary header', () => {
    const { bound } = bind('headless')
    expect(bound.observe({ type: 'message_end', message: first.anchor }, causal(1))).toBeUndefined()
    expect(bound.observe({ type: 'session', id: 'child' }, causal(2))).toBeUndefined()
    expect(
      bound.observe({ type: 'session_stats', tokens: { total: 2110 } }, causal(3)),
    ).toBeUndefined()
  })
  it('preserves the existing no-extensions policy and declines RPC/server', () => {
    if (!piManifest.headless.supported || !piManifest.headless.value.buildExec.supported)
      throw new Error('missing print')
    const args = piManifest.headless.value.buildExec.value({
      prompt: 'invented',
      toolPolicy: 'none',
    }).args
    expect(args).toContain('--no-extensions')
    expect(args).not.toContain('-e')
    expect(piManifest.runtime.server.supported).toBe(false)
    expect(piContext.forDriver('codex-app-server').supported).toBe(false)
  })
})

describe('Pi request accounting validation', () => {
  it('keeps partial counters unknown and validates reasoning/output subsets', () => {
    expect(piRequestAccounting({ usage: { input: 10, output: 3 } })).toEqual({
      output: {
        value: 3,
        accuracy: 'reported',
        source: 'pi assistant usage.output',
      },
    })
    expect(
      piRequestAccounting({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    ).toMatchObject({ input: { value: 0 }, output: { value: 0 } })
    expect(piRequestAccounting({ usage: { output: 3, reasoning: 4 } })).toBeUndefined()
    expect(piRequestAccounting({ usage: { output: -1 } })).toBeUndefined()
    expect(piRequestAccounting({ usage: { totalTokens: 2110 } })).toBeUndefined()
    expect(
      piRequestAccounting({ usage: { input: 50, cacheRead: 30, cacheWrite: 20, output: 10 } }),
    ).toMatchObject({ input: { value: 100 }, cacheWrite: { value: 20 }, output: { value: 10 } })
  })
})
