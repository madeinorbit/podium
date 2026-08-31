import type { ModelCatalog } from '@podium/client-core/react'
import type { IssueWire, MachineId } from '@podium/model'
import {
  AUTO,
  decodeModelPick,
  encodeModelPick,
  isEffortValid,
  issueAgentKind,
  type IssueAgentKind,
} from './agent-models'

export interface LaunchConfiguration {
  agentKind: IssueAgentKind
  modelPick: string
  effort: string
  /** Empty means the authority chooses an eligible host at start time. */
  machineId: string
}

export interface LaunchMachineOption {
  value: string
  label: string
  disabled?: boolean
  reason?: string
}

export interface LaunchPlan {
  configuration: LaunchConfiguration
  refusal?: string
}

/** Auto still needs an eligible destination; it is a placement choice, not a bypass. */
export function autoLaunchMachineOption(
  machines: readonly LaunchMachineOption[],
  agentLabel: string,
): LaunchMachineOption {
  if (machines.some((machine) => machine.value !== '' && !machine.disabled)) {
    return { value: '', label: 'Auto' }
  }
  return {
    value: '',
    label: 'Auto',
    disabled: true,
    reason: `No available machine can run ${agentLabel} for this repository.`,
  }
}

export function launchPlanCanSubmit(plan: LaunchPlan | null): plan is LaunchPlan {
  return plan !== null && plan.refusal === undefined
}

export function selectLaunchAgent(
  value: LaunchConfiguration,
  agentKind: IssueAgentKind,
): LaunchConfiguration {
  return { ...value, agentKind, modelPick: AUTO, effort: AUTO }
}

export function selectLaunchModel(
  value: LaunchConfiguration,
  modelPick: string,
): LaunchConfiguration {
  return { ...value, modelPick, effort: AUTO }
}

export function selectLaunchMachine(
  value: LaunchConfiguration,
  machineId: string,
): LaunchConfiguration {
  return { ...value, machineId, modelPick: AUTO, effort: AUTO }
}

export function launchConfigurationForIssue(issue: IssueWire): LaunchConfiguration {
  const agentKind = issueAgentKind(issue.defaultAgent) ?? 'claude-code'
  return {
    agentKind,
    modelPick:
      issue.defaultModel && issue.defaultModel !== AUTO
        ? encodeModelPick(agentKind, issue.defaultModel)
        : AUTO,
    effort: issue.defaultEffort || AUTO,
    machineId: issue.machineId ?? '',
  }
}

/** Normalize retired catalog selections and surface machine truth before submission. */
export function normalizeLaunchConfiguration(
  value: LaunchConfiguration,
  catalog: ModelCatalog,
  machines: readonly LaunchMachineOption[],
): LaunchPlan {
  const machine = value.machineId
    ? machines.find((option) => option.value === value.machineId)
    : machines.find((option) => option.value === '')
  const refusal = value.machineId
    ? !machine
      ? 'The selected machine is no longer available for this repository.'
      : machine.disabled
        ? (machine.reason ?? 'The selected machine is unavailable.')
        : undefined
    : machine?.disabled
      ? (machine.reason ?? 'No machine is available for automatic placement.')
      : undefined

  const decoded = decodeModelPick(value.modelPick)
  const live = catalog[value.agentKind] ?? []
  const retiredModel =
    value.modelPick !== AUTO &&
    (decoded.agentKind !== value.agentKind ||
      (live.length > 0 && !live.some((model) => model.value === decoded.model)))
  const modelPick = retiredModel ? AUTO : value.modelPick
  const model = decodeModelPick(modelPick).model
  const effort =
    retiredModel || !isEffortValid(value.agentKind, value.effort, catalog[value.agentKind])
      ? AUTO
      : value.effort

  return {
    configuration: { ...value, modelPick, effort },
    ...(refusal ? { refusal } : {}),
  }
}

export function launchConfigurationPatch(configuration: LaunchConfiguration): {
  defaultAgent: string
  defaultModel: string
  defaultEffort: string
  machineId: MachineId | null
} {
  const decoded = decodeModelPick(configuration.modelPick)
  return {
    defaultAgent: configuration.agentKind,
    defaultModel: decoded.model === AUTO ? AUTO : decoded.model,
    defaultEffort: configuration.effort || AUTO,
    machineId: configuration.machineId ? (configuration.machineId as MachineId) : null,
  }
}
