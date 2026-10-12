import { asMachineId, firstAdminMemberId, type AgentKind } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelCatalogSnapshot } from './model-catalog'
import {
  assertModelSelectionValid,
  formatModelValidationProblem,
  ModelValidationError,
  validateModelSelection,
  vetLaunchSelection,
  resolveLaunchSelection,
  type LaunchSelectionSource,
} from './model-validation'
import { MODEL_CATALOG_VERSION } from './model-catalog'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { SessionRegistry } from './relay'
import { attachHostDaemon } from './test-support/host-daemon'
import { fixtureInventory } from './test-support/daemon-inventory'
import { openTestStore } from './test-support/open-test-store'
import { sessionReadPorts } from './test-support/session-facts'
import type { ControlMessage } from '@podium/protocol/daemon'

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
  // The model/effort responsibility moved out of SessionLaunchConfig. Observe
  // the actual spawn frame, retaining the original behavioral assertions.
  const launchFrame = async (
    coding: { model: string; effort: string },
    explicit?: { model?: string; effort?: string },
  ) => {
    const { reg, machineMessaging } = await launchHarness(coding)
    await reg.modules.sessions.createSession({
      agentKind: 'claude-code', cwd: '/proj', ...explicit,
      // This old case represents a caller's already-accepted deliberate model.
      ...(explicit ? { forceUnknownModel: true } : {}),
    })
    return machineMessaging.mock.calls.at(-1)?.[0] as Extract<ControlMessage, { type: 'spawn' }>
  }

  it('never hands a bogus Settings model to the CLI', async () => {
    const launch = await launchFrame({ model: 'Codex', effort: 'auto' })
    expect(launch.model).toBeUndefined()
  })

  it('keeps a Settings model and effort the machine knows', async () => {
    const launch = await launchFrame({ model: 'claude-opus-4-8', effort: 'high' })
    expect(launch).toEqual(expect.objectContaining({ model: 'claude-opus-4-8', effort: 'high' }))
  })

  it("passes the caller's own values through untouched", async () => {
    const launch = await launchFrame({ model: 'Codex', effort: 'auto' }, { model: 'claude-opus-9-preview' })
    expect(launch.model).toBe('claude-opus-9-preview')
  })
})

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

async function launchHarness(coding: { model: string; effort: string }) {
  const store = await openTestStore(':memory:')
  await store.settings.setSettings(normalizeSettings({
    roles: { coding: { accountId: 'native:claude-code', ...coding } },
  }))
  await store.settings.setModelCatalog({
    ...catalog, machineId: store.hostMachineId, version: MODEL_CATALOG_VERSION,
  })
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const machineMessaging = vi.fn<(message: ControlMessage) => void>()
  await attachHostDaemon(reg, machineMessaging, { repos: ['/r'] })
  await reg.modules.machines.recordInventory(store.hostMachineId, fixtureInventory())
  machineMessaging.mockClear()
  return { reg, store, machineMessaging }
}

describe('resolveLaunchSelection — independent field precedence', () => {
  const settingsFor = (values: { model?: string; effort?: string } = {}, harness = 'codex') =>
    normalizeSettings({ roles: { coding: { accountId: `native:${harness}`, ...values } } })

  for (const field of ['model', 'effort'] as const) {
    const known = field === 'model' ? 'gpt-5.6' : 'high'
    const unknown = field === 'model' ? 'gpt-5.6-so' : 'banana'
    const refusal = field === 'model' ? /Did you mean "gpt-5.6-sol"/ : /Valid efforts.*"low", "medium", "high"/s
    const rows: Array<{
      name: string; explicit?: string; issue?: string; setting?: string;
      codingHarness?: string; force?: boolean; result?: string;
      source?: LaunchSelectionSource; dropped?: boolean; forced?: boolean; refusal?: RegExp;
    }> = [
      { name: 'explicit known wins', explicit: known, issue: unknown, setting: unknown, result: known, source: 'explicit' },
      { name: 'explicit unknown refused', explicit: unknown, refusal },
      { name: 'force only bypasses unknown model', explicit: unknown, force: true,
        ...(field === 'model' ? { result: unknown, source: 'explicit' as const, forced: true } : { refusal }) },
      { name: 'known under force is not forced', explicit: known, force: true, result: known, source: 'explicit' },
      { name: 'issue known wins', explicit: 'auto', issue: known, setting: unknown, result: known, source: 'issue' },
      { name: 'issue unknown drops without falling through', issue: unknown, setting: known, result: 'auto', source: 'auto', dropped: true },
      { name: 'issue auto inherits Settings', explicit: 'auto', issue: 'auto', setting: known, result: known, source: 'settings' },
      { name: 'Settings unknown drops', issue: 'auto', setting: unknown, result: 'auto', source: 'auto', dropped: true },
      { name: 'another coding harness never supplies Settings', setting: known, codingHarness: 'claude-code', result: 'auto', source: 'auto' },
      { name: 'issue pick survives matching another harness Settings', issue: known, setting: known, codingHarness: 'claude-code', result: known, source: 'issue' },
      { name: 'all auto', explicit: 'auto', issue: 'auto', setting: 'auto', result: 'auto', source: 'auto' },
      { name: 'omitted fields mean auto', result: 'auto', source: 'auto' },
      { name: 'legacy empty fields mean auto', explicit: '', issue: '', setting: '', result: 'auto', source: 'auto' },
    ]
    it.each(rows)(`${field}: $name`, (row) => {
      const other = field === 'model' ? 'effort' : 'model'
      const resolve = () => resolveLaunchSelection({
        agentKind: 'codex', catalog,
        explicit: { [field]: row.explicit },
        issueProfile: { agentKind: 'codex', [field]: row.issue },
        settings: settingsFor({ [field]: row.setting }, row.codingHarness),
        force: row.force,
      })
      if (row.refusal) expect(resolve).toThrow(row.refusal)
      else expect(resolve()).toEqual({
        [field]: row.result, [other]: 'auto', forced: row.forced ?? false,
        dropped: row.dropped ? [field] : [],
        source: { [field]: row.source, [other]: 'auto' },
      })
    })
  }

  const missingCatalogs: Array<ModelCatalogSnapshot | null | undefined> = [
    undefined, null, { ...catalog, byAgent: {} }, { ...catalog, byAgent: { codex: [] } },
  ]
  for (const field of ['model', 'effort'] as const) {
    for (const source of ['explicit', 'issue', 'settings'] as const) {
      it.each(missingCatalogs)(`${field}: ${source} is kept unchecked with absent/empty catalog %j`, (absent) => {
        const values = { [field]: 'unlisted-value' }
        const result = resolveLaunchSelection({
          agentKind: 'codex', catalog: absent, force: true,
          explicit: source === 'explicit' ? values : undefined,
          issueProfile: source === 'issue' ? { agentKind: 'codex', ...values } : undefined,
          settings: settingsFor(source === 'settings' ? values : {}),
        })
        expect(result[field]).toBe('unlisted-value')
        expect(result.source[field]).toBe(source)
        expect(result.dropped).toEqual([])
        expect(result.forced).toBe(false)
      })
    }
  }

  it.each([
    { explicit: { model: 'gpt-5.6' }, issue: { effort: 'high' }, source: { model: 'explicit', effort: 'issue' } },
    { explicit: { effort: 'high' }, issue: { model: 'gpt-5.6' }, source: { model: 'issue', effort: 'explicit' } },
    { explicit: { model: 'gpt-5.6' }, issue: {}, source: { model: 'explicit', effort: 'settings' } },
    { explicit: { effort: 'high' }, issue: {}, source: { model: 'settings', effort: 'explicit' } },
  ])('mixes independent sources $source', ({ explicit, issue, source }) => {
    expect(resolveLaunchSelection({
      agentKind: 'codex', catalog, explicit,
      issueProfile: { agentKind: 'codex', ...issue },
      settings: settingsFor({ model: 'gpt-5.6', effort: 'high' }),
    })).toEqual({ model: 'gpt-5.6', effort: 'high', forced: false, dropped: [], source })
  })

  it('discards the profile when switching harnesses', () => {
    expect(resolveLaunchSelection({
      agentKind: 'codex', catalog,
      issueProfile: { agentKind: 'claude-code', model: 'claude-opus-4-8', effort: 'high' },
      settings: settingsFor(),
    })).toEqual({ model: 'auto', effort: 'auto', forced: false, dropped: [], source: { model: 'auto', effort: 'auto' } })
  })

  it.each(['issue', 'settings'] as const)('drops %s effort against the surviving explicit model', (source) => {
    expect(resolveLaunchSelection({
      agentKind: 'claude-code', catalog, explicit: { model: 'claude-haiku-4-5' },
      issueProfile: { agentKind: 'claude-code', effort: source === 'issue' ? 'high' : 'auto' },
      settings: settingsFor({ effort: source === 'settings' ? 'high' : 'auto' }, 'claude-code'),
    })).toEqual({ model: 'claude-haiku-4-5', effort: 'auto', forced: false, dropped: ['effort'], source: { model: 'explicit', effort: 'auto' } })
  })

  it.each(['issue', 'settings'] as const)('force keeps unknown %s model but still drops its unknown effort', (source) => {
    const values = { model: 'gpt-preview', effort: 'banana' }
    expect(resolveLaunchSelection({
      agentKind: 'codex', catalog, force: true,
      issueProfile: source === 'issue' ? { agentKind: 'codex', ...values } : undefined,
      settings: settingsFor(source === 'settings' ? values : {}),
    })).toEqual({ model: 'gpt-preview', effort: 'auto', forced: true, dropped: ['effort'], source: { model: source, effort: 'auto' } })
  })

  it('refuses an unknown effort even beside a forced unlisted model', () => {
    expect(() => resolveLaunchSelection({
      agentKind: 'codex', catalog, settings: settingsFor(),
      explicit: { model: 'gpt-preview', effort: 'banana' }, force: true,
    })).toThrow(/Valid efforts.*"low", "medium", "high"/s)
  })
})

describe('launch selection travels in the spawn call — no machine round trip', () => {
  it('session start sends exactly one message: spawn with the resolved pair', async () => {
    const { reg, machineMessaging } = await launchHarness({ model: 'claude-opus-4-8', effort: 'high' })
    await reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    expect(machineMessaging).toHaveBeenCalledTimes(1)
    expect(machineMessaging).toHaveBeenCalledWith(expect.objectContaining({
      type: 'spawn', model: 'claude-opus-4-8', effort: 'high',
    }))
  })

  it('issue create keeps auto; start and add-session use current Settings in one spawn frame', async () => {
    const { reg, store, machineMessaging } = await launchHarness({ model: 'claude-haiku-4-5', effort: 'auto' })
    const deps: IssueDeps = {
      store, ...sessionReadPorts(() => []),
      getSettings: () => store.settings.getSettingsFor(firstAdminMemberId()),
      spawnSession: (input) => reg.modules.sessions.createSession({
        ...input, agentKind: input.agentKind as AgentKind,
        launchSelection: {
          model: input.model ?? 'auto', effort: input.effort ?? 'auto',
          forced: input.forceUnknownModel === true,
        },
      }),
      // Worktree I/O is unrelated to selection; no daemon transport is needed.
      repoOp: async () => ({ ok: true, output: '' }),
      resolveMachine: async () => store.hostMachineId,
      ...issueTestPlumbing(() => {}),
    }
    const issues = await IssueService.create(deps)
    const issue = await issues.crud.create({ repoPath: '/r', title: 'Live defaults', startNow: false })
    expect(issue.defaultModel).toBe('auto')
    expect(issue.defaultEffort).toBe('auto')
    await store.settings.setSettings(normalizeSettings({
      roles: { coding: { accountId: 'native:claude-code', model: 'claude-opus-4-8', effort: 'high' } },
    }))
    machineMessaging.mockClear()
    await issues.gitWorkflow.start(issue.id)
    expect(machineMessaging).toHaveBeenCalledTimes(1)
    expect(machineMessaging).toHaveBeenCalledWith(expect.objectContaining({ type: 'spawn', model: 'claude-opus-4-8', effort: 'high' }))
    expect((await issues.reports.get(issue.id))?.defaultModel).toBe('auto')
    expect((await issues.reports.get(issue.id))?.defaultEffort).toBe('auto')
    // A resolved drop must not go back through Settings downstream.
    await issues.crud.update(issue.id, { defaultModel: 'retired-issue-model' })
    machineMessaging.mockClear()
    await issues.gitWorkflow.addSession(issue.id)
    expect(machineMessaging).toHaveBeenCalledTimes(1)
    const frame = machineMessaging.mock.calls[0]?.[0]
    expect(frame).toMatchObject({ type: 'spawn', effort: 'high' })
    expect(frame).not.toHaveProperty('model')
  })
})


describe('scheduled one-off selection stays equivalent', () => {
  it.each([
    { name: 'omitted picks snapshot coding Settings', pick: {}, expected: { agentKind: 'claude-code', model: 'claude-opus-4-8', effort: 'high' } },
    { name: 'explicit auto remains auto', pick: { model: 'auto', effort: 'auto' }, expected: { agentKind: 'claude-code', model: 'auto', effort: 'auto' } },
    { name: 'another harness receives no coding defaults', pick: { agentKind: 'codex' }, expected: { agentKind: 'codex', model: 'auto', effort: 'auto' } },
    { name: 'explicit pair wins', pick: { agentKind: 'codex', model: 'gpt-5.6', effort: 'low' }, expected: { agentKind: 'codex', model: 'gpt-5.6', effort: 'low' } },
    { name: 'model auto leaves effort snapshot independent', pick: { model: 'auto' }, expected: { agentKind: 'claude-code', model: 'auto', effort: 'high' } },
    { name: 'effort auto leaves model snapshot independent', pick: { effort: 'auto' }, expected: { agentKind: 'claude-code', model: 'claude-opus-4-8', effort: 'auto' } },
  ])('$name', async ({ pick, expected }) => {
    const { reg, store } = await launchHarness({ model: 'claude-opus-4-8', effort: 'high' })
    const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/r' })
    const request = await reg.modules.approvals.request({
      sessionId, machineId: store.hostMachineId,
      op: {
        kind: 'automation-schedule', name: 'Selection compatibility',
        runAt: '2099-07-17T02:00:00.000Z', prompt: 'Continue the task.',
        target: { kind: 'fresh', repoPath: '/r', ...pick },
      },
    })
    expect((await reg.modules.approvals.approve(request.id)).status).toBe('succeeded')
    expect(await reg.modules.automations.list()).toEqual([expect.objectContaining(expected)])
  })
})
