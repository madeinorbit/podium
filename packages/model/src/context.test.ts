import { describe, expect, it } from 'vitest'
import {
  CONTEXT_MAX_ROWS,
  ContextCapacity,
  ContextComposition,
  ContextLastRequest,
  ContextQuantity,
  ContextSampleIdentity,
  ContextSummary,
  contextUsagePercentOf,
  invalidateContextSummary,
  sameContextSample,
} from './context'
import { SessionConditionLive } from './records/live-payloads'

const q = (value: number) => ({
  value,
  accuracy: 'reported' as const,
  source: 'synthetic native observation',
})
const revision = { bindingVersion: 2, observerGeneration: 3, contextRevision: 4, turnEpoch: 5 }
const sample = {
  ...revision,
  id: 'sample-1',
  at: '2026-11-21T10:00:00.000Z',
  turnRevision: 'request-1',
}
const summary = (used = 0, percent = 0): ContextSummary => ({
  version: 1,
  status: 'available',
  sample,
  occupancy: { basis: 'current-context', usedTokens: q(used), percent: q(percent) },
})
const row = (
  id: string,
  tokens: number,
  kind: 'used' | 'reserve' | 'free' | 'excluded' | 'deferred' = 'used',
) => ({
  id,
  label: id,
  category: 'messages',
  kind,
  attribution: 'category' as const,
  tokens: q(tokens),
})

describe('context measurement vocabulary', () => {
  it('accepts measured zero and retains over-capacity counts and percentages', () => {
    expect(ContextSummary.parse(summary()).status).toBe('available')
    const value = { ...summary(120, 120), effectiveCapacity: { ...q(100), basis: 'configured' } }
    expect(ContextSummary.parse(value)).toEqual(value)
    expect(contextUsagePercentOf(ContextSummary.parse(value))).toBe(120)
  })
  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('rejects invalid measurement %s', (value) => {
    expect(ContextQuantity.safeParse(q(value)).success).toBe(false)
  })
  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects nonpositive/nonfinite capacity %s', (value) => {
    expect(ContextCapacity.safeParse({ ...q(value), basis: 'native' }).success).toBe(false)
  })
  it('accepts count-only, percentage-only, and independently estimated quantities', () => {
    for (const occupancy of [
      { basis: 'last-request', usedTokens: q(13_000) },
      { basis: 'current-context', percent: q(0) },
      { basis: 'native-estimate', usedTokens: { ...q(647), accuracy: 'estimated' } },
    ])
      expect(ContextSummary.safeParse({ ...summary(), occupancy }).success).toBe(true)
    expect(
      ContextSummary.safeParse({ ...summary(), occupancy: { basis: 'current-context' } }).success,
    ).toBe(false)
  })
  it('does not derive counts, capacity or an exact ratio from a rounded percentage', () => {
    const value = ContextSummary.parse({
      ...summary(),
      occupancy: { basis: 'current-context', percent: q(13) },
    })
    expect(value).not.toHaveProperty('effectiveCapacity')
    expect(value).not.toHaveProperty('occupancy.usedTokens')
    expect(contextUsagePercentOf(value)).toBe(13)
  })
  it('keeps effective capacity, model capacity and compaction policy separate', () => {
    const value = ContextSummary.parse({
      ...summary(21_000, 21),
      effectiveCapacity: { ...q(100_000), basis: 'configured' },
      modelCapacity: { ...q(1_000_000), basis: 'model-metadata' },
      compaction: { source: 'native policy', thresholdTokens: q(67_000), reserveTokens: q(33_000) },
    })
    expect(value).toHaveProperty('occupancy.usedTokens.value', 21_000)
    expect(value).toHaveProperty('effectiveCapacity.value', 100_000)
    expect(value).toHaveProperty('modelCapacity.value', 1_000_000)
  })
  it('accepts pending, unavailable and unsupported without manufacturing zeros', () => {
    const reason = { code: 'no-sample', message: 'No valid measurement is available' }
    for (const status of ['pending', 'unavailable', 'unsupported']) {
      const value = ContextSummary.parse({ version: 1, status, revision, reason })
      expect(value).not.toHaveProperty('occupancy')
      expect(contextUsagePercentOf(value)).toBeUndefined()
    }
    expect(
      ContextSummary.safeParse({
        version: 1,
        status: 'unsupported',
        reason: { code: '', message: ' ' },
      }).success,
    ).toBe(false)
  })
  it('retains known model/capacity metadata while waiting for occupancy', () => {
    const value = ContextSummary.parse({
      version: 1,
      status: 'pending',
      revision,
      reason: { code: 'waiting', message: 'No main response yet' },
      model: { modelId: 'synthetic-model' },
      effectiveCapacity: { ...q(32_000), basis: 'configured' },
    })
    expect(value).toHaveProperty('effectiveCapacity.value', 32_000)
    expect(value).not.toHaveProperty('occupancy')
    expect(contextUsagePercentOf(value)).toBeUndefined()
  })
  it('pins every sample identity component and freezes parsed identities', () => {
    const parsed = ContextSampleIdentity.parse(sample)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(sameContextSample(parsed, { ...sample })).toBe(true)
    for (const changed of [
      { id: 'sample-2' },
      { at: '2026-11-21T10:00:01.000Z' },
      { bindingVersion: 3 },
      { observerGeneration: 4 },
      { turnEpoch: 6 },
      { turnRevision: 'request-2' },
      { contextRevision: 5 },
      { nativeSessionId: 'another-session' },
      { nativeSampleId: 'another-native-sample' },
    ])
      expect(sameContextSample(parsed, { ...sample, ...changed })).toBe(false)
  })
  it.each([
    'model-changed',
    'compaction',
    'reset',
    'rewind',
    'fork',
    'resume',
    'binding-changed',
  ] as const)('explicitly clears at %s boundaries', (cause) => {
    const result = invalidateContextSummary(summary(42, 21), cause, {
      ...revision,
      contextRevision: 5,
    })
    expect(result).toMatchObject({
      status: 'pending',
      invalidation: { cause, previousSample: sample },
    })
    expect(result).not.toHaveProperty('occupancy')
    expect(contextUsagePercentOf(result)).toBeUndefined()
    expect(() => invalidateContextSummary(summary(), cause, revision)).toThrow(
      'advance contextRevision',
    )
  })
  it('preserves old percentage peers but refuses an independent percentage beside normalized data', () => {
    const live = { busy: false, requestsGated: 0 }
    expect(SessionConditionLive.parse({ ...live, contextUsagePercent: 35 })).toHaveProperty(
      'contextUsagePercent',
      35,
    )
    expect(
      SessionConditionLive.safeParse({
        ...live,
        context: summary(120, 120),
        contextUsagePercent: 120,
      }).success,
    ).toBe(true)
    expect(
      SessionConditionLive.safeParse({ ...live, context: summary(10, 5), contextUsagePercent: 35 })
        .success,
    ).toBe(false)
    const clear = invalidateContextSummary(summary(), 'reset', { ...revision, contextRevision: 5 })
    expect(
      SessionConditionLive.safeParse({ ...live, context: clear, contextUsagePercent: 0 }).success,
    ).toBe(false)
  })
})

describe('normalized request accounting', () => {
  it('cache directions partition input subsets and reasoning is within output', () => {
    const value = {
      input: q(12_000),
      cacheRead: q(4_000),
      cacheWrite: q(500),
      output: q(1_000),
      reasoning: q(300),
    }
    expect(ContextLastRequest.parse(value)).toEqual(value)
    expect(ContextLastRequest.safeParse({ ...value, cacheWrite: q(8_001) }).success).toBe(false)
    expect(ContextLastRequest.safeParse({ ...value, reasoning: q(1_001) }).success).toBe(false)
  })
  it('retains partial subcounts when their parent is unknown and accepts measured zero', () => {
    expect(ContextLastRequest.parse({ cacheRead: q(3_000) })).not.toHaveProperty('input')
    expect(ContextLastRequest.parse({ reasoning: q(0) })).not.toHaveProperty('output')
    expect(ContextLastRequest.safeParse({}).success).toBe(false)
  })
})

describe('optional semantic composition', () => {
  it('counts used roots once; children and non-used rows never add occupancy', () => {
    const rows = [
      { ...row('messages', 80), childrenCoverage: 'complete' },
      { ...row('user', 30), parentId: 'messages', attribution: 'item' },
      { ...row('assistant', 50), parentId: 'messages', attribution: 'item' },
      row('system', 20),
      row('reserve', 33, 'reserve'),
      row('free', 900, 'free'),
      row('excluded', 163, 'excluded'),
      row('deferred', 400, 'deferred'),
    ]
    expect(
      ContextComposition.safeParse({
        coverage: 'complete',
        usedTokens: q(100),
        rows,
        truncated: false,
      }).success,
    ).toBe(true)
    expect(
      ContextComposition.safeParse({
        coverage: 'complete',
        usedTokens: q(180),
        rows,
        truncated: false,
      }).success,
    ).toBe(false)
  })
  it('keeps unknown, partial and unattributed rows honest', () => {
    const rows = [
      { ...row('messages', 80), childrenCoverage: 'partial' },
      { ...row('unknown', 30), parentId: 'messages', attribution: 'unattributed' },
    ]
    expect(
      ContextComposition.safeParse({
        coverage: 'partial',
        usedTokens: q(100),
        rows,
        truncated: false,
      }).success,
    ).toBe(true)
    expect(
      ContextComposition.safeParse({
        coverage: 'complete',
        usedTokens: q(80),
        rows,
        truncated: false,
      }).success,
    ).toBe(false)
    expect(
      ContextComposition.safeParse({
        coverage: 'unknown',
        rows: [{ ...row('messages', 0), tokens: undefined }],
        truncated: false,
      }).success,
    ).toBe(true)
    expect(
      ContextComposition.safeParse({
        coverage: 'complete',
        usedTokens: q(0),
        rows: [{ ...row('messages', 0), tokens: undefined }],
        truncated: false,
      }).success,
    ).toBe(false)
  })
  it('rejects cycles, missing parents, wrong-kind children and duplicate attribution', () => {
    for (const rows of [
      [{ ...row('a', 10), parentId: 'a' }],
      [{ ...row('a', 10), parentId: 'missing' }],
      [
        { ...row('a', 10), childrenCoverage: 'partial' },
        { ...row('b', 5, 'free'), parentId: 'a' },
      ],
      [row('a', 10), row('a', 10)],
      [
        { ...row('a', 10), childrenCoverage: 'partial' },
        { ...row('b', 11), parentId: 'a' },
      ],
    ])
      expect(
        ContextComposition.safeParse({ coverage: 'partial', rows, truncated: false }).success,
      ).toBe(false)
  })
  it('bounds total rows and depth and does not claim truncation is complete', () => {
    const rows = Array.from({ length: CONTEXT_MAX_ROWS + 1 }, (_, i) => row(`row-${i}`, 1))
    expect(
      ContextComposition.safeParse({ coverage: 'partial', rows, truncated: true }).success,
    ).toBe(false)
    const deep = Array.from({ length: 5 }, (_, i) => ({
      ...row(`row-${i}`, 1),
      parentId: i ? `row-${i - 1}` : undefined,
      childrenCoverage: 'partial',
    }))
    expect(
      ContextComposition.safeParse({ coverage: 'partial', rows: deep, truncated: false }).success,
    ).toBe(false)
    expect(
      ContextComposition.safeParse({
        coverage: 'complete',
        usedTokens: q(1),
        rows: [row('a', 1)],
        truncated: true,
      }).success,
    ).toBe(false)
  })
})
