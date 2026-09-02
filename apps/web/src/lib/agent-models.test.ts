import { describe, expect, it } from 'vitest'
import {
  AUTO,
  agentSupportsEffort,
  allConnectorModelLabel,
  allConnectorModelOptions,
  decodeModelPick,
  effortLabel,
  effortOptions,
  effortOptionsForModel,
  encodeModelPick,
  isEffortValid,
  modelLabel,
  modelOptions,
} from './agent-models'

describe('agent-models catalog', () => {
  it('lists Auto first for every agent (model + effort)', () => {
    for (const kind of ['claude-code', 'codex', 'grok', 'opencode', 'cursor', 'pi'] as const) {
      expect(modelOptions(kind)[0]).toEqual({ value: AUTO, label: 'Auto' })
      expect(effortOptions(kind)[0]).toEqual({ value: AUTO, label: 'Auto' })
    }
  })

  it('exposes real per-agent models beyond auto', () => {
    expect(modelOptions('claude-code').map((o) => o.value)).toContain('opus')
    expect(modelOptions('codex').map((o) => o.value)).toContain('gpt-5.6-sol')
  })

  it('scopes effort ladders per agent', () => {
    expect(effortOptions('claude-code').map((o) => o.value)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    // Codex effort (verified via `codex debug models`): low → xhigh, no minimal.
    expect(effortOptions('codex').map((o) => o.value)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    // opencode --variant: minimal → max.
    expect(effortOptions('opencode').map((o) => o.value)).toEqual([
      'auto',
      'minimal',
      'low',
      'medium',
      'high',
      'max',
    ])
  })

  it('cursor has no effort flag', () => {
    expect(agentSupportsEffort('cursor')).toBe(false)
    expect(agentSupportsEffort('claude-code')).toBe(true)
    // Only the auto sentinel is offered.
    expect(effortOptions('cursor')).toEqual([{ value: AUTO, label: 'Auto' }])
  })

  it('labels known values, falls back to raw for custom, Auto for the sentinel', () => {
    expect(modelLabel('claude-code', 'opus')).toBe('Opus')
    expect(modelLabel('claude-code', 'auto')).toBe('Auto')
    expect(modelLabel('claude-code', '')).toBe('Auto')
    expect(modelLabel('claude-code', 'some/custom-model')).toBe('some/custom-model')
    expect(effortLabel('claude-code', 'xhigh')).toBe('Extra high')
  })

  it('isEffortValid rejects an out-of-ladder value (codex tops at xhigh, no max)', () => {
    expect(isEffortValid('claude-code', 'max')).toBe(true)
    expect(isEffortValid('codex', 'xhigh')).toBe(true)
    expect(isEffortValid('codex', 'max')).toBe(false)
    expect(isEffortValid('codex', 'auto')).toBe(true)
  })
})

describe('effortOptionsForModel — effort follows the selected model', () => {
  it('auto model → the full agent effort ladder', () => {
    expect(effortOptionsForModel('claude-code', 'auto').map((o) => o.value)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(effortOptionsForModel('codex', '').map((o) => o.value)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(effortOptionsForModel('cursor', 'auto')).toEqual([])
  })

  it("uses the live model's authoritative per-model efforts", () => {
    const live = [
      { value: 'claude-opus-4-8', label: 'Opus', efforts: ['low', 'high', 'xhigh', 'max'] },
      { value: 'claude-haiku-4-5', label: 'Haiku', efforts: [] },
    ]
    expect(
      effortOptionsForModel('claude-code', 'claude-opus-4-8', live).map((o) => o.value),
    ).toEqual(['auto', 'low', 'high', 'xhigh', 'max'])
    // A no-effort model (efforts: []) → nothing to pick → hidden.
    expect(effortOptionsForModel('claude-code', 'claude-haiku-4-5', live)).toEqual([])
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

  it('falls back to the verified agent ladder when per-model data is unavailable', () => {
    expect(
      effortOptionsForModel('grok', 'grok-composer-2.5-fast', [
        { value: 'grok-composer-2.5-fast', label: 'x' },
      ]).map((o) => o.value),
    ).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(
      effortOptionsForModel('cursor', 'composer-2.5', [{ value: 'composer-2.5', label: 'x' }]),
    ).toEqual([])
    expect(effortOptionsForModel('codex', 'gpt-5.5', []).map((o) => o.value)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })
})

describe('cross-connector model picks', () => {
  it('namespaces a concrete pick and leaves Auto bare', () => {
    expect(encodeModelPick('claude-code', 'opus')).toBe('claude-code:opus')
    expect(encodeModelPick('opencode', 'openai/gpt-5.5')).toBe('opencode:openai/gpt-5.5')
    expect(encodeModelPick('grok', AUTO)).toBe(AUTO)
    expect(decodeModelPick('claude-code:opus')).toEqual({ agentKind: 'claude-code', model: 'opus' })
    expect(decodeModelPick('opencode:openai/gpt-5.5')).toEqual({
      agentKind: 'opencode',
      model: 'openai/gpt-5.5',
    })
    expect(decodeModelPick(AUTO)).toEqual({ model: AUTO })
    expect(decodeModelPick('bare-slug')).toEqual({ model: 'bare-slug' })
  })

  it('lists every connector under its own group, Auto first', () => {
    const options = allConnectorModelOptions()
    expect(options[0]).toEqual({ value: AUTO, label: 'Auto' })
    expect(options.some((o) => o.value === 'claude-code:opus' && o.group === 'Claude Code')).toBe(
      true,
    )
    expect(options.some((o) => o.value === 'codex:gpt-5.6-sol' && o.group === 'Codex')).toBe(true)
    expect(options.some((o) => o.value === 'grok:grok-4.5' && o.group === 'Grok')).toBe(true)
  })

  it('labels a pick with the connector so Opus is not anonymous', () => {
    expect(allConnectorModelLabel('claude-code', 'opus')).toBe('Claude Code · Opus')
    expect(allConnectorModelLabel(undefined, AUTO)).toBe('Auto')
  })
})
