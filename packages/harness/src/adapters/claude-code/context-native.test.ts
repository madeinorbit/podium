import { ContextDetailResult, ContextSummary } from '@podium/model'
import { describe, expect, it } from 'vitest'
import fixtures from './__fixtures__/context-reports.json' with { type: 'json' }
import {
  claudeComposition,
  claudeContextVersion,
  claudeRequestAccounting,
  normalizeClaudeControl,
  normalizeClaudeStatus,
} from './context-native.js'

const sample = {
  id: 'captured',
  at: '2026-11-21T12:00:00.000Z',
  bindingVersion: 1,
  observerGeneration: 1,
  turnEpoch: 1,
  contextRevision: 0,
  nativeSessionId: 'primary',
}
const control = fixtures.control['engine-2.1.319/after-2-summary']

describe('captured Claude context reports', () => {
  for (const [name, raw] of Object.entries(fixtures.control)) {
    it(`normalizes ${name} without treating API output as occupancy`, () => {
      const normalized = normalizeClaudeControl(raw, sample)!
      expect(ContextSummary.safeParse(normalized.summary).success).toBe(true)
      expect(normalized.summary.occupancy.usedTokens?.value).toBe(raw.totalTokens)
      expect(normalized.summary.occupancy.usedTokens?.accuracy).toBe('estimated')
      expect(normalized.summary.modelCapacity).toBeUndefined()
      if (normalized.composition) {
        expect(
          ContextDetailResult.safeParse({
            version: 1,
            status: 'available',
            sample,
            composition: normalized.composition,
          }).success,
        ).toBe(true)
        const used = normalized.composition.rows
          .filter((row) => row.kind === 'used' && !row.parentId)
          .reduce((sum, row) => sum + row.tokens!.value, 0)
        expect(used).toBe(raw.totalTokens)
      }
    })
  }
  it('keeps input/cache/output separate from semantic composition', () => {
    const value = normalizeClaudeControl(control, sample)!
    expect(value.summary.occupancy.usedTokens?.value).toBe(24000)
    expect(value.summary.occupancy.percent?.value).toBe(2)
    expect(value.lastRequest).toMatchObject({
      input: { value: 24000 },
      output: { value: 6000 },
      cacheRead: { value: 8000 },
      cacheWrite: { value: 4000 },
    })
    expect(value.lastRequest?.reasoning).toBeUndefined()
    expect(value.composition?.coverage).toBe('partial')
    expect(
      value.composition?.rows.find((row) => row.attribution === 'unattributed')?.tokens?.value,
    ).toBe(23671)
  })
  it('marks configured policy window and reserve without calling it a model maximum', () => {
    const value = normalizeClaudeControl(
      fixtures.control['engine-deferred-configured-2.1.319/after-1-summary'],
      sample,
    )!
    expect(value.summary.effectiveCapacity).toMatchObject({ value: 100000, basis: 'configured' })
    expect(value.summary.compaction).toMatchObject({
      source: 'settings',
      thresholdTokens: { value: 67000 },
      reserveTokens: { value: 33000 },
    })
    expect(value.summary.modelCapacity).toBeUndefined()
    expect(value.composition?.rows.find((row) => row.id === 'mcp_tools_deferred')).toMatchObject({
      kind: 'excluded',
      tokens: { value: 163 },
    })
    const files = value.composition?.rows.filter((row) => row.parentId === 'memory_files')
    expect(files?.map((row) => row.tokens?.value)).toEqual([17, 19])
    expect(value.composition?.rows.find((row) => row.id === 'memory_files')?.childrenCoverage).toBe(
      'complete',
    )
  })
  it('does not promise exact counts for full, including silent tokenizer fallback', () => {
    const full = normalizeClaudeControl(
      fixtures.control['engine-no-count-confirmed-2.1.319/after-1-full'],
      sample,
    )!
    expect(full.summary.occupancy.usedTokens?.accuracy).toBe('estimated')
    expect(full.composition?.rows.every((row) => row.tokens?.accuracy === 'estimated')).toBe(true)
  })
  it('does not manufacture current request usage after compaction', () => {
    const value = normalizeClaudeControl(
      fixtures.control['engine-2.1.319/after-compact-summary'],
      sample,
    )!
    expect(value.summary.occupancy.usedTokens?.value).toBe(647)
    expect(value.lastRequest).toBeUndefined()
  })
  it('preserves over-capacity percentage and remaining-space semantics', () => {
    const value = normalizeClaudeControl(
      { totalTokens: 250, maxTokens: 200, percentage: 125 },
      sample,
    )!
    expect(value.summary.occupancy.percent?.value).toBe(125)
    expect(value.summary.occupancy.remainingTokens?.value).toBe(0)
    expect(ContextSummary.safeParse(value.summary).success).toBe(true)
  })
  it.each([
    NaN,
    Infinity,
    -1,
    null,
    '200',
    undefined,
  ])('rejects malformed total %s', (totalTokens) => {
    expect(normalizeClaudeControl({ ...control, totalTokens }, sample)).toBeUndefined()
  })
  it('omits unknown/invalid optional fields without inventing capacity or accounting', () => {
    const value = normalizeClaudeControl(
      { totalTokens: 0, maxTokens: 0, rawMaxTokens: 1000000, apiUsage: null },
      sample,
    )!
    expect(value.summary.occupancy.usedTokens?.value).toBe(0)
    expect(value.summary.effectiveCapacity).toBeUndefined()
    expect(value.summary.modelCapacity).toBeUndefined()
    expect(value.summary.occupancy.percent).toBeUndefined()
    expect(value.composition).toBeUndefined()
    expect(claudeRequestAccounting({ input_tokens: 10, output_tokens: 0 })).toMatchObject({
      output: { value: 0 },
    })
    expect(claudeRequestAccounting({ input_tokens: 10, output_tokens: 0 })?.input).toBeUndefined()
  })
  it('requires native category IDs/kinds rather than guessing from names', () => {
    expect(
      claudeComposition({ categories: [{ name: 'System prompt', tokens: 12 }] }, 12),
    ).toBeUndefined()
    const value = claudeComposition(
      {
        categories: [
          { id: 'future_category', kind: 'used', tokens: 12 },
          { id: 'unknown', kind: 'future', tokens: 1 },
        ],
      },
      12,
    )!
    expect(value.coverage).toBe('partial')
    expect(value.rows[0]?.category).toBe('other')
  })
  it('declares complete only when roots and children reconcile', () => {
    const value = claudeComposition(
      {
        categories: [
          { id: 'memory_files', kind: 'used', tokens: 12 },
          { id: 'free_space', kind: 'free', tokens: 20 },
          { id: 'autocompact_buffer', kind: 'buffer', tokens: 3 },
        ],
        memoryFiles: [{ path: '<PROJECT>/CLAUDE.md', tokens: 12 }],
      },
      12,
    )!
    expect(value.coverage).toBe('complete')
    expect(value.rows).toHaveLength(4)
    expect(
      claudeComposition(
        {
          categories: [{ id: 'memory_files', kind: 'used', tokens: 12 }],
          memoryFiles: [{ path: 'file', tokens: 13 }],
        },
        12,
      )?.coverage,
    ).toBe('partial')
  })
  it('bounds detail rows without orphaning children or claiming full attribution', () => {
    const value = claudeComposition(
      fixtures.control['engine-deferred-configured-2.1.319/after-1-summary'],
      21000,
      12,
    )!
    expect(value.rows).toHaveLength(12)
    expect(value.truncated).toBe(true)
    expect(value.coverage).toBe('partial')
  })
  it('normalizes the terminal input-only rounded percentage without adding output', () => {
    const value = normalizeClaudeStatus(fixtures.terminal['after-2'], sample)!
    expect(value.summary.occupancy).toMatchObject({
      basis: 'last-request',
      usedTokens: { value: 24000 },
      percent: { value: 12 },
      remainingTokens: { value: 176000 },
    })
    expect(value.summary.effectiveCapacity?.value).toBe(200000)
    expect(value.summary.modelCapacity).toBeUndefined()
    expect(value.summary.compaction).toBeUndefined()
    expect(value.composition).toBeUndefined()
    expect(value.lastRequest?.reasoning).toBeUndefined()
    expect(
      normalizeClaudeStatus(fixtures.terminal['after-1'], sample)?.summary.occupancy.percent?.value,
    ).toBe(11)
    expect(normalizeClaudeStatus(fixtures.terminal.fresh, sample)).toBeUndefined()
  })
  it('does not inherit support from a model name or an SDK version', () => {
    expect(claudeContextVersion('2.1.319')).toBe(true)
    expect(claudeContextVersion('2.1.330')).toBe(true)
    for (const version of ['', '0.3.304', '2.1.318', '3.0.0', undefined]) {
      expect(claudeContextVersion(version)).toBe(false)
      expect(
        normalizeClaudeStatus({ ...fixtures.terminal['after-2'], version }, sample),
      ).toBeUndefined()
    }
  })
})
