import { ContextDetailResult, type ContextInvalidationCause, ContextSummary } from '@podium/model'
import type { CausalEnvelope } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { ContextObservation } from '../../context-types.js'
import fixtures from './__fixtures__/context-1.0.70-1.0.89.json' with { type: 'json' }
import { grokContext } from './context.js'
import { grokContextUpdate, object } from './context-native.js'

function world() {
  const driver = 'grok-acp'
  const declared = grokContext.forDriver(driver)
  if (!declared.supported) throw new Error(declared.reason)
  const lifetime = new AbortController()
  const request = vi.fn(async () => {
    throw new Error('No context read may invoke native work')
  })
  const published: ContextObservation[] = []
  const bound = declared.value.bind({
    harness: 'grok',
    driver,
    nativeSessionId: 'native-primary',
    revision: { bindingVersion: 2, observerGeneration: 3, turnEpoch: 0, contextRevision: 0 },
    signal: lifetime.signal,
    probe: { request },
    publish: (o) => published.push(o),
  })
  let ms = 1795295980000,
    seq = 0
  const envelope = (time = ++ms): CausalEnvelope => ({
    at: new Date(time).toISOString(),
    provenance: 'live',
    observerGeneration: 3,
    turnEpoch: 0,
    cursor: { segmentId: 'fixture', components: { seq: ++seq } },
  })
  const feed = (raw: unknown, override: Partial<CausalEnvelope> = {}) => {
    ms = Number(grokContextUpdate(raw)?.meta?.agentTimestampMs ?? ms + 1)
    return bound.observe(raw, { ...envelope(ms), ...override })
  }
  return { bound, feed, envelope, request, lifetime, published, declaration: declared.value }
}
const frames = fixtures.acp['1.0.89/live'].frames
const statuses = frames.filter(
  (f) => grokContextUpdate(f)?.update.sessionUpdate === 'session_status',
)
const start = statuses[2]!
const finish = frames.find((f) => grokContextUpdate(f)?.update.sessionUpdate === 'turn_completed')!
const end = statuses[3]!
const copy = (value: unknown): Record<string, unknown> =>
  structuredClone(value) as Record<string, unknown>
function event(kind: string, at: number, fields: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    method: '_x.ai/session_notification',
    params: {
      sessionId: 'native-primary',
      update: { sessionUpdate: kind, ...fields },
      _meta: { agentTimestampMs: at },
    },
  }
}
async function reading(w: ReturnType<typeof world>) {
  const result = await w.bound.summary({ timeoutMs: 500 })
  if (result.status !== 'observation') throw new Error('Expected current context')
  expect(ContextSummary.safeParse(result.observation.context).success).toBe(true)
  return result.observation.context
}

describe('Grok context lifecycle strategy', () => {
  it.each([
    '1.0.70/live',
    '1.0.89/live',
  ] as const)('replays captured %s occupancy independently of two-request accounting', async (key) => {
    const w = world()
    const emitted: ContextObservation[] = []
    for (const frame of fixtures.acp[key].frames) {
      expect(grokContextUpdate(frame)?.update.sessionUpdate).not.toBe('usage_update')
      const value = w.feed(frame)
      if (value) emitted.push(value)
    }
    const values = emitted.flatMap((o) =>
      o.context.status === 'available' ? [o.context.occupancy.usedTokens?.value] : [],
    )
    expect(values.slice(0, 2)).toEqual([12025, 12525])
    expect(values).not.toContain(24550)
    const summary = await reading(w)
    if (summary.status !== 'available') throw new Error('Expected available context')
    const detail = await w.bound.detail({ sample: summary.sample, timeoutMs: 500, maxRows: 16 })
    expect(ContextDetailResult.safeParse(detail).success).toBe(true)
    expect(detail.status).toBe('available')
    expect(detail).not.toHaveProperty('composition')
    expect(w.request).not.toHaveBeenCalled()
    if (key === '1.0.70/live') {
      expect(values).toEqual([12025, 12525, 13025, 3525])
      expect(
        emitted.some(
          (o) => o.context.status === 'pending' && o.context.invalidation?.cause === 'compaction',
        ),
      ).toBe(true)
    } else {
      expect(detail).toMatchObject({
        lastRequest: {
          input: { value: 12500 },
          output: { value: 25 },
          cacheRead: { value: 3000 },
          reasoning: { value: 7 },
        },
      })
    }
  })
  it('declines fictional usage_update, quota and arbitrary totalTokens sources', async () => {
    const w = world()
    expect(w.feed(event('usage_update', 1795296860000, { used: 50, size: 100 }))).toBeUndefined()
    expect(w.feed({ totalTokens: 999 })).toBeUndefined()
    expect(await w.bound.summary({ timeoutMs: 500 })).toMatchObject({ status: 'refused' })
    expect(grokContext.forDriver('headless')).toMatchObject({
      supported: false,
      reason: expect.stringContaining('lag inference'),
    })
    expect(grokContext.forDriver('generic-pty')).toMatchObject({
      supported: false,
      reason: expect.stringContaining('no isolated status bridge'),
    })
  })
  it('retains capacity-only pending information without accepting initialization/start anchors', async () => {
    const w = world()
    const first = w.feed(statuses[0])!
    expect(first.context).toMatchObject({
      status: 'pending',
      effectiveCapacity: { value: 100000 },
      model: { modelId: 'probe-a' },
    })
    expect(first.context).not.toHaveProperty('occupancy')
    expect(w.feed(start)).toBeUndefined()
    expect((await reading(w)).status).toBe('pending')
  })
  it('seeds selected model/window from exact native new/load identity, without relabeling occupancy', async () => {
    const w = world()
    expect(w.feed(fixtures.sessionResults.new)?.context).toMatchObject({
      status: 'pending',
      model: { modelId: 'probe-a' },
      effectiveCapacity: { value: 100000, basis: 'configured' },
    })
    w.feed(start)
    w.feed(finish)
    w.feed(end)
    const old = await reading(w)
    w.bound.invalidate(
      'resume',
      w.envelope(Number(grokContextUpdate(end)?.meta?.agentTimestampMs) + 1),
    )
    expect(w.feed(fixtures.sessionResults.load)?.context).toMatchObject({
      status: 'pending',
      model: { modelId: 'probe-b' },
      effectiveCapacity: { value: 200000, basis: 'configured' },
    })
    expect(old).toMatchObject({
      status: 'available',
      model: { modelId: 'probe-a' },
      effectiveCapacity: { value: 100000 },
    })
    const foreign = copy(fixtures.sessionResults.new)
    object(foreign.result)!.sessionId = 'other-session'
    expect(w.feed(foreign)).toBeUndefined()
  })
  it.each([
    'model-changed',
    'compaction',
    'resume',
    'rewind',
    'reset',
    'fork',
    'binding-changed',
  ] as ContextInvalidationCause[])('does not promote an old in-flight completion after %s', async (cause) => {
    const w = world()
    w.feed(statuses[0])
    w.feed(start)
    const startAt = Number(grokContextUpdate(start)!.meta!.agentTimestampMs)
    const clear = w.bound.invalidate(cause, w.envelope(startAt + 1))
    expect(clear.context).toMatchObject({ status: 'pending', revision: { contextRevision: 1 } })
    w.feed(finish)
    w.feed(end)
    expect((await reading(w)).status).toBe('pending')
    const nextStart = copy(start),
      nextFinish = copy(finish),
      nextEnd = copy(end)
    for (const frame of [nextStart, nextFinish, nextEnd]) {
      const p = object(frame.params)!,
        u = object(p.update)!,
        m = object(p._meta)!
      m.agentTimestampMs = Number(m.agentTimestampMs) + 1000
      if (u.prompt_id) u.prompt_id = 'post-boundary-request'
      if (u.turn) object(u.turn)!.started_at_ms = Number(object(u.turn)!.started_at_ms) + 1000
    }
    w.feed(nextStart)
    w.feed(nextFinish)
    w.feed(nextEnd)
    expect(await reading(w)).toMatchObject({
      status: 'available',
      sample: { contextRevision: 1, turnRevision: 'post-boundary-request' },
    })
  })
  it('keeps the old model anchor fenced even if completion/new status use the newly selected model', async () => {
    const w = world()
    w.feed(start)
    const t = Number(grokContextUpdate(start)!.meta!.agentTimestampMs)
    w.feed(event('model_changed', t + 1, { model_id: 'probe-b' }))
    const oldCompletion = copy(finish),
      relabelled = copy(end)
    const p = object(relabelled.params)!,
      u = object(p.update)!
    u.model = { id: 'probe-b' }
    object(u.context_window)!.context_window_size = 200000
    w.feed(oldCompletion)
    w.feed(relabelled)
    expect(await reading(w)).toMatchObject({
      status: 'pending',
      model: { modelId: 'probe-b' },
      effectiveCapacity: { value: 200000 },
    })
  })
  it('does not mint a new sample for duplicate status/timer/replay, stale timestamp or old generation', async () => {
    const w = world()
    w.feed(start)
    w.feed(finish)
    w.feed(end)
    const before = await reading(w)
    expect(w.feed(end)).toBeUndefined()
    expect(w.feed(end, { provenance: 'replay' })).toBeUndefined()
    expect(w.feed(end, { observerGeneration: 2 })).toBeUndefined()
    expect(w.feed(start)).toBeUndefined()
    expect(await reading(w)).toEqual(before)
    const accountingOnly = copy(end),
      accountingParams = object(accountingOnly.params)!
    object(accountingParams._meta)!.agentTimestampMs =
      Number(object(accountingParams._meta)!.agentTimestampMs) + 1
    object(object(accountingParams.update)!.context_window)!.session_input_tokens = 99999
    expect(w.feed(accountingOnly)).toBeUndefined()
    expect(await reading(w)).toEqual(before)
    const foreign = copy(end)
    object(foreign.params)!.sessionId = 'child-session'
    expect(w.feed(foreign)).toBeUndefined()
  })
  it('requires fresh post-resume inference instead of persisted replay/live load status', async () => {
    const w = world()
    for (const frame of fixtures.acp['1.0.70/resume'].frames) {
      const replay = grokContextUpdate(frame)?.meta?.isReplay === true
      const value = w.feed(frame)
      if (replay) expect(value).toBeUndefined()
    }
    expect(await reading(w)).toMatchObject({
      status: 'available',
      occupancy: { usedTokens: { value: 4525 } },
      model: { modelId: 'probe-b' },
    })
  })
  it('clears an unmatched completed inference instead of assigning the previous request to its status', async () => {
    const w = world()
    w.feed(start)
    w.feed(finish)
    w.feed(end)
    const completions = frames.filter(
      (f) => grokContextUpdate(f)?.update.sessionUpdate === 'turn_completed',
    )
    expect(w.feed(completions[1])?.context).toMatchObject({
      status: 'pending',
      reason: { code: 'unmatched-inference' },
    })
    w.feed(statuses[5])
    expect((await reading(w)).status).toBe('pending')
    expect(w.feed(statuses[4])).toBeUndefined() // Reordered start is older than the completion.
    expect((await reading(w)).status).toBe('pending')
  })
  it('does not treat unverified failed/cancelled inference completion as fresh context', async () => {
    const w = world()
    w.feed(statuses[0])
    w.feed(start)
    const cancelled = copy(finish)
    object(object(cancelled.params)!.update)!.stop_reason = 'cancelled'
    w.feed(cancelled)
    w.feed(end)
    expect((await reading(w)).status).toBe('pending')
  })
  it('malformed/unverified status clears, and never silently becomes zero', async () => {
    const w = world()
    w.feed(start)
    w.feed(finish)
    w.feed(end)
    const bad = copy(end),
      params = object(bad.params)!,
      update = object(params.update)!
    object(params._meta)!.agentTimestampMs = Number(object(params._meta)!.agentTimestampMs) + 1
    update.context_window = { context_tokens: null, context_window_size: 0 }
    expect(w.feed(bad)?.context).toMatchObject({
      status: 'unavailable',
      reason: { code: 'malformed-native-context' },
    })
    update.schema_version = 2
    expect(w.feed(bad)?.context).toMatchObject({
      status: 'unavailable',
      reason: { code: 'unverified-native-status' },
    })
  })
  it('summary/detail are bounded cached reads, with exact sample matching and cancellation', async () => {
    const w = world()
    w.feed(start)
    w.feed(finish)
    w.feed(end)
    const current = await reading(w)
    if (current.status !== 'available') throw new Error('expected available')
    expect(await w.bound.summary({ timeoutMs: 0 })).toMatchObject({ status: 'refused' })
    expect(await w.bound.summary({ timeoutMs: 500, signal: AbortSignal.abort() })).toMatchObject({
      status: 'cancelled',
    })
    const req = { sample: current.sample, timeoutMs: 500, maxRows: 16 }
    expect(await w.bound.detail({ ...req, maxRows: 129 })).toMatchObject({ status: 'refused' })
    expect(
      await w.bound.detail({ ...req, sample: { ...current.sample, id: 'older' } }),
    ).toMatchObject({ status: 'superseded' })
    w.bound.invalidate(
      'compaction',
      w.envelope(Number(grokContextUpdate(end)!.meta!.agentTimestampMs) + 1),
    )
    expect(await w.bound.detail(req)).toMatchObject({ status: 'superseded' })
    w.lifetime.abort()
    expect(await w.bound.detail(req)).toMatchObject({ status: 'cancelled' })
    expect(w.request).not.toHaveBeenCalled()
  })
})
