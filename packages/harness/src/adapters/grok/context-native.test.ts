import { ContextDetailResult, ContextSummary } from '@podium/model'
import { describe, expect, it } from 'vitest'
import fixtures from './__fixtures__/context-1.0.70-1.0.89.json' with { type: 'json' }
import {
  grokContextUpdate,
  grokContextVersion,
  grokRequestAccounting,
  initializeGrokContext,
  normalizeGrokSignals,
  normalizeGrokStatus,
} from './context-native.js'

const sample = {
  bindingVersion: 1,
  observerGeneration: 1,
  turnEpoch: 0,
  contextRevision: 0,
  id: 'fixture',
  at: '2026-11-21T12:00:00.000Z',
  nativeSessionId: 'native-primary',
}
const frames = fixtures.acp['1.0.89/live'].frames
const status = frames
  .flatMap((frame) => {
    const update = grokContextUpdate(frame)?.update
    return update?.sessionUpdate === 'session_status' ? [update] : []
  })
  .at(-1)!

describe('Grok context grammar from measured 1.0.70 / 1.0.89', () => {
  it('opts into the actual extension while preserving caller capabilities', () => {
    expect(
      initializeGrokContext({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false }, _meta: { keep: true } },
      }),
    ).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false },
        _meta: { keep: true, 'x.ai/statusLine': true },
      },
    })
    expect(initializeGrokContext(null)).toBeNull()
    for (const v of ['1.0.44', '1.0.69', '1.0.71', '1.0.90', '2.0.0', undefined])
      expect(grokContextVersion(v)).toBe(false)
    expect(grokContextVersion('1.0.70')).toBe(true)
    expect(grokContextVersion('1.0.89')).toBe(true)
  })
  it('replaces occupancy, retaining native rounded percent and the distinct compaction threshold', () => {
    const value = normalizeGrokStatus(status, sample)!
    expect(ContextSummary.parse(value)).toMatchObject({
      status: 'available',
      model: { modelId: 'probe-a' },
      occupancy: {
        basis: 'native-estimate',
        usedTokens: { value: 12525 },
        percent: { value: 13 },
        remainingTokens: { value: 87475 },
      },
      effectiveCapacity: { value: 100000, basis: 'native' },
      compaction: { thresholdPercent: { value: 85 } },
    })
    expect(value).not.toHaveProperty('composition')
    expect(value).not.toHaveProperty('lastRequest')
  })
  it('keeps count-only and percent-only omissions honest without inverting rounding', () => {
    const used = normalizeGrokStatus({ context_window: { context_tokens: 12525 } }, sample)!
    expect(ContextSummary.safeParse(used).success).toBe(true)
    expect(used.occupancy.usedTokens?.value).toBe(12525)
    expect(used.occupancy.percent).toBeUndefined()
    expect(used.effectiveCapacity).toBeUndefined()
    const percentage = normalizeGrokStatus({ context_window: { used_percentage: 13 } }, sample)!
    expect(percentage.occupancy.usedTokens).toBeUndefined()
    expect(percentage.effectiveCapacity).toBeUndefined()
    expect(percentage.occupancy.percent?.value).toBe(13)
  })
  it.each([
    undefined,
    null,
    false,
    '0',
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('never turns missing/malformed counts into zero: %s', (value) => {
    expect(
      normalizeGrokStatus({ context_window: { context_tokens: value } }, sample),
    ).toBeUndefined()
    expect(normalizeGrokSignals({ contextTokensUsed: value }, sample)).toBeUndefined()
    const partial = normalizeGrokStatus(
      { context_window: { context_tokens: 4, context_window_size: value } },
      sample,
    )!
    expect(partial.occupancy.usedTokens?.value).toBe(4)
    expect(partial.effectiveCapacity).toBeUndefined()
  })
  it('preserves measured zero and untruncated over-limit numbers', () => {
    const zero = normalizeGrokStatus(
      { context_window: { context_tokens: 0, context_window_size: 100 } },
      sample,
    )!
    expect(zero.occupancy.usedTokens?.value).toBe(0)
    expect(zero.occupancy.percent?.value).toBe(0)
    const over = normalizeGrokStatus(
      { context_window: { context_tokens: 125, context_window_size: 100 } },
      sample,
    )!
    expect(ContextSummary.safeParse(over).success).toBe(true)
    expect(over.occupancy.percent?.value).toBe(125)
    expect(over.occupancy.remainingTokens?.value).toBe(0)
  })
  it('treats persisted terminal/headless signals as stale used-only, despite their own denominator', () => {
    for (const raw of Object.values(fixtures.signals)) {
      const stale = normalizeGrokSignals(raw, sample)!
      expect(ContextSummary.safeParse(stale).success).toBe(true)
      expect(stale).toMatchObject({
        status: 'stale',
        reason: { code: 'lagging-native-snapshot' },
        occupancy: { usedTokens: { value: raw.contextTokensUsed } },
      })
      expect(stale.effectiveCapacity).toBeUndefined()
      expect(stale.occupancy.percent).toBeUndefined()
    }
  })
  it('retains terminal callback provenance without advertising a launch bridge', () => {
    for (const [version, callbacks] of Object.entries(fixtures.terminal)) {
      const summary = normalizeGrokStatus(callbacks.at(-1)!, sample)!
      expect(summary.occupancy.usedTokens).toMatchObject({
        value: version === '1.0.70' ? 13025 : 12525,
        source: 'grok status-line.context_window.context_tokens',
      })
      expect(summary.occupancy.usedTokens?.value).not.toBe(24550)
    }
  })
  it('keeps inclusive cache/reasoning subsets in single-call request detail only', () => {
    const raw = frames.find((f) => 'result' in f) as { result: { _meta: { usage: unknown } } }
    const accounting = grokRequestAccounting(raw.result._meta.usage, 'request', 'probe-a')!
    expect(accounting).toMatchObject({
      input: { value: 12000 },
      output: { value: 25 },
      cacheRead: { value: 3000 },
      reasoning: { value: 7 },
    })
    expect(
      ContextDetailResult.safeParse({
        version: 1,
        status: 'available',
        sample,
        lastRequest: accounting,
      }).success,
    ).toBe(true)
    const usage = raw.result._meta.usage as Record<string, unknown>
    expect(grokRequestAccounting({ ...usage, modelCalls: 2 }, 'request', 'probe-a')).toBeUndefined()
    expect(grokRequestAccounting({ ...usage, numTurns: 2 }, 'request', 'probe-a')).toBeUndefined()
    expect(
      grokRequestAccounting({ ...usage, reasoningTokens: 26 }, 'request', 'probe-a'),
    ).toBeUndefined()
    expect(
      grokRequestAccounting({ ...usage, cachedReadTokens: 12001 }, 'request', 'probe-a'),
    ).toBeUndefined()
    expect(grokRequestAccounting(usage, 'request', 'new-requested-model')).toBeUndefined()
  })
})
