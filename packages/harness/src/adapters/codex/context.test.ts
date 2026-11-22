import { readFileSync } from 'node:fs'
import { ContextDetailResult, contextUsagePercentOf } from '@podium/model'
import {
  type CausalEnvelope,
  ContextObservation as ObservationSchema,
} from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { ContextObservation } from '../../context-types.js'
import type { AcceptedDriverId } from '../../manifest.js'
import { codexContext } from './context.js'
import { CODEX_INVOCATION, CODEX_INVOCATION_SEGMENT } from './context-invocation.js'
import {
  codexContextVersion,
  codexRequestAccounting,
  decodeCodexUsage,
  object,
} from './context-native.js'
import native from './fixtures/context-0.169.0.json'
import { codexRuntime } from './transcript.js'

const primary = '01a2002b-2d4d-7161-847f-3e6ef24bf11f'
const revision = { bindingVersion: 1, observerGeneration: 1, contextRevision: 1, turnEpoch: 0 }
const at = '2026-11-22T12:00:00.000Z'
// Synthetic admission envelope for this archive's independently pinned binary.
// This lower bound is test scaffolding, not a claimed native spawn timestamp.
const captureFloor = '2026-11-21T00:00:00.000Z'
const clone = <T>(v: T): T => structuredClone(v)
const token = (n: number, total = n, window: unknown = 9_500) => ({
  method: 'thread/tokenUsage/updated',
  params: {
    threadId: primary,
    turnId: 'main',
    tokenUsage: {
      last: {
        totalTokens: n,
        inputTokens: n - 11,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 0,
        outputTokens: 11,
        reasoningOutputTokens: 3,
      },
      total: { totalTokens: total },
      modelContextWindow: window,
    },
  },
})
function world(driver: AcceptedDriverId = 'codex-app-server', nativeSessionId = primary) {
  const declaration = codexContext.forDriver(driver)
  if (!declaration.supported) throw new Error(declaration.reason)
  const life = new AbortController()
  const publish = vi.fn()
  const request = vi.fn(() => {
    throw new Error('Passive context cannot probe a provider')
  })
  const bound = declaration.value.bind({
    harness: 'codex',
    driver,
    nativeSessionId,
    revision,
    signal: life.signal,
    publish,
    probe: { request },
  })
  let seq = 0
  const observations: ContextObservation[] = []
  const causal = (overrides: Partial<CausalEnvelope> = {}): CausalEnvelope => ({
    at,
    provenance: 'live',
    observerGeneration: 1,
    turnEpoch: 0,
    cursor: { segmentId: 'test-context', components: { seq: ++seq } },
    ...overrides,
  })
  const observe = (raw: unknown, overrides: Partial<CausalEnvelope> = {}) => {
    const observation = bound.observe(raw, causal(overrides))
    if (observation) {
      ObservationSchema.parse(observation)
      observations.push(observation)
    }
    return observation
  }
  const current = async () => {
    const result = await bound.summary({ timeoutMs: 500 })
    if (result.status !== 'observation') throw new Error(result.reason.message)
    return result.observation
  }
  const available = async () => {
    const { context } = await current()
    if (context.status !== 'available') throw new Error(JSON.stringify(context))
    return context
  }
  const detail = async () => {
    const context = await available()
    return ContextDetailResult.parse(
      await bound.detail({ sample: context.sample, maxRows: 16, timeoutMs: 500 }),
    )
  }
  const seed = () => {
    observe({ id: 1, result: { userAgent: 'fixture/0.169.0 linux' } })
    observe({
      id: 2,
      result: { thread: { id: nativeSessionId }, model: 'gpt-6.1-sol', modelProvider: 'fixture' },
    })
    observe({
      method: 'turn/started',
      params: { threadId: nativeSessionId, turn: { id: 'main', rootTurnId: 'main' } },
    })
  }
  const witness = (generation = 1) =>
    observe(
      {
        type: CODEX_INVOCATION,
        nativeSessionId,
        version: native.nativeVersion,
        startedAt: captureFloor,
      },
      {
        at: captureFloor,
        observerGeneration: generation,
        cursor: { segmentId: CODEX_INVOCATION_SEGMENT, components: { spawn: 1 } },
      },
    )
  return {
    bound,
    life,
    causal,
    observe,
    observations,
    current,
    available,
    detail,
    seed,
    witness,
    publish,
    request,
  }
}
async function replay(rows: readonly unknown[], driver: AcceptedDriverId, id = primary) {
  const w = world(driver, id)
  if (driver !== 'codex-app-server') w.witness()
  for (const row of rows)
    w.observe(row, { provenance: driver === 'codex-app-server' ? 'live' : 'bootstrap' })
  return w
}
function throughUsage(rows: readonly unknown[], total: number) {
  const index = rows.findIndex((v) => {
    const r = object(v)
    return (
      object(object(object(r?.params)?.tokenUsage)?.last)?.totalTokens === total ||
      object(object(object(r?.payload)?.info)?.last_token_usage)?.total_tokens === total
    )
  })
  if (index < 0) throw new Error(`No native usage ${total}`)
  return rows.slice(0, index + 1)
}
function values(request: unknown) {
  const r = object(request)
  return Object.fromEntries(
    ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].map((k) => [
      k,
      object(r?.[k])?.value,
    ]),
  )
}

// These are excerpts of the actual 0.169.0 capture, not a schema-generated
// capability claim. Additional hostile/lifecycle variants below are synthetic.
describe('Codex pinned native context measurements', () => {
  it('normalizes the same latest request in app-server, terminal and replayed headless modes', async () => {
    const app = await replay(throughUsage(native.appServer, 4511), 'codex-app-server')
    const terminal = await replay(throughUsage(native.rollout, 4511), 'generic-pty')
    const headless = await replay(throughUsage(native.rollout, 4511), 'headless')
    for (const w of [app, terminal, headless]) {
      const c = await w.available()
      expect(c).toMatchObject({
        model: { modelId: 'gpt-6.1-sol' },
        occupancy: {
          basis: 'last-request',
          usedTokens: { value: 4511, accuracy: 'estimated' },
          remainingTokens: { value: 4989 },
        },
        effectiveCapacity: { value: 9500, basis: 'native', accuracy: 'reported' },
      })
      expect(c.occupancy.percent?.value).toBe((4511 / 9500) * 100)
      expect(contextUsagePercentOf(c)).toBe(c.occupancy.percent?.value)
      const d = await w.detail()
      if (d.status !== 'available') throw new Error(d.reason.message)
      expect(values(d.lastRequest)).toEqual({
        input: 4300,
        cacheRead: 1100,
        cacheWrite: 0,
        output: 211,
        reasoning: 73,
      })
      expect(d.composition).toBeUndefined()
      expect(d.lastRequest?.requestId).toBeUndefined() // a turn ID is not a request ID
      expect(w.request).not.toHaveBeenCalled()
    }
    expect((await app.current()).provenance).toBe('live')
    expect((await app.available()).model?.providerId).toBe('fixture')
    expect((await terminal.available()).model?.providerId).toBeUndefined()
    expect((await terminal.current()).provenance).toBe('bootstrap')
    expect((await app.available()).occupancy.usedTokens?.source).toContain('app-server')
    expect((await headless.available()).occupancy.usedTokens?.source).toContain('rollout')
  })

  it('keeps actual terminal and exec resume usage while ignoring cumulative exec stdout', async () => {
    const h = await replay(native.headless, 'headless', '01a2002b-fcd8-7623-8664-9e85085437b4')
    const before = await h.available()
    expect(before.occupancy.usedTokens?.value).toBe(4511)
    expect(
      h.observe({ type: 'turn.completed', usage: { input_tokens: 10600, output_tokens: 522 } }),
    ).toBeUndefined()
    expect(await h.available()).toEqual(before)
    // Bind to the native session named by this separate TUI capture.
    const id = object(object(native.terminal[0])?.payload)?.id
    if (typeof id !== 'string') throw new Error('Missing native TUI session identity')
    const actual = await replay(native.terminal, 'generic-pty', id)
    expect((await actual.available()).occupancy.usedTokens?.value).toBe(3391)
    expect(values(((await actual.detail()) as { lastRequest?: unknown }).lastRequest)).toEqual({
      input: 3200,
      cacheRead: 900,
      cacheWrite: 0,
      output: 191,
      reasoning: 43,
    })
  })

  it('never turns many small lifetime requests into full occupancy', async () => {
    const w = world()
    w.seed()
    for (let i = 1; i <= 100; i++) w.observe(token(110, i * 110, 1000))
    const c = await w.available()
    expect(c.occupancy.usedTokens?.value).toBe(110)
    expect(c.occupancy.percent?.value).toBe(11)
    expect(contextUsagePercentOf(c)).toBe(11)
    expect(
      codexRuntime({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 1000,
            total_token_usage: { total_tokens: 11000 },
            last_token_usage: { total_tokens: 110 },
          },
        },
      }),
    ).toEqual({})
  })

  it('preserves over-capacity data and omits an incompatible legacy percentage', async () => {
    const w = world()
    w.seed()
    w.observe(token(12000))
    const c = await w.available()
    expect(c.occupancy.percent?.value).toBeGreaterThan(100)
    expect(c.occupancy.remainingTokens?.value).toBe(0)
    expect(contextUsagePercentOf(c)).toBeUndefined()
  })

  it.each([
    'codex-app-server',
    'generic-pty',
  ] as const)('classifies old/helper/estimate compaction emissions in %s', async (driver) => {
    const rows: unknown[] = driver === 'codex-app-server' ? native.appServer : native.rollout
    const w = world(driver)
    if (driver === 'generic-pty') w.witness()
    for (const r of rows) {
      w.observe(r, { provenance: driver === 'generic-pty' ? 'bootstrap' : 'live' })
      const usage =
        object(object(object(object(r)?.params)?.tokenUsage)?.last)?.totalTokens ??
        object(object(object(object(r)?.payload)?.info)?.last_token_usage)?.total_tokens
      if (usage === 1201) expect((await w.current()).context.status).not.toBe('available')
      if (usage === 7642 && driver === 'generic-pty') break
      if (
        object(r)?.method === 'item/completed' &&
        object(object(object(r)?.params)?.item)?.type === 'contextCompaction'
      )
        break
    }
    const c = await w.available()
    expect(c.occupancy).toMatchObject({ basis: 'native-estimate', usedTokens: { value: 7642 } })
    expect(await w.detail()).toMatchObject({ status: 'unavailable' })
    const nativeAt = c.sample.at
    expect(nativeAt).toContain('2026-11-21T22:12:40.')
    expect(nativeAt).not.toBe(at)
  })

  it('does not make an old-turn resume replay into a new request measurement', async () => {
    const w = world()
    const replayIndex = native.appServer.findIndex(
      (r) =>
        object(r)?.method === 'thread/tokenUsage/updated' &&
        object(object(object(r)?.params)?.tokenUsage)?.last &&
        object(r)?.emittedAtMs === 1795299160960,
    )
    for (const r of native.appServer.slice(replayIndex - 2, replayIndex + 1))
      w.observe(r, { provenance: 'bootstrap' })
    expect((await w.current()).context.status).toBe('pending')
    const recovered = await replay(native.rollout, 'headless')
    expect((await recovered.available()).occupancy.usedTokens?.value).toBe(2051)
    expect((await recovered.available()).sample.at).toContain('2026-11-21T22:12:40.')
  })
})

describe('Codex context lifecycle and field admission', () => {
  it('declares only admitted driver mechanisms and tested native versions', async () => {
    for (const driver of ['codex-app-server', 'generic-pty', 'headless'] as const) {
      const d = codexContext.forDriver(driver)
      expect(d.supported).toBe(true)
      if (d.supported)
        expect(d.value.capability).toEqual({ summary: 'passive', detail: 'on-demand' })
    }
    expect(codexContext.forDriver('claude-sdk').supported).toBe(false)
    for (const version of ['', '0.147.0', '0.167.0', '0.170.0', undefined])
      expect(codexContextVersion(version)).toBe(false)
    expect(codexContextVersion(native.nativeVersion)).toBe(true)
    const w = world()
    w.seed()
    w.observe({ id: 1, result: { userAgent: 'fixture/0.170.0 linux' } })
    w.observe(token(4511))
    expect((await w.current()).context).toMatchObject({
      status: 'unavailable',
      reason: { code: 'unverified-native-version' },
    })
  })

  it.each([
    null,
    undefined,
  ])('keeps a %s window unknown without a model capacity fallback', async (window) => {
    const w = world()
    w.seed()
    const raw = token(4511, 11122, window)
    raw.params.tokenUsage.modelContextWindow = window
    w.observe(raw)
    const c = await w.available()
    expect(c.occupancy.usedTokens?.value).toBe(4511)
    expect(c.effectiveCapacity).toBeUndefined()
    expect(c.modelCapacity).toBeUndefined()
    expect(c.occupancy.percent).toBeUndefined()
    expect(c.occupancy.remainingTokens).toBeUndefined()
  })

  it('keeps omitted/null native subsets unknown and explicit zeros reported', () => {
    const u = decodeCodexUsage(
      {
        total_tokens: 105,
        input_tokens: 100,
        output_tokens: 5,
        cached_input_tokens: null,
        cache_write_input_tokens: 0,
      },
      'rollout',
    )
    if (!u) throw new Error('Expected partial native usage')
    const r = codexRequestAccounting(u, 'rollout')
    expect(r?.input?.value).toBe(100)
    expect(r?.cacheRead).toBeUndefined()
    expect(r?.reasoning).toBeUndefined()
    expect(r?.cacheWrite?.value).toBe(0)
    expect(r?.output?.accuracy).toBe('reported')
  })

  it.each([
    { inputTokens: 4300, outputTokens: 211, cachedInputTokens: 4301 },
    { inputTokens: 4300, outputTokens: 211, reasoningOutputTokens: 212 },
    { inputTokens: 4300, outputTokens: 211, cacheWriteInputTokens: 4 },
    { inputTokens: -1 },
    { inputTokens: 0.5 },
    { totalTokens: Infinity },
    { totalTokens: null },
    { inputTokens: 4300, outputTokens: 210 },
  ])('refuses malformed or unverified request components %j', async (last) => {
    const w = world()
    w.seed()
    const raw = token(4511)
    Object.assign(raw.params.tokenUsage.last, last)
    w.observe(raw)
    expect((await w.current()).context.status).toBe('unavailable')
  })

  it('does not guess a reasoning-exclusion transform or zero request from a compaction estimate', async () => {
    const rows = clone(throughUsage(native.rollout, 4511))
    const info = object(object(object(rows.at(-1))?.payload)?.info)
    if (!info) throw new Error('Missing native info')
    info.last_usage_includes_reasoning = false
    const w = await replay(rows, 'generic-pty')
    expect((await w.current()).context).toMatchObject({
      status: 'unavailable',
      reason: { code: 'unverified-reasoning-inclusion' },
    })
    const app = world()
    app.seed()
    app.observe({
      ...token(100),
      params: {
        ...token(100).params,
        tokenUsage: {
          ...token(100).params.tokenUsage,
          last: {
            totalTokens: 7642,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
          },
        },
      },
    })
    expect((await app.current()).context.status).toBe('unavailable')
  })

  it('preserves a sample for rate-limit-only events but clears a usage-less completed turn', async () => {
    const w = await replay(throughUsage(native.rollout, 4511), 'generic-pty')
    const c = await w.available()
    const next = {
      type: 'event_msg',
      timestamp: '2026-11-21T22:12:40.000Z',
      ordinal: 100,
      payload: { type: 'token_count', info: null },
    }
    expect(w.observe(next)).toBeUndefined()
    expect(await w.available()).toEqual(c)
    w.observe({
      ...next,
      ordinal: 101,
      payload: { type: 'task_started', turn_id: 'new-main', root_turn_id: 'new-main' },
    })
    w.observe({ ...next, ordinal: 102, payload: { type: 'task_complete', turn_id: 'new-main' } })
    expect((await w.current()).context).toMatchObject({
      status: 'pending',
      reason: { code: 'no-request-usage' },
    })
  })

  it('invalidates selection without relabelling an old sample, then accepts the new model and window', async () => {
    const w = world()
    w.seed()
    w.observe(token(4511))
    const old = await w.available()
    w.observe({
      method: 'thread/settings/updated',
      params: {
        threadId: primary,
        threadSettings: { model: 'invented-model', modelProvider: 'fixture' },
      },
    })
    expect((await w.current()).context).toMatchObject({
      status: 'pending',
      model: { modelId: 'invented-model' },
    })
    expect(w.observe(token(4511))).toBeUndefined()
    w.observe({
      method: 'turn/started',
      params: { threadId: primary, turn: { id: 'changed', rootTurnId: 'changed' } },
    })
    const raw = token(4511, 11122, 19000)
    raw.params.turnId = 'changed'
    w.observe(raw)
    const c = await w.available()
    expect(c.model?.modelId).toBe('invented-model')
    expect(c.effectiveCapacity?.value).toBe(19000)
    expect(c.sample.contextRevision).toBeGreaterThan(old.sample.contextRevision)
    expect(await w.bound.detail({ sample: old.sample, maxRows: 16, timeoutMs: 500 })).toMatchObject(
      { status: 'superseded' },
    )
  })

  it.each([
    'reset',
    'compaction',
    'rewind',
    'fork',
  ] as const)('fences old records after %s even if replayed at now', async (cause) => {
    const w = world()
    w.seed()
    w.observe(token(4511))
    w.bound.invalidate(cause, w.causal())
    expect(w.observe(token(4511))).toBeUndefined()
    expect((await w.current()).context.status).toBe('pending')
    w.observe({
      method: 'turn/started',
      params: { threadId: primary, turn: { id: 'fresh', rootTurnId: 'fresh' } },
    })
    const fresh = token(4511)
    fresh.params.turnId = 'fresh'
    w.observe(fresh)
    expect((await w.available()).occupancy.usedTokens?.value).toBe(4511)
  })

  it('rejects old-generation, regressed-cursor, duplicate and foreign-session frames', async () => {
    const w = world()
    w.seed()
    const raw = token(4511)
    w.observe(raw)
    const current = await w.available()
    expect(w.observe(token(4000), { observerGeneration: 2 })).toBeUndefined()
    expect(
      w.observe(token(4000), { cursor: { segmentId: 'test-context', components: { seq: 1 } } }),
    ).toBeUndefined()
    const foreign = token(4000)
    foreign.params.threadId = 'other'
    expect(w.observe(foreign)).toBeUndefined()
    expect(w.observe(raw)).toBeUndefined()
    expect(await w.available()).toEqual(current)
    w.life.abort()
    expect(w.observe(token(4000))).toBeUndefined()
    expect(
      await w.bound.detail({ sample: current.sample, maxRows: 16, timeoutMs: 500 }),
    ).toMatchObject({ status: 'cancelled' })
  })

  it('requires bounded-tail lineage and never scans history or requests a probe', async () => {
    const tokenRow = throughUsage(native.rollout, 4511).at(-1)
    const w = await replay([native.rollout[0], tokenRow], 'headless')
    expect((await w.current()).context.status).toBe('pending')
    expect(w.request).not.toHaveBeenCalled()
    const c = world()
    c.seed()
    c.observe(token(4511))
    expect(await c.bound.summary({ timeoutMs: 0 })).toMatchObject({ status: 'refused' })
    expect(
      await c.bound.detail({ sample: (await c.available()).sample, maxRows: 129, timeoutMs: 500 }),
    ).toMatchObject({ status: 'refused' })
  })

  it('requires retained invocation provenance on resume and preserves the recovered native time', async () => {
    const w = await replay(native.rollout, 'generic-pty')
    const previous = await w.available()
    w.bound.invalidate('resume', w.causal({ observerGeneration: 2 }))
    for (const row of native.rollout) {
      expect(w.observe(row, { provenance: 'bootstrap', observerGeneration: 1 })).toBeUndefined()
      w.observe(row, { provenance: 'bootstrap', observerGeneration: 2 })
    }
    expect((await w.current()).context.status).not.toBe('available')
    w.bound.invalidate('resume', w.causal({ observerGeneration: 3 }))
    w.witness(3)
    for (const row of native.rollout)
      w.observe(row, { provenance: 'bootstrap', observerGeneration: 3 })
    const recovered = await w.available()
    expect(recovered.sample.at).toBe(previous.sample.at)
    expect(recovered.occupancy).toEqual(previous.occupancy)
    expect(recovered.sample.observerGeneration).toBe(3)
    expect(recovered.sample.contextRevision).toBeGreaterThan(previous.sample.contextRevision)
    expect(w.request).not.toHaveBeenCalled()
  })

  it('keeps sample identity and native time on repeated app-server usage', async () => {
    const rows = throughUsage(native.appServer, 4511)
    const w = await replay(rows, 'codex-app-server')
    const before = await w.available()
    w.observe({ ...object(rows.at(-1)), emittedAtMs: Date.parse(at) }, { provenance: 'bootstrap' })
    expect(await w.available()).toEqual(before)
  })

  it('clears a reported model when the native selection explicitly becomes null', async () => {
    const w = world()
    w.seed()
    w.observe(token(4511))
    w.observe({
      method: 'thread/settings/updated',
      params: { threadId: primary, threadSettings: { model: null } },
    })
    const c = (await w.current()).context
    expect(c.status).toBe('pending')
    expect(c).not.toHaveProperty('model')
    expect(c).not.toHaveProperty('effectiveCapacity')
  })

  it('replaces the capacity association on change and retains null as unknown', async () => {
    const w = world()
    w.seed()
    w.observe(token(4511))
    const previous = await w.available()
    w.observe(token(4511, 11122, 19000))
    const changed = await w.available()
    expect(changed.occupancy.percent?.value).toBe((4511 / 19000) * 100)
    expect(changed.sample.contextRevision).toBeGreaterThan(previous.sample.contextRevision)
    w.observe(token(4511, 11122, null))
    expect((await w.available()).effectiveCapacity).toBeUndefined()
    expect((await w.available()).occupancy.percent).toBeUndefined()
  })

  it('does not classify a helper or an isolated turn context as a main request', async () => {
    const start = clone(native.rollout[1])
    const payload = object(object(start)?.payload)
    if (!payload) throw new Error('Missing native task start')
    payload.turn_attribution = { parent_turn_id: 'helper-parent' }
    const helper = await replay(
      [native.rollout[0], start, native.rollout[2], native.rollout[3]],
      'generic-pty',
    )
    expect((await helper.current()).context.status).toBe('pending')
    const incomplete = await replay(
      [native.rollout[0], native.rollout[2], native.rollout[3]],
      'generic-pty',
    )
    expect((await incomplete.current()).context.status).toBe('pending')
  })

  it('keeps Codex capacity tables and new native grammar within the adapter', () => {
    const source = readFileSync(new URL('./context.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from ['"].*driver\/families/)
    expect(source).not.toMatch(/258_?400|gpt-.*\d{3,}/)
    expect(readFileSync(new URL('./transcript.ts', import.meta.url), 'utf8')).not.toContain(
      'contextUsagePercent:',
    )
  })

  it('admits only new live headerless usage from a fresh invocation witness', async () => {
    const w = world('generic-pty')
    const witness = {
      type: CODEX_INVOCATION,
      nativeSessionId: primary,
      version: '0.169.0',
      startedAt: '2026-11-21T22:12:39.800Z',
    }
    w.observe(witness, {
      cursor: { segmentId: CODEX_INVOCATION_SEGMENT, components: { spawn: 1 } },
    })
    for (const row of throughUsage(native.rollout, 4511).slice(5)) w.observe(row)
    expect((await w.available()).occupancy.usedTokens?.value).toBe(4511)
    expect((await w.available()).model?.providerId).toBeUndefined()
    const replay = world('headless')
    replay.observe(
      { ...witness, startedAt: at },
      {
        cursor: { segmentId: CODEX_INVOCATION_SEGMENT, components: { spawn: 1 } },
      },
    )
    for (const row of throughUsage(native.rollout, 4511).slice(5))
      replay.observe(row, { provenance: 'bootstrap' })
    expect((await replay.current()).context.status).toBe('unavailable')
  })

  it('does not let an original creation header certify a later historical writer', async () => {
    const w = world('generic-pty')
    for (const row of throughUsage(native.rollout, 4511))
      w.observe(row, { provenance: 'bootstrap' })
    expect((await w.current()).context).toMatchObject({
      status: 'unavailable',
      reason: { code: 'unverified-native-version' },
    })
  })

  it('does not trust an old creation header for a newer live writer or an untrusted witness cursor', async () => {
    const w = world('headless')
    const witness = {
      type: CODEX_INVOCATION,
      nativeSessionId: primary,
      version: '0.170.0',
      startedAt: '2026-11-21T22:12:39.800Z',
    }
    w.observe(witness, {
      cursor: { segmentId: CODEX_INVOCATION_SEGMENT, components: { spawn: 1 } },
    })
    for (const row of throughUsage(native.rollout, 4511)) w.observe(row)
    expect((await w.current()).context.status).toBe('unavailable')
    const untrusted = world('generic-pty')
    untrusted.observe({ ...witness, version: '0.169.0' })
    for (const row of throughUsage(native.rollout, 4511).slice(5)) untrusted.observe(row)
    expect((await untrusted.current()).context.status).toBe('unavailable')
  })
})
