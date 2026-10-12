import { DEFAULT_HARNESS_AGENT } from '@podium/model/browser'
import { describe, expect, it, vi } from 'vitest'
import {
  AUTO,
  draftForReportedModels,
  filterCatalogOptions,
  groupedCatalogOptions,
  issueDefaultAgentKind,
  agentDescriptors,
  issueAgentOptions,
  issueAgentLabel,
  spawnSelection,
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

describe('the pills follow the machine\'s model list (POD-3911)', () => {
  const reported = [
    { value: 'gpt-5.6-sol', efforts: ['low', 'high'] },
    { value: 'gpt-5.5' },
  ]
  const draft = (model: string, effort: string) => ({ model, effort })

  it('puts a model the machine does not list back to Auto, effort with it', () => {
    expect(draftForReportedModels(draft('gpt-4-retired', 'high'), reported)).toEqual(
      draft('auto', 'auto'),
    )
  })

  it('keeps a listed model and an effort the list names for it', () => {
    expect(draftForReportedModels(draft('gpt-5.6-sol', 'high'), reported)).toBeUndefined()
  })

  it('drops an effort the listed model does not name, or names none for', () => {
    expect(draftForReportedModels(draft('gpt-5.6-sol', 'xhigh'), reported)).toEqual(
      draft('gpt-5.6-sol', 'auto'),
    )
    expect(draftForReportedModels(draft('gpt-5.5', 'high'), reported)).toEqual(
      draft('gpt-5.5', 'auto'),
    )
  })

  it('drops an effort under an Auto model, whatever the list says', () => {
    expect(draftForReportedModels(draft('auto', 'high'), undefined)).toEqual(draft('auto', 'auto'))
  })

  it('changes nothing about a concrete model until the list has arrived', () => {
    expect(draftForReportedModels(draft('gpt-4-retired', 'high'), undefined)).toBeUndefined()
    expect(draftForReportedModels(draft('gpt-4-retired', 'high'), [])).toBeUndefined()
  })
})


it('returns the same live-only model and concrete-model effort contract for every harness', () => {
  for (const descriptor of agentDescriptors(undefined)) {
    const live = [
      { value: 'reported', label: 'Reported', efforts: ['high'] },
      { value: 'no-levels', label: 'No levels', efforts: [] },
      { value: 'unknown-levels', label: 'Unknown levels' },
    ]
    expect(modelOptions(descriptor.kind, live).map(option => option.value)).toEqual(['auto', 'reported', 'no-levels', 'unknown-levels'])
    for (const model of ['auto', 'no-levels', 'unknown-levels', 'stored']) {
      expect(effortOptionsForModel(descriptor.kind, model, live)).toEqual([])
      expect(effortLabel(descriptor.kind, 'high')).toBe('High')
    }
    expect(effortOptionsForModel(descriptor.kind, 'reported', live).map(option => option.value)).toEqual(descriptor.capabilities.effort ? ['auto', 'high'] : [])
  }
})

it('shares default harness labels and option ordering independently of registry order', () => {
  expect(issueAgentLabel(undefined)).toBe('Claude Code')
  expect(issueAgentOptions(undefined)[0]).toEqual({ value: '', label: 'Claude Code (default)' })
  expect(issueAgentOptions('codex').filter(option => option.value === 'codex')).toEqual([])
})
