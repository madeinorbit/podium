import { DEFAULT_HARNESS_AGENT } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  allConnectorModelLabel,
  allConnectorModelOptions,
  decodeModelPick,
  effortOptionsForModel,
  encodeModelPick,
  filterCatalogOptions,
  groupedCatalogOptions,
  isEffortValid,
  issueDefaultAgentKind,
  spawnSelection,
} from './agent-models'

/**
 * A reordered registry: codex — not claude-code — is the first row
 * (POD-4737). Only the `BUNDLED_DESCRIPTORS` export is replaced; every
 * function (notably `resolveDescriptors`, whose bundled fallback stays the
 * real one) is the original, so the rest of this file still exercises the
 * true registry while `ISSUE_AGENT_KINDS` reads codex-first.
 */
vi.mock('@podium/harness/browser', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  BUNDLED_DESCRIPTORS: [
    { kind: 'codex' },
    { kind: 'claude-code' },
    { kind: 'grok' },
    { kind: 'opencode' },
    { kind: 'cursor' },
    { kind: 'pi' },
  ],
}))

describe('cross-harness model picks', () => {
  /**
   * The phone's default IS the named product policy (POD-4737) — not the
   * registry's first row, so reordering the registry can never silently
   * change the default and the two can never drift. Proved by the mock
   * above: the positional fallback (`ISSUE_AGENT_KINDS[0]`) would answer
   * 'codex' here, and this test goes red under it.
   */
  it('defaults to the named product default regardless of registry order', () => {
    expect(issueDefaultAgentKind(undefined)).toBe(DEFAULT_HARNESS_AGENT)
    expect(issueDefaultAgentKind(null)).toBe(DEFAULT_HARNESS_AGENT)
    expect(issueDefaultAgentKind('codex')).toBe('codex')
    expect(issueDefaultAgentKind('no-such-harness')).toBe(DEFAULT_HARNESS_AGENT)
  })

  it('namespaces a model so opus on Claude and a custom opus cannot collide', () => {
    expect(encodeModelPick('claude-code', 'opus')).toBe('claude-code:opus')
    expect(decodeModelPick('claude-code:opus')).toEqual({
      agentKind: 'claude-code',
      model: 'opus',
    })
    expect(decodeModelPick('auto')).toEqual({ model: 'auto' })
  })

  // A picker offers what the machine reported, or only Auto (POD-3911): the
  // bundled lists are not offered, so a loading or failed probe no longer
  // looks like the machine saying "Opus / Sonnet / Haiku".
  const live = {
    'claude-code': [
      { value: 'claude-opus-4-8', label: 'Opus 4.8', efforts: ['low', 'high', 'max'] },
      { value: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
    ],
    codex: [{ value: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'high'] }],
    opencode: [{ value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8' }],
  }

  it('offers only Auto when no machine has reported models', () => {
    expect(allConnectorModelOptions()).toEqual([{ value: 'auto', label: 'Auto' }])
  })

  it('lists every reported model under its connector, Auto first', () => {
    const options = allConnectorModelOptions(live)
    expect(options[0]).toEqual({ value: 'auto', label: 'Auto' })
    expect(
      options.some((o) => o.value === 'claude-code:claude-opus-4-8' && o.group === 'Claude Code'),
    ).toBe(true)
    expect(options.some((o) => o.value === 'codex:gpt-5.5' && o.group === 'Codex')).toBe(true)
    expect(options.some((o) => o.group === 'Grok')).toBe(false)
  })

  it('groups catalog options so a select can render section headers', () => {
    const groups = groupedCatalogOptions(allConnectorModelOptions(live))
    expect(groups[0]).toEqual({ options: [{ value: 'auto', label: 'Auto' }] })
    expect(groups.find((g) => g.label === 'Claude Code')?.options.map((o) => o.label)).toEqual([
      'Opus 4.8',
      'Haiku 4.5',
    ])
  })

  it("offers a model's own effort levels, and none for Auto or an undescribed model", () => {
    expect(effortOptionsForModel('claude-code', 'claude-haiku-4-5', live['claude-code'])).toEqual([])
    expect(
      effortOptionsForModel('claude-code', 'claude-opus-4-8', live['claude-code']).map(
        (o) => o.value,
      ),
    ).toEqual(['auto', 'low', 'high', 'max'])
    expect(effortOptionsForModel('claude-code', 'auto', live['claude-code'])).toEqual([])
    expect(effortOptionsForModel('codex', 'gpt-5.6-sol')).toEqual([])
  })

  it('omits auto sentinels from the spawn payload', () => {
    expect(spawnSelection('auto', 'auto')).toEqual({})
    expect(spawnSelection('claude-code:opus', 'high')).toEqual({
      agentKind: 'claude-code',
      model: 'opus',
      effort: 'high',
    })
  })

  it('offers exactly the LIVE list, never merged with the bundled one', () => {
    // The whole point of the probe: a machine that installed a model after this
    // bundle was built must be able to offer it, and one that dropped a model
    // must stop offering it.
    const grokOnly = { grok: [{ value: 'grok-9', label: 'Grok 9' }] }
    const options = allConnectorModelOptions(grokOnly)
    expect(options.some((o) => o.value === 'grok:grok-9')).toBe(true)
    expect(options.some((o) => o.value === 'grok:grok-4.5')).toBe(false)
    expect(allConnectorModelLabel('grok', 'grok-9', grokOnly)).toBe('Grok · Grok 9')
  })

  it('accepts an effort a live model declares even when the harness table omits it', () => {
    const grok = [{ value: 'grok-9', label: 'Grok 9', efforts: ['ultra'] }]
    expect(isEffortValid('grok', 'ultra')).toBe(false)
    expect(isEffortValid('grok', 'ultra', grok)).toBe(true)
  })

  it('filters on the harness name as well as the model, ignoring separators', () => {
    const options = allConnectorModelOptions(live)
    // "claude" is a harness name for one group and a model name inside another,
    // and both are what someone typing it is looking for.
    const claude = filterCatalogOptions(options, 'claude').map((o) => o.value)
    expect(claude).toContain('claude-code:claude-opus-4-8')
    expect(claude).toContain('opencode:anthropic/claude-opus-4-8')
    expect(claude).not.toContain('codex:gpt-5.5')
    // Nobody types the hyphens on a phone keyboard.
    expect(filterCatalogOptions(options, 'gpt 5.5').map((o) => o.value)).toContain('codex:gpt-5.5')
    expect(filterCatalogOptions(options, '')).toHaveLength(options.length)
    expect(filterCatalogOptions(options, 'nothing-like-this')).toEqual([])
  })
})
