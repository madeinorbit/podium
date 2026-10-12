import { describe, expect, it } from 'vitest'
import {
  AUTO,
  agentSupportsEffort,
  allConnectorModelLabel,
  allConnectorModelOptions,
  decodeModelPick,
  effortLabel,
  effortOptionsForModel,
  encodeModelPick,
  isEffortValid,
  modelLabel,
  modelOptions,
} from './agent-models'

const liveClaude = [
  { value: 'claude-opus-4-8', label: 'Opus 4.8', efforts: ['low', 'high', 'xhigh', 'max'] },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
]

/**
 * A PICKER KNOWS THE MACHINE'S MODELS OR OFFERS ONLY AUTO (POD-3911).
 *
 * The bundled catalog used to fill the menu whenever the live list was missing,
 * so a loading or failed probe looked exactly like the machine saying
 * "Opus / Sonnet / Haiku". Nothing but the live list is offered now.
 */
describe('agent-models catalog', () => {
  it('offers only Auto for every harness until the machine reports its models', () => {
    for (const kind of ['claude-code', 'codex', 'grok', 'opencode', 'cursor', 'pi'] as const) {
      expect(modelOptions(kind)).toEqual([{ value: AUTO, label: 'Auto' }])
      expect(modelOptions(kind, [])).toEqual([{ value: AUTO, label: 'Auto' }])
    }
  })

  it('offers the live list, Auto first, when the machine has reported it', () => {
    expect(modelOptions('claude-code', liveClaude).map((o) => o.value)).toEqual([
      'auto',
      'claude-opus-4-8',
      'claude-haiku-4-5',
    ])
  })

  it('cursor has no effort flag', () => {
    expect(agentSupportsEffort('cursor')).toBe(false)
    expect(agentSupportsEffort('claude-code')).toBe(true)
  })

  it('labels live values, falls back to the raw value, Auto for the sentinel', () => {
    expect(modelLabel('claude-code', 'claude-opus-4-8', liveClaude)).toBe('Opus 4.8')
    // No live list: the stored value is shown as itself, never relabelled from a
    // bundled table the machine never confirmed.
    expect(modelLabel('claude-code', 'opus')).toBe('opus')
    expect(modelLabel('claude-code', 'auto')).toBe('Auto')
    expect(modelLabel('claude-code', '')).toBe('Auto')
    expect(modelLabel('claude-code', 'some/custom-model')).toBe('some/custom-model')
    expect(effortLabel('claude-code', 'xhigh')).toBe('Extra high')
  })

  it('isEffortValid accepts per-model rungs beyond the kind ladder', () => {
    // Unified with mobile (POD-4475): the per-KIND ladder is the floor, but
    // codex frontier models carry `max`/`ultra` — checking only the generic
    // table would silently reset a legitimate pick back to Auto.
    expect(isEffortValid('claude-code', 'max')).toBe(true)
    expect(isEffortValid('codex', 'xhigh')).toBe(true)
    expect(isEffortValid('codex', 'max')).toBe(true)
    expect(isEffortValid('codex', 'ultra')).toBe(true)
    expect(isEffortValid('codex', 'auto')).toBe(true)
    expect(isEffortValid('codex', 'off')).toBe(false)
  })
})

describe('effortOptionsForModel — effort exists only for a model the catalog describes', () => {
  it('offers no effort under an Auto model: nobody knows which model will run', () => {
    expect(effortOptionsForModel('claude-code', 'auto', liveClaude)).toEqual([])
    expect(effortOptionsForModel('codex', '')).toEqual([])
    expect(effortOptionsForModel('cursor', 'auto')).toEqual([])
  })

  it("uses the live model's own levels", () => {
    expect(
      effortOptionsForModel('claude-code', 'claude-opus-4-8', liveClaude).map((o) => o.value),
    ).toEqual(['auto', 'low', 'high', 'xhigh', 'max'])
    // A no-effort model (efforts: []) → nothing to pick.
    expect(effortOptionsForModel('claude-code', 'claude-haiku-4-5', liveClaude)).toEqual([])
  })

  it('guesses no ladder for a model the live catalog lists without levels, or not at all', () => {
    expect(
      effortOptionsForModel('grok', 'grok-composer-2.5-fast', [
        { value: 'grok-composer-2.5-fast', label: 'x' },
      ]),
    ).toEqual([])
    expect(effortOptionsForModel('codex', 'gpt-5.6-sol')).toEqual([])
    expect(effortOptionsForModel('codex', 'gpt-5.5', [])).toEqual([])
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

  it('lists only reported models, each under its connector, Auto first', () => {
    expect(allConnectorModelOptions()).toEqual([{ value: AUTO, label: 'Auto' }])
    const options = allConnectorModelOptions({
      'claude-code': liveClaude,
      grok: [{ value: 'grok-9', label: 'Grok 9' }],
    })
    expect(options[0]).toEqual({ value: AUTO, label: 'Auto' })
    expect(
      options.some((o) => o.value === 'claude-code:claude-opus-4-8' && o.group === 'Claude Code'),
    ).toBe(true)
    expect(options.some((o) => o.value === 'grok:grok-9' && o.group === 'Grok')).toBe(true)
    expect(options.some((o) => o.group === 'Codex')).toBe(false)
  })

  it('labels a pick with the connector so Opus is not anonymous', () => {
    expect(allConnectorModelLabel('claude-code', 'claude-opus-4-8', { 'claude-code': liveClaude })).toBe(
      'Claude Code · Opus 4.8',
    )
    expect(allConnectorModelLabel(undefined, AUTO)).toBe('Auto')
  })
})
