import { describe, expect, it } from 'vitest'
import {
  allConnectorModelLabel,
  allConnectorModelOptions,
  decodeModelPick,
  effortOptionsForModel,
  encodeModelPick,
  filterCatalogOptions,
  groupedCatalogOptions,
  isEffortValid,
  spawnSelection,
} from './agent-models'

describe('cross-harness model picks', () => {
  it('namespaces a model so opus on Claude and a custom opus cannot collide', () => {
    expect(encodeModelPick('claude-code', 'opus')).toBe('claude-code:opus')
    expect(decodeModelPick('claude-code:opus')).toEqual({
      agentKind: 'claude-code',
      model: 'opus',
    })
    expect(decodeModelPick('auto')).toEqual({ model: 'auto' })
  })

  it('lists every harness model under its connector, Auto first', () => {
    const options = allConnectorModelOptions()
    expect(options[0]).toEqual({ value: 'auto', label: 'Auto' })
    expect(options.some((o) => o.value === 'claude-code:opus' && o.group === 'Claude Code')).toBe(
      true,
    )
    expect(options.some((o) => o.value === 'codex:gpt-5.6-sol' && o.group === 'Codex')).toBe(true)
    expect(options.some((o) => o.value === 'grok:grok-4.5' && o.group === 'Grok')).toBe(true)
  })

  it('groups catalog options so a select can render section headers', () => {
    const groups = groupedCatalogOptions(allConnectorModelOptions())
    expect(groups[0]).toEqual({ options: [{ value: 'auto', label: 'Auto' }] })
    expect(groups.find((g) => g.label === 'Claude Code')?.options.map((o) => o.label)).toEqual([
      'Opus',
      'Sonnet',
      'Haiku',
    ])
  })

  it('hides effort for haiku and keeps the Claude ladder for opus', () => {
    expect(effortOptionsForModel('claude-code', 'haiku')).toEqual([])
    expect(effortOptionsForModel('claude-code', 'opus').map((o) => o.value)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('keeps current Codex reasoning levels in the offline fallback', () => {
    expect(effortOptionsForModel('codex', 'gpt-5.6-sol').map((o) => o.value)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ])
  })

  it('omits auto sentinels from the spawn payload', () => {
    expect(spawnSelection('auto', 'auto')).toEqual({})
    expect(spawnSelection('claude-code:opus', 'high')).toEqual({
      agentKind: 'claude-code',
      model: 'opus',
      effort: 'high',
    })
  })

  it('lets the LIVE catalog replace a harness list rather than merge with it', () => {
    // The whole point of the probe: a machine that installed a model after this
    // bundle was built must be able to offer it, and one that dropped a model
    // must stop offering it.
    const live = { grok: [{ value: 'grok-9', label: 'Grok 9' }] }
    const options = allConnectorModelOptions(live)
    expect(options.some((o) => o.value === 'grok:grok-9')).toBe(true)
    expect(options.some((o) => o.value === 'grok:grok-4.5')).toBe(false)
    expect(allConnectorModelLabel('grok', 'grok-9', live)).toBe('Grok · Grok 9')
  })

  it('accepts an effort a live model declares even when the harness table omits it', () => {
    const live = { grok: [{ value: 'grok-9', label: 'Grok 9', efforts: ['ultra'] }] }
    expect(isEffortValid('grok', 'ultra')).toBe(false)
    expect(isEffortValid('grok', 'ultra', live.grok)).toBe(true)
  })

  it('filters on the harness name as well as the model, ignoring separators', () => {
    const options = allConnectorModelOptions()
    // "claude" is a harness name for one group and a model name inside another,
    // and both are what someone typing it is looking for.
    const claude = filterCatalogOptions(options, 'claude').map((o) => o.value)
    expect(claude).toContain('claude-code:opus')
    expect(claude).toContain('opencode:anthropic/claude-opus-4-8')
    expect(claude).not.toContain('codex:gpt-5.5')
    // Nobody types the hyphens on a phone keyboard.
    expect(filterCatalogOptions(options, 'gpt 5.5').map((o) => o.value)).toContain('codex:gpt-5.5')
    expect(filterCatalogOptions(options, '')).toHaveLength(options.length)
    expect(filterCatalogOptions(options, 'nothing-like-this')).toEqual([])
  })
})
