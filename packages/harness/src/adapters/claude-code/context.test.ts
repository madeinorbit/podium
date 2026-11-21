import { ContextDetailResult, ContextSummary } from '@podium/model'
import type { CausalEnvelope } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type {
  ContextObservation,
  ContextProbePort,
  ContextSessionStrategy,
} from '../../context-types.js'
import type { AcceptedDriverId } from '../../manifest.js'
import fixtures from './__fixtures__/context-reports.json' with { type: 'json' }
import { claudeContext } from './context.js'
import { isClaudeInitializationRead } from './context-native.js'

const envelope = (seq = 1): CausalEnvelope => ({
  at: `2026-11-21T12:00:${String(seq).padStart(2, '0')}.000Z`,
  provenance: 'live',
  observerGeneration: 1,
  turnEpoch: 0,
  cursor: { segmentId: 'primary', components: { seq } },
})
const raw = fixtures.control['engine-2.1.319/after-2-summary']
const tick = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve()
}
function versioned(probe: ContextProbePort, version = '2.1.319'): ContextProbePort {
  return {
    request: (operation, options) =>
      isClaudeInitializationRead(operation)
        ? Promise.resolve({ claude_code_version: version })
        : probe.request(operation, options),
  }
}
function bind(
  driver: AcceptedDriverId = 'claude-sdk',
  probe?: ContextProbePort,
  version = '2.1.319',
) {
  const declaration = claudeContext.forDriver(driver)
  if (!declaration.supported) throw new Error(declaration.reason)
  const lifetime = new AbortController()
  const published: ContextObservation[] = []
  const nativeSessionId =
    driver === 'generic-pty'
      ? fixtures.terminal['after-2'].session_id
      : fixtures.assistant.session_id
  const session = declaration.value.bind({
    harness: 'claude-code',
    driver,
    nativeSessionId,
    revision: { bindingVersion: 2, observerGeneration: 1, turnEpoch: 0, contextRevision: 0 },
    signal: lifetime.signal,
    publish: (value) => published.push(value),
    ...(probe ? { probe: versioned(probe, version) } : {}),
  })
  return { session, lifetime, published, nativeSessionId, strategy: declaration.value }
}
async function current(session: ContextSessionStrategy) {
  const result = await session.summary({ timeoutMs: 500 })
  if (result.status !== 'observation') throw new Error(result.reason.message)
  return result.observation.context
}

describe('Claude context mode and lifecycle strategies', () => {
  it('declares each mode separately and declines unrelated drivers', () => {
    const structured = claudeContext.forDriver('claude-sdk')
    const terminal = claudeContext.forDriver('generic-pty')
    const headless = claudeContext.forDriver('headless')
    expect(structured.supported && structured.value.capability.summary).toBe('passive-and-explicit')
    expect(terminal.supported && terminal.value.capability.summary).toBe('passive')
    expect(headless.supported && headless.value.capability.summary).toBe('passive')
    expect(claudeContext.forDriver('claude-pty')).toEqual(terminal)
    expect(claudeContext.forDriver('codex-app-server').supported).toBe(false)
  })
  it('uses an actual bounded summary capability probe with explicit detail selection', async () => {
    const port = { request: vi.fn(async (_operation: unknown, _options: unknown) => raw) }
    const { strategy } = bind('claude-sdk')
    expect(await strategy.probe({ timeoutMs: 500 }, versioned(port))).toEqual({
      status: 'available',
    })
    expect(port.request.mock.calls[0]?.[0]).toEqual({
      subtype: 'get_context_usage',
      detail: 'summary',
    })
    expect(
      (await strategy.probe({ timeoutMs: 500 }, { request: async () => ({ totalTokens: -1 }) }))
        .status,
    ).toBe('unavailable')
    expect((await bind('generic-pty').strategy.probe({ timeoutMs: 500 }, port)).status).toBe(
      'unavailable',
    )
  })
  it('does not send a summary selector on older or unknown native versions', async () => {
    const port = { request: vi.fn(async (_operation: unknown, _options: unknown) => raw) }
    const { strategy } = bind('claude-sdk')
    for (const version of ['', '2.1.318', '3.0.0']) {
      expect(await strategy.probe({ timeoutMs: 500 }, versioned(port, version))).toMatchObject({
        status: 'unavailable',
        reason: { code: 'unverified-native-version' },
      })
      const bound = bind('claude-sdk', port, version)
      bound.session.observe({ type: 'system', subtype: 'init' }, envelope())
      await tick()
      expect(bound.published.at(-1)?.context).toMatchObject({
        status: 'unavailable',
        reason: { code: 'unverified-native-version' },
      })
    }
    expect(port.request).not.toHaveBeenCalled()
  })
  it('publishes summary after native lifecycle without hover and coalesces events', async () => {
    const port = { request: vi.fn(async (_operation: unknown, _options: unknown) => raw) }
    const bound = bind('claude-sdk', port)
    expect(
      bound.session.observe(
        { type: 'stream_event', event: { type: 'content_block_delta' } },
        envelope(),
      ),
    ).toBeUndefined()
    expect(port.request).not.toHaveBeenCalled()
    bound.session.observe(
      { type: 'system', subtype: 'init', session_id: bound.nativeSessionId },
      envelope(),
    )
    bound.session.observe(
      { type: 'system', subtype: 'init', session_id: bound.nativeSessionId },
      envelope(),
    )
    await tick()
    expect(port.request).toHaveBeenCalledTimes(1)
    expect(bound.published).toHaveLength(1)
    expect(ContextSummary.safeParse(bound.published[0]?.context).success).toBe(true)
    const summary = bound.published[0]!.context
    if (summary.status !== 'available') throw new Error('expected summary')
    const calls = port.request.mock.calls.length
    const detail = await bound.session.detail({
      sample: summary.sample,
      maxRows: 128,
      timeoutMs: 500,
    })
    expect(detail.status).toBe('available')
    expect(ContextDetailResult.safeParse(detail).success).toBe(true)
    expect(port.request).toHaveBeenCalledTimes(calls)
  })
  it('does not mint a fresh sample for an unchanged explicit read', async () => {
    const bound = bind('claude-sdk', { request: async () => raw })
    bound.session.observe({ type: 'system', subtype: 'init' }, envelope())
    await tick()
    const first = await current(bound.session)
    const second = await current(bound.session)
    expect(second).toEqual(first)
  })
  it('refreshes once per main response within a tool turn, rather than once per repeated block', async () => {
    const port = { request: vi.fn(async (_operation: unknown, _options: unknown) => raw) }
    const bound = bind('claude-sdk', port)
    bound.session.observe(fixtures.assistant, envelope())
    bound.session.observe(fixtures.assistant, envelope(2))
    await tick()
    expect(port.request).toHaveBeenCalledTimes(1)
    bound.session.observe(
      {
        ...fixtures.assistant,
        message: { ...fixtures.assistant.message, id: 'next-main-request' },
      },
      envelope(3),
    )
    await tick()
    expect(port.request).toHaveBeenCalledTimes(2)
    expect(bound.published.at(-1)?.context).toMatchObject({
      status: 'available',
      sample: { nativeSampleId: 'next-main-request' },
    })
  })
  it('retains an immutable cached report even if a port reuses its response object', async () => {
    const report = structuredClone(raw)
    const bound = bind('claude-sdk', { request: async () => report })
    bound.session.observe({ type: 'system', subtype: 'init' }, envelope())
    await tick()
    const summary = bound.published.at(-1)?.context
    if (summary?.status !== 'available') throw new Error('expected summary')
    report.categories[0]!.tokens = 999
    report.apiUsage.input_tokens = 999
    const detail = await bound.session.detail({
      sample: summary.sample,
      maxRows: 128,
      timeoutMs: 500,
    })
    if (detail.status !== 'available') throw new Error('expected cached detail')
    expect(detail.composition?.rows[0]?.tokens?.value).toBe(17)
    expect(detail.lastRequest?.input?.value).toBe(24000)
  })
  it('discards a late control reply across compaction and cancels prior detail', async () => {
    let resolve!: (value: unknown) => void
    const bound = bind('claude-sdk', {
      request: async () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    bound.session.observe({ type: 'system', subtype: 'init' }, envelope())
    await tick()
    const clear = bound.session.invalidate('compaction', envelope(2))
    expect(clear.context.status).toBe('pending')
    resolve(raw)
    await tick()
    expect(bound.published).toHaveLength(0)
    bound.lifetime.abort()
  })
  it('resets composition after model change and keeps older request model separate', async () => {
    let report: unknown = raw
    const bound = bind('claude-sdk', { request: async () => report })
    bound.session.observe(fixtures.assistant, envelope())
    bound.session.observe({ type: 'system', subtype: 'init' }, envelope())
    await tick()
    const prior = bound.published.at(-1)!.context
    if (prior.status !== 'available') throw new Error('expected summary')
    bound.session.invalidate('model-changed', envelope(2))
    expect(
      (await bound.session.detail({ sample: prior.sample, maxRows: 128, timeoutMs: 500 })).status,
    ).toBe('superseded')
    report = fixtures.control['engine-2.1.319/after-model-summary']
    const next = await current(bound.session)
    if (next.status !== 'available') throw new Error('expected summary')
    expect(next.model?.modelId).toBe('claude-opus-4-6')
    expect(next.effectiveCapacity?.value).toBe(200000)
    const detail = await bound.session.detail({ sample: next.sample, maxRows: 128, timeoutMs: 500 })
    if (detail.status !== 'available') throw new Error('expected detail')
    expect(detail.lastRequest?.model).toBeUndefined()
    expect(detail.lastRequest?.requestId).toBeUndefined()
  })
  it('reads only matching model capacity from result ledgers and ignores their token totals', async () => {
    const bound = bind('claude-sdk', { request: async () => raw })
    bound.session.observe(fixtures.result, envelope())
    await tick()
    const summary = bound.published.at(-1)!.context
    if (summary.status !== 'available') throw new Error('expected summary')
    expect(summary.occupancy.usedTokens?.value).toBe(24000)
    expect(summary.modelCapacity).toMatchObject({ value: 1000000, basis: 'model-metadata' })
    bound.session.observe(
      {
        ...fixtures.result,
        parent_tool_use_id: 'child',
        modelUsage: { other: { inputTokens: 99999999 } },
      },
      envelope(2),
    )
    await tick()
    expect(bound.published).toHaveLength(1)
    bound.session.observe(
      {
        ...fixtures.result,
        modelUsage: { [raw.model]: { contextWindow: 0, inputTokens: 99999999 } },
      },
      envelope(3),
    )
    await tick()
    const withoutCapacity = bound.published.at(-1)?.context
    if (withoutCapacity?.status !== 'available') throw new Error('expected partial capacity')
    expect(withoutCapacity.modelCapacity).toBeUndefined()
    expect(withoutCapacity.occupancy.usedTokens?.value).toBe(24000)
  })
  it('rejects child/foreign observations and old causal generations', async () => {
    const bound = bind('headless')
    for (const record of [
      { ...fixtures.assistant, parent_tool_use_id: 'child' },
      { ...fixtures.assistant, isSidechain: true },
      { ...fixtures.assistant, session_id: 'foreign' },
    ])
      expect(bound.session.observe(record, envelope())).toBeUndefined()
    expect(
      bound.session.observe(fixtures.assistant, { ...envelope(), observerGeneration: 2 }),
    ).toBeUndefined()
    expect((await bound.session.summary({ timeoutMs: 500 })).status).toBe('refused')
  })
  it('supports constrained headless request counts without manufacturing a window or semantic rows', async () => {
    const bound = bind('headless')
    const observation = bound.session.observe(fixtures.storeAssistant, envelope())!
    expect(observation.context).toMatchObject({
      status: 'available',
      occupancy: { basis: 'last-request', usedTokens: { value: 24000 } },
    })
    const summary = observation.context
    if (summary.status !== 'available') throw new Error('expected summary')
    expect(summary.effectiveCapacity).toBeUndefined()
    expect(summary.occupancy.percent).toBeUndefined()
    const detail = await bound.session.detail({
      sample: summary.sample,
      maxRows: 128,
      timeoutMs: 500,
    })
    if (detail.status !== 'available') throw new Error('expected detail')
    expect(detail.composition).toBeUndefined()
    expect(detail.lastRequest?.output?.value).toBe(6000)
    const streaming = bind('headless')
    const header = streaming.session.observe(fixtures.assistant, envelope())?.context
    if (header?.status !== 'available') throw new Error('expected input-only header')
    const headerDetail = await streaming.session.detail({
      sample: header.sample,
      maxRows: 128,
      timeoutMs: 500,
    })
    if (headerDetail.status !== 'available') throw new Error('expected input-only detail')
    expect(headerDetail.lastRequest?.output).toBeUndefined()
    const resultOnly = bind('headless')
    resultOnly.session.observe(fixtures.result, envelope())
    expect(await current(resultOnly.session)).toMatchObject({
      status: 'unavailable',
      reason: { code: 'no-main-request-observation' },
    })
  })
  it('clears fresh/null and synthetic post-compaction terminal usage', async () => {
    const bound = bind('generic-pty')
    const fresh = bound.session.observe(fixtures.terminal.fresh, envelope())!
    expect(fresh.context).toMatchObject({
      status: 'unavailable',
      effectiveCapacity: { value: 200000 },
      reason: { code: 'no-main-response' },
    })
    const summary = bound.session.observe(fixtures.terminal['after-2'], envelope(2))!.context
    expect(summary.status).toBe('available')
    bound.session.observe(
      { hook_event_name: 'PreCompact', session_id: bound.nativeSessionId },
      envelope(3),
    )
    expect(bound.session.observe(fixtures.terminal['after-2'], envelope(4))?.context.status).toBe(
      'unavailable',
    )
    const compact = bound.session.observe(fixtures.terminal['after-compact'], envelope(4))!.context
    expect(compact).toMatchObject({ status: 'unavailable', reason: { code: 'no-main-response' } })
    if (summary.status !== 'available') throw new Error('expected summary')
    expect(
      (await bound.session.detail({ sample: summary.sample, maxRows: 128, timeoutMs: 500 })).status,
    ).toBe('superseded')
  })
  it('does not admit a cached status sample on unproven resume or transcript replay', () => {
    const bound = bind('generic-pty')
    bound.session.invalidate('resume', envelope())
    expect(bound.session.observe(fixtures.terminal['after-2'], envelope(2))?.context.status).toBe(
      'unavailable',
    )
    expect(
      bound.session.observe(
        { ...fixtures.assistant, session_id: bound.nativeSessionId },
        { ...envelope(3), provenance: 'bootstrap' },
      ),
    ).toBeUndefined()
    expect(bound.session.observe(fixtures.terminal['after-2'], envelope(4))?.context.status).toBe(
      'unavailable',
    )
  })
  it('fences terminal model changes and reset until usage changes or a matching live Store response proves it', () => {
    const bound = bind('generic-pty')
    bound.session.observe(fixtures.terminal['after-2'], envelope())
    const modelChanged = { ...fixtures.terminal['after-2'], model: { id: 'changed-model' } }
    expect(bound.session.observe(modelChanged, envelope(2))?.context.status).toBe('unavailable')
    const fresh = {
      ...fixtures.storeAssistant,
      sessionId: bound.nativeSessionId,
      message: { ...fixtures.storeAssistant.message, model: 'changed-model' },
    }
    expect(bound.session.observe(fresh, envelope())).toBeUndefined()
    expect(bound.session.observe(modelChanged, envelope(3))?.context.status).toBe('unavailable')
    bound.session.observe(fresh, envelope(4))
    expect(bound.session.observe(modelChanged, envelope(5))?.context.status).toBe('available')
    bound.session.invalidate('reset', envelope(6))
    expect(bound.session.observe(modelChanged, envelope(7))?.context.status).toBe('unavailable')
  })
  it('unwraps native compaction callbacks and ignores a pending read after the causal turn advances', async () => {
    let resolve!: (value: unknown) => void
    const bound = bind('claude-sdk', {
      request: async () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    bound.session.observe({ type: 'system', subtype: 'init' }, envelope())
    await tick()
    bound.session.observe({ type: 'stream_event' }, { ...envelope(2), turnEpoch: 1 })
    resolve(raw)
    await tick()
    expect(bound.published).toHaveLength(0)
    expect(
      bound.session.observe(
        {
          type: 'control_request',
          request: {
            subtype: 'hook_callback',
            input: { hook_event_name: 'SessionStart', source: 'compact' },
          },
        },
        { ...envelope(3), turnEpoch: 1 },
      )?.context.status,
    ).toBe('pending')
    bound.lifetime.abort()
  })
  it('retains the immutable headless sample on a repeated Store record and declines aggregate iterations', () => {
    const bound = bind('headless')
    const first = bound.session.observe(fixtures.storeAssistant, envelope())
    expect(bound.session.observe(fixtures.storeAssistant, envelope(2))).toEqual(first)
    const aggregate = {
      ...fixtures.storeAssistant,
      message: {
        ...fixtures.storeAssistant.message,
        usage: {
          ...fixtures.storeAssistant.message.usage,
          iterations: [{ type: 'compaction', input_tokens: 100 }],
        },
      },
    }
    expect(bound.session.observe(aggregate, envelope(3))?.context).toMatchObject({
      status: 'unavailable',
      reason: { code: 'unverified-request-iterations' },
    })
  })
  it('settles timeout/cancellation and ignores a disposed binding', async () => {
    const bound = bind('claude-sdk', { request: async () => new Promise(() => {}) })
    bound.session.observe({ type: 'unrelated' }, envelope())
    const result = await bound.session.summary({ timeoutMs: 5 })
    expect(['refused', 'observation']).toContain(result.status)
    bound.lifetime.abort()
    await tick()
    expect(bound.published).toHaveLength(0)
    expect((await bound.session.summary({ timeoutMs: 500 })).status).toBe('cancelled')
  })
  it('returns a reason for malformed control and validates explicit detail bounds/cancellation', async () => {
    const bad = bind('claude-sdk', { request: async () => ({ totalTokens: -1 }) })
    bad.session.observe({ type: 'system', subtype: 'init' }, envelope())
    await tick()
    expect(bad.published[0]?.context).toMatchObject({
      status: 'unavailable',
      reason: { code: 'malformed-native-context' },
    })
    const bound = bind('generic-pty')
    const value = bound.session.observe(fixtures.terminal['after-2'], envelope())!.context
    if (value.status !== 'available') throw new Error('expected summary')
    const request = { sample: value.sample, maxRows: 128, timeoutMs: 500 }
    expect((await bound.session.detail({ ...request, maxRows: 129 })).status).toBe('refused')
    const abort = new AbortController()
    const pending = bound.session.detail({ ...request, signal: abort.signal })
    abort.abort()
    expect((await pending).status).toBe('cancelled')
  })
})
