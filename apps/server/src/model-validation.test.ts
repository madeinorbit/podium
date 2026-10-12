import { asMachineId, type UserId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import type { ModelCatalogSnapshot } from './model-catalog'
import {
  assertModelSelectionValid,
  formatModelValidationProblem,
  ModelValidationError,
  validateModelSelection,
  vetLaunchSelection,
} from './model-validation'
import { SessionLaunchConfig } from './modules/sessions/launch-config'

const catalog: ModelCatalogSnapshot = {
  machineId: asMachineId('test-machine'),
  fetchedAt: 1_000_000,
  byAgent: {
    codex: [
      { value: 'gpt-5.6', label: 'GPT-5.6', efforts: ['low', 'medium', 'high'] },
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ],
    'claude-code': [
      { value: 'claude-opus-4-8', label: 'Opus 4.8', efforts: ['high', 'medium'] },
      { value: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
    ],
    // grok reports models but no per-model effort data (efforts undefined).
    grok: [{ value: 'grok-4', label: 'Grok 4' }],
  },
}

describe('validateModelSelection — models', () => {
  it('accepts a known model with no suggestion (gpt-5.6 must NOT suggest gpt-5.6-sol)', () => {
    const r = validateModelSelection(catalog, { agentKind: 'codex', model: 'gpt-5.6' })
    expect(r).toEqual({ ok: true, forced: false })
  })

  it('rejects an unknown model with a ranked suggestion', () => {
    const r = validateModelSelection(catalog, { agentKind: 'codex', model: 'gpt-5.6-so' })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected rejection')
    expect(r.problem.kind).toBe('model')
    expect(r.problem.requested).toBe('gpt-5.6-so')
    expect(r.problem.suggestions[0]).toBe('gpt-5.6-sol')
    expect(r.problem.fetchedAt).toBe(1_000_000)
  })

  it('force bypasses an unknown model and reports forced=true', () => {
    const r = validateModelSelection(catalog, {
      agentKind: 'codex',
      model: 'gpt-6-experimental',
      force: true,
    })
    expect(r).toEqual({ ok: true, forced: true })
  })

  it('force is a no-op when the model is actually known', () => {
    const r = validateModelSelection(catalog, { agentKind: 'codex', model: 'gpt-5.6', force: true })
    expect(r).toEqual({ ok: true, forced: false })
  })

  it('skips validation when the catalog has no entry for the agent (cold/failed probe)', () => {
    const empty: ModelCatalogSnapshot = {
      machineId: asMachineId('test-machine'),
      byAgent: {},
      fetchedAt: 0,
    }
    expect(validateModelSelection(empty, { agentKind: 'codex', model: 'anything' })).toEqual({
      ok: true,
      forced: false,
    })
  })

  it('skips "auto" and empty selections', () => {
    expect(validateModelSelection(catalog, { agentKind: 'codex', model: 'auto' })).toEqual({
      ok: true,
      forced: false,
    })
    expect(validateModelSelection(catalog, { agentKind: 'codex' })).toEqual({
      ok: true,
      forced: false,
    })
  })
})

describe('validateModelSelection — efforts', () => {
  it('rejects an invalid effort with a suggestion from the model ladder', () => {
    const r = validateModelSelection(catalog, {
      agentKind: 'codex',
      model: 'gpt-5.6',
      effort: 'highh',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected rejection')
    expect(r.problem.kind).toBe('effort')
    expect(r.problem.model).toBe('gpt-5.6')
    expect(r.problem.suggestions).toContain('high')
  })

  it('accepts a valid effort for the model', () => {
    expect(
      validateModelSelection(catalog, { agentKind: 'codex', model: 'gpt-5.6', effort: 'high' }),
    ).toEqual({ ok: true, forced: false })
  })

  it('rejects any effort on a model that supports none, with no suggestions', () => {
    const r = validateModelSelection(catalog, {
      agentKind: 'claude-code',
      model: 'claude-haiku-4-5',
      effort: 'high',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected rejection')
    expect(r.problem.kind).toBe('effort')
    expect(r.problem.suggestions).toEqual([])
  })

  it('does not validate effort when the source reports none (grok)', () => {
    expect(
      validateModelSelection(catalog, { agentKind: 'grok', model: 'grok-4', effort: 'whatever' }),
    ).toEqual({ ok: true, forced: false })
  })

  it('validates effort against the agent union when the model is auto', () => {
    const bad = validateModelSelection(catalog, { agentKind: 'codex', effort: 'ultra' })
    expect(bad.ok).toBe(false)
    const good = validateModelSelection(catalog, { agentKind: 'codex', effort: 'xhigh' })
    expect(good).toEqual({ ok: true, forced: false })
  })

  it('does not validate effort for a forced unknown model', () => {
    expect(
      validateModelSelection(catalog, {
        agentKind: 'codex',
        model: 'gpt-unknown',
        effort: 'anything',
        force: true,
      }),
    ).toEqual({ ok: true, forced: true })
  })
})

describe('formatModelValidationProblem / assert', () => {
  const now = 1_000_000 + 5 * 60_000 // 5 minutes after the probe

  it('includes harness, requested value, freshness, and suggestion', () => {
    const msg = formatModelValidationProblem(
      {
        kind: 'model',
        harness: 'codex',
        requested: 'gpt-5.6-sol-x',
        fetchedAt: 1_000_000,
        suggestions: ['gpt-5.6-sol'],
      },
      now,
    )
    expect(msg).toContain('codex')
    expect(msg).toContain('gpt-5.6-sol-x')
    expect(msg).toContain('5m ago')
    expect(msg).toContain('Did you mean "gpt-5.6-sol"?')
    expect(msg).toContain('--force-unknown-model')
  })

  it('reports a never-probed catalog', () => {
    const msg = formatModelValidationProblem(
      { kind: 'model', harness: 'codex', requested: 'x', fetchedAt: 0, suggestions: [] },
      now,
    )
    expect(msg).toContain('never been probed')
  })

  it('assert throws ModelValidationError and returns forced otherwise', () => {
    expect(() => assertModelSelectionValid(catalog, { agentKind: 'codex', model: 'nope' })).toThrow(
      ModelValidationError,
    )
    expect(assertModelSelectionValid(catalog, { agentKind: 'codex', model: 'gpt-5.6' })).toEqual({
      forced: false,
    })
    expect(
      assertModelSelectionValid(catalog, { agentKind: 'codex', model: 'nope', force: true }),
    ).toEqual({ forced: true })
  })
})

describe('vetLaunchSelection — a default never blocks a launch (POD-3911)', () => {
  it('refuses an explicit unknown model, exactly as before', () => {
    expect(() =>
      vetLaunchSelection(catalog, { agentKind: 'codex', explicit: { model: 'gpt-5.6-so' } }),
    ).toThrow(ModelValidationError)
  })

  it('drops an inherited unknown model to auto and says so', () => {
    expect(
      vetLaunchSelection(catalog, { agentKind: 'claude-code', inherited: { model: 'Codex' } }),
    ).toEqual({ model: 'auto', effort: 'auto', forced: false, dropped: ['model'] })
  })

  it('keeps an inherited model the catalog knows', () => {
    expect(
      vetLaunchSelection(catalog, {
        agentKind: 'codex',
        inherited: { model: 'gpt-5.6', effort: 'high' },
      }),
    ).toEqual({ model: 'gpt-5.6', effort: 'high', forced: false, dropped: [] })
  })

  it('checks an inherited effort against the model that survived', () => {
    // Haiku takes no effort: the inherited one goes, the explicit model stays.
    expect(
      vetLaunchSelection(catalog, {
        agentKind: 'claude-code',
        explicit: { model: 'claude-haiku-4-5' },
        inherited: { effort: 'high' },
      }),
    ).toEqual({ model: 'claude-haiku-4-5', effort: 'auto', forced: false, dropped: ['effort'] })
  })

  it('still refuses an explicit effort the model does not take', () => {
    expect(() =>
      vetLaunchSelection(catalog, {
        agentKind: 'claude-code',
        explicit: { model: 'claude-haiku-4-5', effort: 'high' },
      }),
    ).toThrow(/unknown effort "high"/)
  })

  it('lets an explicit value win over an inherited one of the same kind', () => {
    expect(
      vetLaunchSelection(catalog, {
        agentKind: 'codex',
        explicit: { model: 'gpt-5.6-sol' },
        inherited: { model: 'Codex' },
      }).model,
    ).toBe('gpt-5.6-sol')
  })

  it('keeps an unknown model of either kind under force, never an unknown effort', () => {
    expect(
      vetLaunchSelection(catalog, {
        agentKind: 'codex',
        inherited: { model: 'gpt-7-preview' },
        force: true,
      }),
    ).toEqual({ model: 'gpt-7-preview', effort: 'auto', forced: true, dropped: [] })
    expect(() =>
      vetLaunchSelection(catalog, {
        agentKind: 'codex',
        explicit: { model: 'gpt-5.6', effort: 'banana' },
        force: true,
      }),
    ).toThrow(/unknown effort "banana"/)
  })

  it('keeps everything when there is no catalog to check against', () => {
    expect(
      vetLaunchSelection(null, { agentKind: 'codex', inherited: { model: 'Codex', effort: 'x' } }),
    ).toEqual({ model: 'Codex', effort: 'x', forced: false, dropped: [] })
  })
})

describe('spawn-time Settings defaults (POD-3911)', () => {
  const launchConfig = (coding: { model: string; effort: string }) =>
    new SessionLaunchConfig({
      store: {
        settings: {
          getSettingsFor: async () =>
            normalizeSettings({ roles: { coding: { accountId: 'native:claude-code', ...coding } } }),
          getModelCatalog: async () => catalog,
        },
        accounts: {},
      } as unknown as ConstructorParameters<typeof SessionLaunchConfig>[0]['store'],
      settingsViewer: () => 'user-1' as UserId,
    })
  const machine = asMachineId('test-machine')

  it('never hands a bogus Settings model to the CLI', async () => {
    const launch = await launchConfig({ model: 'Codex', effort: 'auto' }).modelDefaults(
      'claude-code',
      undefined,
      machine,
    )
    expect(launch.model).toBeUndefined()
  })

  it('keeps a Settings model and effort the machine knows', async () => {
    const launch = await launchConfig({ model: 'claude-opus-4-8', effort: 'high' }).modelDefaults(
      'claude-code',
      undefined,
      machine,
    )
    expect(launch).toEqual(expect.objectContaining({ model: 'claude-opus-4-8', effort: 'high' }))
  })

  it("passes the caller's own values through untouched", async () => {
    const launch = await launchConfig({ model: 'Codex', effort: 'auto' }).modelDefaults(
      'claude-code',
      { model: 'claude-opus-9-preview' },
      machine,
    )
    expect(launch.model).toBe('claude-opus-9-preview')
  })
})
