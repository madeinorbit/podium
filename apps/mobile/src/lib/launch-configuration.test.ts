import { describe, expect, it } from 'vitest'
import { AUTO, encodeModelPick } from './agent-models'
import {
  autoLaunchMachineOption,
  type LaunchConfiguration,
  hasAuthoritativeLaunchCatalog,
  launchConfigurationPatch,
  launchPlanCanSubmit,
  normalizeLaunchConfiguration,
  selectLaunchAgent,
  selectInheritedLaunchAgent,
  selectLaunchEffort,
  selectLaunchMachine,
  selectLaunchModel,
} from './launch-configuration'

const selected: LaunchConfiguration = {
  agentKind: 'codex',
  modelPick: encodeModelPick('codex', 'gpt-current'),
  effort: 'high',
  machineId: 'host-a',
}
const catalog = {
  codex: [{ value: 'gpt-current', label: 'Current', efforts: ['low', 'high'] }],
}

describe('normalizeLaunchConfiguration', () => {
  it('keeps an eligible live selection unchanged', () => {
    expect(
      normalizeLaunchConfiguration(selected, catalog, [{ value: 'host-a', label: 'Host A' }]),
    ).toEqual({ configuration: selected })
  })

  it('blocks a disappeared selected machine without calling it Auto', () => {
    const plan = normalizeLaunchConfiguration(selected, catalog, [])
    expect(plan.refusal).toMatch(/no longer/)
    expect(launchPlanCanSubmit(plan)).toBe(false)
  })

  it('blocks offline and unauthorized selected machines with the exact visible reason', () => {
    expect(
      normalizeLaunchConfiguration(selected, catalog, [
        { value: 'host-a', label: 'Host A', disabled: true, reason: 'Host A is offline.' },
      ]),
    ).toMatchObject({ refusal: 'Host A is offline.', configuration: { machineId: 'host-a' } })
    expect(
      normalizeLaunchConfiguration(selected, catalog, [
        {
          value: 'host-a',
          label: 'Host A',
          disabled: true,
          reason: 'You do not have permission to use Host A.',
        },
      ]),
    ).toMatchObject({ refusal: 'You do not have permission to use Host A.' })
  })

  it('blocks Auto when no repository machine can run the selected harness', () => {
    const auto = autoLaunchMachineOption(
      [
        { value: 'offline', label: 'Offline', disabled: true },
        { value: 'denied', label: 'Denied', disabled: true },
      ],
      'Codex',
    )
    expect(auto).toMatchObject({
      value: '',
      disabled: true,
      reason: expect.stringContaining('Codex'),
    })
    expect(
      normalizeLaunchConfiguration({ ...selected, machineId: '' }, catalog, [auto]),
    ).toMatchObject({
      refusal: expect.stringContaining('Codex'),
    })
  })

  it('keeps Auto eligible when at least one repository machine can run the harness', () => {
    expect(
      autoLaunchMachineOption(
        [
          { value: 'offline', label: 'Offline', disabled: true },
          { value: 'ready', label: 'Ready' },
        ],
        'Codex',
      ),
    ).toEqual({ value: '', label: 'Auto' })
  })

  it('submits Auto for a retired model and its stale effort', () => {
    const plan = normalizeLaunchConfiguration(
      { ...selected, modelPick: encodeModelPick('codex', 'retired'), effort: 'ultra' },
      catalog,
      [{ value: 'host-a', label: 'Host A' }],
    )
    expect(plan.configuration).toMatchObject({ modelPick: AUTO, effort: AUTO })
    expect(launchConfigurationPatch(plan.configuration)).toMatchObject({
      defaultModel: AUTO,
      defaultEffort: AUTO,
    })
  })

  it('fails closed to Auto when the selected agent catalog is empty', () => {
    const plan = normalizeLaunchConfiguration(selected, {}, [{ value: 'host-a', label: 'Host A' }])
    expect(plan.configuration).toMatchObject({ modelPick: AUTO, effort: AUTO })
    expect(launchConfigurationPatch(plan.configuration)).toMatchObject({
      defaultModel: AUTO,
      defaultEffort: AUTO,
    })
  })

  it('does not expose explicit picks when a ready catalog only knows another agent', () => {
    const otherAgentCatalog = {
      'claude-code': [{ value: 'sonnet', label: 'Sonnet', efforts: ['high'] }],
    }
    expect(hasAuthoritativeLaunchCatalog(otherAgentCatalog, 'ready', 'codex')).toBe(false)
    expect(
      normalizeLaunchConfiguration(
        selected,
        otherAgentCatalog,
        [{ value: 'host-a', label: 'Host A' }],
        'ready',
      ).configuration,
    ).toMatchObject({ modelPick: AUTO, effort: AUTO })
  })

  it.each([
    'loading',
    'unavailable',
  ] as const)('fails closed to Auto while the catalog is %s', (status) => {
    const plan = normalizeLaunchConfiguration(
      selected,
      catalog,
      [{ value: 'host-a', label: 'Host A' }],
      status,
    )
    expect(plan.configuration).toMatchObject({ modelPick: AUTO, effort: AUTO })
    expect(launchConfigurationPatch(plan.configuration)).toMatchObject({
      defaultModel: AUTO,
      defaultEffort: AUTO,
    })
  })

  it('resets selections that belong to a different agent or unsupported effort ladder', () => {
    expect(
      normalizeLaunchConfiguration(
        { ...selected, agentKind: 'claude-code' },
        { 'claude-code': [{ value: 'opus', label: 'Opus', efforts: ['medium'] }] },
        [{ value: 'host-a', label: 'Host A' }],
      ).configuration,
    ).toMatchObject({ modelPick: AUTO, effort: AUTO })
    expect(
      normalizeLaunchConfiguration({ ...selected, effort: 'ultra' }, catalog, [
        { value: 'host-a', label: 'Host A' },
      ]).configuration.effort,
    ).toBe(AUTO)
  })

  it('clears remembered model and effort when the agent or machine changes', () => {
    expect(selectLaunchAgent(selected, 'claude-code')).toMatchObject({
      agentKind: 'claude-code',
      modelPick: AUTO,
      effort: AUTO,
    })
    expect(selectLaunchMachine(selected, 'host-b')).toMatchObject({
      machineId: 'host-b',
      modelPick: AUTO,
      effort: AUTO,
    })
  })

  it('omits the agent override while the configured coding role remains inherited', () => {
    const inherited = selectInheritedLaunchAgent(selected)
    expect(inherited).toMatchObject({ inheritAgent: true, modelPick: AUTO, effort: AUTO })
    expect(launchConfigurationPatch(inherited)).not.toHaveProperty('defaultAgent')
    expect(launchConfigurationPatch(selectLaunchAgent(inherited, 'codex'))).toMatchObject({
      defaultAgent: 'codex',
    })
  })

  it('binds explicit model and effort choices to the agent whose catalog was displayed', () => {
    const inherited = selectInheritedLaunchAgent(selected)
    const withModel = selectLaunchModel(inherited, encodeModelPick('codex', 'gpt-current'))
    expect(withModel).toMatchObject({ inheritAgent: false, agentKind: 'codex' })
    expect(launchConfigurationPatch(withModel)).toMatchObject({
      defaultAgent: 'codex',
      defaultModel: 'gpt-current',
    })

    const withEffort = selectLaunchEffort(inherited, 'high')
    expect(withEffort).toMatchObject({ inheritAgent: false, agentKind: 'codex', effort: 'high' })
    expect(launchConfigurationPatch(withEffort)).toMatchObject({
      defaultAgent: 'codex',
      defaultEffort: 'high',
    })
  })

  it('defensively pins inherited state when an older caller supplies an explicit override', () => {
    const inherited = selectInheritedLaunchAgent(selected)
    expect(
      launchConfigurationPatch({
        ...inherited,
        modelPick: encodeModelPick('codex', 'gpt-current'),
      }),
    ).toMatchObject({ defaultAgent: 'codex', defaultModel: 'gpt-current' })
    expect(launchConfigurationPatch({ ...inherited, effort: 'high' })).toMatchObject({
      defaultAgent: 'codex',
      defaultEffort: 'high',
    })
  })
})
