import { ContextDetailResult, ContextSummary } from '@podium/model'
import {
  type CausalEnvelope,
  ContextObservation as ContextObservationSchema,
} from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type {
  ContextObservation,
  ContextSessionStrategy,
  ContextStrategyInput,
} from '../../context-types.js'
import { opencodeContext } from './context.js'
import { effectiveCapacity, record, requestUsage, scopedPath } from './context-native.js'
import previewData from './fixtures/context-0.0.0-beta-18866.json'
import stableData from './fixtures/context-1.18.35.json'

type Fixture = {
  build: string
  sessionID: string
  sessions: Record<string, unknown>
  metadata: unknown
  configuration: unknown
  messages: Record<string, unknown>
  events: unknown[]
  store: unknown
}
const fixtures: [string, Fixture][] = [
  ['opencode-server', stableData],
  ['opencode2-server', previewData],
]
const revision = { bindingVersion: 4, observerGeneration: 2, contextRevision: 3, turnEpoch: 0 }
const modelA = { id: 'context-a', providerID: 'audit', variant: 'default' }
const modelB = { id: 'context-b', providerID: 'audit', variant: 'default' }
const scope = { directory: '<scratch>/work' }

function setup(
  driver: string,
  fixture: Fixture,
  probe?: ContextStrategyInput['probe'],
  nativeSessionId = fixture.sessionID,
) {
  const declaration = opencodeContext.forDriver(driver as 'opencode-server')
  if (!declaration.supported) throw new Error(declaration.reason)
  const lifetime = new AbortController()
  const published: ContextObservation[] = []
  const requests: string[] = []
  const request = vi.fn(async (path: unknown) => {
    requests.push(String(path))
    if (String(path).startsWith('/config/providers') || String(path).startsWith('/api/model'))
      return fixture.metadata
    if (String(path).startsWith('/api/config')) return fixture.configuration
    return fixture.sessions.two
  })
  const bound = declaration.value.bind({
    harness: 'opencode',
    driver: driver as 'opencode-server',
    nativeSessionId,
    revision,
    signal: lifetime.signal,
    probe: probe ?? { request },
    publish: (observation) => {
      ContextObservationSchema.parse(observation)
      published.push(observation)
    },
  })
  let seq = 0
  let ms = 1
  const causal = (at?: number): CausalEnvelope => {
    ms = Math.max(ms, at ?? ms + 1)
    return {
      at: new Date(ms).toISOString(),
      provenance: 'live',
      observerGeneration: revision.observerGeneration,
      turnEpoch: revision.turnEpoch,
      cursor: { segmentId: 'owned-native', components: { seq: ++seq } },
    }
  }
  const observe = (payload: unknown, envelope?: CausalEnvelope) => {
    const raw = record(payload)
    const data = record(raw?.properties)
    const info = record(data?.info)
    const time = record(info?.time)
    const at = Number(
      raw?.created ?? data?.time ?? time?.completed ?? time?.updated ?? time?.created,
    )
    const observation = bound.observe(
      payload,
      envelope ?? causal(Number.isFinite(at) ? at : undefined),
    )
    if (observation) ContextObservationSchema.parse(observation)
    return observation
  }
  return { bound, observe, causal, lifetime, published, request, requests }
}

async function settle() {
  for (let i = 0; i < 24; i++) await Promise.resolve()
}

async function summary(bound: ContextSessionStrategy) {
  const result = await bound.summary({ timeoutMs: 100 })
  if (result.status !== 'observation') throw new Error(result.reason.message)
  return ContextSummary.parse(result.observation.context)
}

async function available(bound: ContextSessionStrategy) {
  const value = await summary(bound)
  if (value.status !== 'available') throw new Error(`Expected available; got ${value.status}`)
  return value
}

async function detail(bound: ContextSessionStrategy) {
  const value = await available(bound)
  const result = ContextDetailResult.parse(
    await bound.detail({ sample: value.sample, timeoutMs: 100, maxRows: 128 }),
  )
  if (result.status !== 'available') throw new Error(result.reason.message)
  return result.lastRequest
}

function history(fixture: Fixture, name: string): unknown[] {
  const raw = fixture.messages[name]
  return Array.isArray(raw) ? raw : (record(raw)?.data as unknown[])
}

function nativeSession(fixture: Fixture, name = 'two'): Record<string, unknown> {
  const raw = record(fixture.sessions[name])
  return record(raw?.data) ?? raw ?? {}
}

function historyForPort(fixture: Fixture, name: string) {
  return history(fixture, name).map((raw) => {
    const row = record(raw) ?? {}
    return row.info
      ? row
      : {
          info: {
            ...row,
            sessionID: nativeSession(
              fixture,
              name === 'anthropic' || name === 'zero' || name === 'unknown' ? name : 'two',
            ).id,
            role: row.type,
          },
          parts: [],
        }
  })
}

function storeRows(fixture: Fixture) {
  const store = record(fixture.store)
  const messages = store?.message as Record<string, unknown>[]
  return (store?.part as Record<string, unknown>[]).map((part) => ({
    messageId: part.message_id,
    partId: part.id,
    sessionId: part.session_id,
    timeCreated: part.time_created,
    timeUpdated: part.time_updated,
    messageData: messages.find((message) => message.id === part.message_id)?.data,
    partData: part.data,
  }))
}

describe.each(fixtures)('%s measured context fixtures', (driver, fixture) => {
  it('pairs the latest request with the effective project override, not session totals', async () => {
    const f = setup(driver, fixture)
    f.observe(fixture.sessions.two)
    f.observe(historyForPort(fixture, 'two'))
    await settle()
    const value = await available(f.bound)
    expect(value.occupancy).toMatchObject({
      basis: 'last-request',
      usedTokens: { value: 13_000 },
      remainingTokens: { value: 19_000 },
      percent: { value: 40.625 },
    })
    expect(value.effectiveCapacity?.value).toBe(32_000)
    expect(value.model).toEqual({ providerId: 'audit', modelId: 'context-b' })
    expect(await detail(f.bound)).toMatchObject({
      input: { value: 12_000 },
      output: { value: 1_000 },
      cacheRead: { value: 4_000 },
      reasoning: { value: 300 },
    })
    expect(nativeSession(fixture).tokens).toBeDefined()
    expect(value.occupancy.usedTokens?.value).not.toBe(21_600)
    expect(f.requests.every((path) => !path.includes('/message'))).toBe(true)
    f.lifetime.abort()
  })

  it('does not convert pre-response zero aggregates to measured zero occupancy', async () => {
    const f = setup(driver, fixture)
    f.observe(fixture.sessions.before)
    await settle()
    expect(await summary(f.bound)).toMatchObject({
      status: 'pending',
      effectiveCapacity: { value: 64_000 },
    })
    expect(await summary(f.bound)).not.toHaveProperty('occupancy')
    f.lifetime.abort()
  })

  it('normalizes the admitted Anthropic cache and thinking shape once', async () => {
    const f = setup(driver, fixture, undefined, String(nativeSession(fixture, 'anthropic').id))
    f.observe(fixture.sessions.anthropic)
    f.observe(historyForPort(fixture, 'anthropic'))
    await settle()
    const value = await available(f.bound)
    expect(value.occupancy.usedTokens?.value).toBe(12_800)
    expect(await detail(f.bound)).toMatchObject({
      input: { value: 12_000 },
      output: { value: 800 },
      cacheRead: { value: 3_000 },
      cacheWrite: { value: 2_000 },
      reasoning: { value: 200 },
    })
    f.lifetime.abort()
  })

  it('retains counts and request detail when the capacity operation is absent or fails', async () => {
    const f = setup(driver, fixture, {
      request: async () => {
        throw new Error('unsupported metadata operation')
      },
    })
    f.observe(fixture.sessions.two)
    f.observe(historyForPort(fixture, 'two'))
    await settle()
    const value = await available(f.bound)
    expect(value.occupancy.usedTokens?.value).toBe(13_000)
    expect(value).not.toHaveProperty('effectiveCapacity')
    expect(value.occupancy).not.toHaveProperty('percent')
    expect(value.occupancy).not.toHaveProperty('remainingTokens')
    expect(await detail(f.bound)).toHaveProperty('input.value', 12_000)
    f.lifetime.abort()
  })

  it('replays main-session SSE steps without adding matching message, step or lifetime usage', async () => {
    const f = setup(driver, fixture)
    const untilCompaction = fixture.events.findIndex((raw) => {
      const value = record(raw)
      const properties = record(value?.properties)
      return (
        String(value?.type).includes('compact') ||
        record(properties?.part)?.type === 'compaction' ||
        record(properties?.info)?.agent === 'compaction'
      )
    })
    for (const raw of fixture.events.slice(0, untilCompaction)) f.observe(raw)
    await settle()
    expect((await available(f.bound)).occupancy.usedTokens?.value).toBe(13_000)
    expect((await available(f.bound)).effectiveCapacity?.value).toBe(32_000)
    f.lifetime.abort()
  })

  it('clears after compaction and recovers only a new main request, excluding summarizer usage', async () => {
    const f = setup(driver, fixture)
    f.observe(fixture.sessions.two)
    f.observe(historyForPort(fixture, 'two'))
    await settle()
    const old = (await available(f.bound)).sample
    f.observe(historyForPort(fixture, 'compacted'))
    expect(await summary(f.bound)).toMatchObject({
      status: 'pending',
      invalidation: { cause: 'compaction' },
    })
    f.observe(historyForPort(fixture, 'two'))
    expect((await summary(f.bound)).status).toBe('pending')
    const obsolete = await f.bound.detail({ sample: old, timeoutMs: 100, maxRows: 128 })
    expect(obsolete.status).toBe('superseded')
    f.observe(historyForPort(fixture, 'fresh'))
    await settle()
    expect((await available(f.bound)).occupancy.usedTokens?.value).toBe(2_200)
    f.lifetime.abort()
  })

  it.each([
    'model-changed',
    'compaction',
    'reset',
    'resume',
    'rewind',
    'fork',
    'binding-changed',
  ] as const)('fences completed replay after %s, even with a fresh read cursor', async (cause) => {
    const f = setup(driver, fixture)
    f.observe(fixture.sessions.two)
    f.observe(historyForPort(fixture, 'two'))
    await settle()
    const sample = (await available(f.bound)).sample
    f.bound.invalidate(cause, f.causal(Date.parse(sample.at) + 1))
    f.observe(historyForPort(fixture, 'two'))
    expect((await summary(f.bound)).status).toBe('pending')
    expect((await f.bound.detail({ sample, timeoutMs: 100, maxRows: 128 })).status).toBe(
      'superseded',
    )
    f.lifetime.abort()
  })

  it('never uses another provider/model row, a default, or an explicit zero as capacity', async () => {
    const f = setup(driver, fixture, undefined, String(nativeSession(fixture, 'zero').id))
    f.observe(fixture.sessions.zero)
    f.observe(historyForPort(fixture, 'zero'))
    await settle()
    expect((await available(f.bound)).effectiveCapacity).toBeUndefined()
    const metadata = structuredClone(fixture.metadata)
    expect(
      effectiveCapacity(
        metadata,
        { id: 'missing-model', providerID: 'audit' },
        driver.includes('2'),
        scope,
        fixture.configuration,
      ),
    ).toBeUndefined()
    expect(
      effectiveCapacity(
        metadata,
        { id: 'context-b', providerID: 'other' },
        driver.includes('2'),
        scope,
        fixture.configuration,
      ),
    ).toBeUndefined()
    f.lifetime.abort()
  })
})

describe('OpenCode capacity and lifecycle admission', () => {
  it('uses the stable project override and retains unsplit cache-write truth', () => {
    expect(effectiveCapacity(stableData.metadata, modelA, false, scope)?.value).toBe(64_000)
    const one = record(history(stableData, 'one')[1])
    const usage = requestUsage(record(one?.info)?.tokens, 'request', modelA)
    expect(usage?.lastRequest).toMatchObject({
      input: { value: 8_000 },
      output: { value: 600 },
      cacheRead: { value: 2_000 },
      cacheWrite: { value: 0 },
      reasoning: { value: 100 },
    })
    expect(usage?.used).toBe(8_600)
  })

  it('preserves preview cache-write detail and declines unproven default capacity', () => {
    const one = record(history(previewData, 'one')[1])
    expect(requestUsage(one?.tokens, 'request', modelA)?.lastRequest).toMatchObject({
      input: { value: 8_000 },
      output: { value: 600 },
      cacheRead: { value: 2_000 },
      cacheWrite: { value: 1_000 },
    })
    expect(
      effectiveCapacity(
        previewData.metadata,
        { id: 'unknown', providerID: 'audit' },
        true,
        scope,
        previewData.configuration,
      ),
    ).toBeUndefined()
    expect(effectiveCapacity(previewData.metadata, modelA, true, scope)).toBeUndefined()
    expect(
      effectiveCapacity(previewData.metadata, modelA, true, scope, previewData.configuration)
        ?.value,
    ).toBe(64_000)
  })

  it('requires the exact preview location and catalog id, not underlying modelID', () => {
    const metadata = structuredClone(previewData.metadata)
    const first = metadata.data[0]
    if (!first) throw new Error('Missing measured model fixture')
    first.modelID = 'context-b'
    expect(
      effectiveCapacity(metadata, modelB, true, { directory: '/other' }, previewData.configuration),
    ).toBeUndefined()
    metadata.data = metadata.data.slice(0, 1)
    expect(
      effectiveCapacity(metadata, modelB, true, scope, previewData.configuration),
    ).toBeUndefined()
  })

  it('rejects invalid/missing native fields instead of filling or trusting total', () => {
    const tokens = {
      input: 8_000,
      output: 700,
      reasoning: 300,
      cache: { read: 4_000, write: 0 },
      total: 999_999,
    }
    expect(requestUsage(tokens, 'request', modelB)?.used).toBe(13_000)
    for (const value of [NaN, Infinity, -1, '300', undefined])
      expect(requestUsage({ ...tokens, reasoning: value }, 'request', modelB)).toBeUndefined()
    expect(
      requestUsage(
        { ...tokens, input: Number.MAX_VALUE, output: Number.MAX_VALUE },
        'request',
        modelB,
      ),
    ).toBeUndefined()
  })

  it('publishes a new immutable summary identity when delayed capacity enriches counts', async () => {
    let resolve: (raw: unknown) => void = () => {}
    const deferred = new Promise<unknown>((done) => {
      resolve = done
    })
    const f = setup('opencode-server', stableData, { request: async () => deferred })
    f.observe(stableData.sessions.two)
    f.observe(historyForPort(stableData, 'two'))
    const counts = await available(f.bound)
    expect(counts.effectiveCapacity).toBeUndefined()
    resolve(stableData.metadata)
    await settle()
    const paired = await available(f.bound)
    expect(paired.sample.id).not.toBe(counts.sample.id)
    expect(paired.sample.contextRevision).toBeGreaterThan(counts.sample.contextRevision)
    expect(paired.sample.nativeSampleId).toBe(counts.sample.nativeSampleId)
    expect(paired.effectiveCapacity?.value).toBe(32_000)
    expect(
      (await f.bound.detail({ sample: counts.sample, timeoutMs: 100, maxRows: 128 })).status,
    ).toBe('superseded')
    f.lifetime.abort()
  })

  it('cannot pair delayed old-model metadata with a new selection', async () => {
    const resolves: ((value: unknown) => void)[] = []
    const f = setup('opencode-server', stableData, {
      request: async () => new Promise((resolve) => resolves.push(resolve)),
    })
    f.observe(stableData.sessions.before)
    await settle()
    f.observe(stableData.sessions.two)
    f.observe(historyForPort(stableData, 'two'))
    resolves[0]?.(stableData.metadata)
    await settle()
    expect((await available(f.bound)).effectiveCapacity).toBeUndefined()
    resolves.at(-1)?.(stableData.metadata)
    await settle()
    expect((await available(f.bound)).effectiveCapacity?.value).toBe(32_000)
    f.lifetime.abort()
  })

  it('coalesces repeated sample/hover reads and retries unsettled metadata only at a native boundary', async () => {
    let metadata: unknown = { providers: [] }
    const request = vi.fn(async () => metadata)
    const f = setup('opencode-server', stableData, { request })
    f.observe(stableData.sessions.two)
    f.observe(historyForPort(stableData, 'two'))
    await settle()
    const reads = request.mock.calls.length
    for (let i = 0; i < 5; i++) {
      f.observe(historyForPort(stableData, 'two'))
      await f.bound.summary({ timeoutMs: 100 })
      await detail(f.bound)
    }
    expect(request).toHaveBeenCalledTimes(reads)
    metadata = stableData.metadata
    f.observe({ type: 'catalog.updated' })
    await settle()
    expect((await available(f.bound)).effectiveCapacity?.value).toBe(32_000)
    expect(request).toHaveBeenCalledTimes(reads + 1)
    f.lifetime.abort()
  })

  it('drops reads after disposal and stale SSE generations/cursors', async () => {
    const f = setup('opencode-server', stableData)
    f.observe(stableData.sessions.two)
    const envelope = f.causal()
    f.observe(historyForPort(stableData, 'two'), envelope)
    await settle()
    const current = await available(f.bound)
    expect(f.observe(historyForPort(stableData, 'one'), envelope)).toBeUndefined()
    expect(
      f.observe(historyForPort(stableData, 'one'), { ...f.causal(), observerGeneration: 1 }),
    ).toBeUndefined()
    expect((await available(f.bound)).sample).toEqual(current.sample)
    const publications = f.published.length
    f.lifetime.abort()
    await settle()
    expect(f.published).toHaveLength(publications)
  })

  it('requires exact preview start/end correlation and native durable ordering', async () => {
    const f = setup('opencode2-server', previewData)
    const start = previewData.events.find((raw) => record(raw)?.type === 'session.step.started')
    const end = previewData.events.find((raw) => record(raw)?.type === 'session.step.ended')
    if (!start || !end) throw new Error('Missing measured step fixtures')
    f.observe(end)
    expect((await f.bound.summary({ timeoutMs: 100 })).status).toBe('refused')
    expect(f.observe(start)).toBeUndefined() // lower durable sequence
    const fresh = setup('opencode2-server', previewData)
    fresh.observe(start)
    const foreign = structuredClone(end)
    foreign.data.sessionID = 'other-session'
    expect(fresh.observe(foreign)).toBeUndefined()
    fresh.observe(end)
    expect((await available(fresh.bound)).occupancy.usedTokens?.value).toBe(8_600)
    f.lifetime.abort()
    fresh.lifetime.abort()
  })

  it.each([
    'compaction',
    'resume',
    'reset',
    'model-changed',
  ] as const)('drops delayed capacity after %s', async (cause) => {
    let resolve: (value: unknown) => void = () => {}
    const deferred = new Promise<unknown>((done) => {
      resolve = done
    })
    const signals: AbortSignal[] = []
    const f = setup('opencode-server', stableData, {
      request: async (_path, options) => {
        if (options.signal) signals.push(options.signal)
        return deferred
      },
    })
    f.observe(stableData.sessions.two)
    f.observe(historyForPort(stableData, 'two'))
    const prior = await available(f.bound)
    f.bound.invalidate(cause, f.causal(Date.parse(prior.sample.at) + 1))
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    resolve(stableData.metadata)
    await settle()
    expect(f.published).toEqual([])
    expect(await summary(f.bound)).toMatchObject({ status: 'pending', invalidation: { cause } })
    f.lifetime.abort()
  })

  it('cannot revive an older valid request after newer malformed request accounting', async () => {
    const f = setup('generic-pty', stableData)
    f.observe(stableData.sessions.two)
    const two = historyForPort(stableData, 'two')
    const last = structuredClone(two.at(-1))
    const older = structuredClone(last)
    const olderInfo = record(record(older)?.info)
    if (!olderInfo) throw new Error('Missing assistant fixture')
    const olderTime = record(olderInfo.time)
    if (!olderTime) throw new Error('Missing assistant time')
    olderInfo.id = 'older-request-same-model'
    olderInfo.time = {
      created: Number(olderTime.created) - 10,
      completed: Number(olderTime.completed) - 10,
    }
    const lastInfo = record(record(last)?.info)
    if (!lastInfo) throw new Error('Missing assistant fixture')
    lastInfo.tokens = { input: -1 }
    f.observe([last])
    expect((await summary(f.bound)).status).toBe('unavailable')
    f.observe([older])
    expect((await summary(f.bound)).status).toBe('unavailable')
    f.lifetime.abort()
  })

  it('retains measured zero and untruncated over-capacity estimates', async () => {
    for (const input of [0, 64_000]) {
      const f = setup('opencode-server', stableData)
      f.observe(stableData.sessions.two)
      const raw = structuredClone(historyForPort(stableData, 'two').at(-1))
      const info = record(record(raw)?.info)
      if (!info) throw new Error('Missing assistant fixture')
      info.tokens = { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      f.observe([raw])
      await settle()
      expect((await available(f.bound)).occupancy).toMatchObject({
        usedTokens: { value: input },
        percent: { value: input === 0 ? 0 : 200 },
        remainingTokens: { value: input === 0 ? 32_000 : 0 },
      })
      f.lifetime.abort()
    }
  })

  it('refreshes an effective context override on the current engine catalog boundary', async () => {
    let metadata: unknown = stableData.metadata
    const f = setup('opencode-server', stableData, { request: async () => metadata })
    f.observe(stableData.sessions.two)
    f.observe(historyForPort(stableData, 'two'))
    await settle()
    const first = await available(f.bound)
    expect(first.effectiveCapacity?.value).toBe(32_000)
    const changed = structuredClone(stableData.metadata)
    const selected = changed.providers.find((p) => p.id === 'audit')?.models['context-b']
    if (!selected) throw new Error('Missing model fixture')
    selected.limit.context = 64_000
    metadata = changed
    f.observe({ type: 'catalog.updated' })
    await settle()
    const second = await available(f.bound)
    expect(second.effectiveCapacity?.value).toBe(64_000)
    expect(second.occupancy.percent?.value).toBe(20.3125)
    expect(second.sample.nativeSampleId).toBe(first.sample.nativeSampleId)
    expect(second.sample.id).not.toBe(first.sample.id)
    f.lifetime.abort()
  })

  it('invalidates an effort/configuration selection and cannot reuse its old sample', async () => {
    const f = setup('opencode2-server', previewData)
    f.observe(previewData.sessions.two)
    f.observe(historyForPort(previewData, 'two'))
    await settle()
    const old = await available(f.bound)
    f.observe({
      type: 'session.model.selected',
      created: Date.parse(old.sample.at) + 1,
      data: { sessionID: previewData.sessionID, model: { ...modelB, variant: 'high' } },
    })
    expect(await summary(f.bound)).toMatchObject({
      status: 'pending',
      invalidation: { cause: 'model-changed' },
    })
    f.observe(historyForPort(previewData, 'two'))
    expect((await summary(f.bound)).status).toBe('pending')
    f.lifetime.abort()
  })

  it('encodes only the measured generation-specific scoping grammar', () => {
    const location = { directory: '/project with spaces', workspace: 'workspace-a' }
    expect(scopedPath('/api/model', location, true)).toBe(
      '/api/model?location%5Bdirectory%5D=%2Fproject+with+spaces&location%5Bworkspace%5D=workspace-a',
    )
    expect(scopedPath('/config/providers', location, false)).toBe(
      '/config/providers?directory=%2Fproject+with+spaces&workspace=workspace-a',
    )
  })

  it('pairs a measured new model when its selection event was missed, while ignoring old-model replay', async () => {
    const f = setup('opencode-server', stableData)
    f.observe(stableData.sessions.before)
    f.observe(historyForPort(stableData, 'one'))
    await settle()
    expect((await available(f.bound)).effectiveCapacity?.value).toBe(64_000)
    // No second session/model selection snapshot. The native request itself
    // proves the new provider/model rather than borrowing the old limit.
    f.observe(historyForPort(stableData, 'two'))
    await settle()
    const switched = await available(f.bound)
    expect(switched).toMatchObject({
      model: { modelId: 'context-b' },
      effectiveCapacity: { value: 32_000 },
      occupancy: { usedTokens: { value: 13_000 } },
    })
    f.observe(historyForPort(stableData, 'one'))
    expect((await available(f.bound)).sample).toEqual(switched.sample)
    f.lifetime.abort()
  })

  it('accepts the same native request finish after pending-capacity enrichment advances revision', async () => {
    const f = setup('opencode2-server', previewData)
    f.observe(previewData.sessions.before)
    const start = previewData.events.find((raw) => record(raw)?.type === 'session.step.started')
    const end = previewData.events.find((raw) => record(raw)?.type === 'session.step.ended')
    if (!start || !end) throw new Error('Missing step fixture')
    f.observe(start)
    await settle()
    const waiting = await summary(f.bound)
    expect(waiting).toMatchObject({ status: 'pending', effectiveCapacity: { value: 64_000 } })
    f.observe(end)
    expect((await available(f.bound)).occupancy.usedTokens?.value).toBe(8_600)
    f.lifetime.abort()
  })

  it('admits a new observer segment after resume while rejecting the prior generation', async () => {
    const f = setup('opencode-server', stableData)
    f.observe(stableData.sessions.two)
    f.observe(historyForPort(stableData, 'two'))
    await settle()
    const old = await available(f.bound)
    const at = Date.parse(old.sample.at) + 10
    const next = {
      ...f.causal(at),
      observerGeneration: 3,
      cursor: { segmentId: 'resumed-native', components: { seq: 1 } },
    }
    f.bound.invalidate('resume', next)
    const raw = structuredClone(record(historyForPort(stableData, 'two').at(-1))?.info)
    if (!raw) throw new Error('Missing assistant fixture')
    const info = { ...raw, id: 'new-after-resume', time: { created: at + 1 } }
    f.observe(
      { type: 'message.updated', properties: { sessionID: stableData.sessionID, info } },
      {
        ...next,
        at: new Date(at + 1).toISOString(),
        cursor: { ...next.cursor, components: { seq: 2 } },
      },
    )
    f.observe(
      {
        type: 'message.updated',
        properties: {
          sessionID: stableData.sessionID,
          info: { ...info, time: { created: at + 1, completed: at + 2 } },
        },
      },
      {
        ...next,
        at: new Date(at + 2).toISOString(),
        cursor: { ...next.cursor, components: { seq: 3 } },
      },
    )
    const current = await available(f.bound)
    expect(current.sample.observerGeneration).toBe(3)
    expect(f.observe(historyForPort(stableData, 'two'), f.causal(at + 3))).toBeUndefined()
    expect((await available(f.bound)).sample.nativeSampleId).toBe('new-after-resume')
    f.lifetime.abort()
  })
})

describe('OpenCode Store-backed support', () => {
  it('generic-pty uses existing owned Store rows and never probes for a limit', async () => {
    const f = setup('generic-pty', stableData)
    const rows = storeRows(stableData)
    f.observe(
      { session: { ...nativeSession(stableData), model: JSON.stringify(modelB) }, rows },
      f.causal(1_795_296_291_400),
    )
    const value = await available(f.bound)
    expect(value.occupancy.usedTokens?.value).toBe(13_000)
    expect(value.effectiveCapacity).toBeUndefined()
    expect(await detail(f.bound)).toHaveProperty('cacheRead.value', 4_000)
    await settle()
    expect(f.request).not.toHaveBeenCalled()
    // A late update to an old part retains the old message's native creation.
    f.observe({
      session: nativeSession(stableData),
      rows: rows.slice(0, 3).map((row) => ({ ...row, timeUpdated: 1_795_296_300_000 })),
    })
    expect((await available(f.bound)).sample).toEqual(value.sample)
    f.lifetime.abort()
  })

  it('declines headless without a verified invocation-owned native source', () => {
    const declaration = opencodeContext.forDriver('headless')
    expect(declaration.supported).toBe(false)
    if (declaration.supported) throw new Error('Headless has no owned observation source')
    expect(declaration.reason).toContain('invocation-owned native source')
  })

  it('explains the explicit resumed launch and response prerequisites before a Store sample', async () => {
    const f = setup('generic-pty', stableData)
    expect(await f.bound.summary({ timeoutMs: 100 })).toMatchObject({
      status: 'refused',
      reason: {
        code: 'waiting',
        message: expect.stringContaining('verified explicitly resumed terminal launch'),
      },
    })
    expect(f.request).not.toHaveBeenCalled()
    f.lifetime.abort()
  })

  it('requires exact native ownership and keeps unknown driver support explicit', () => {
    const f = setup('generic-pty', stableData)
    expect(f.observe({ session: { id: 'other' }, rows: storeRows(stableData) })).toBeUndefined()
    expect(opencodeContext.forDriver('codex-app-server').supported).toBe(false)
    f.lifetime.abort()
  })
})
