import type { AgentCapabilityRejection, AgentLoginCondition, HandoffMachine } from '@podium/model'
import {
  agentLoginCondition,
  agentProbeTimeoutDescription,
  harnessRejection,
} from '@podium/model'

export const SIGNED_OUT_HINT = 'signed out'

/** Shared reading for one harness option. A reason means the row is disabled. */
export interface AgentRowStatus {
  reason?: string
  hint?: string
  warning?: string
}

export function spawnAgentLabel(menuLabel: string): string {
  return menuLabel
    .replace(/^New /, '')
    .replace(/^Add /, '')
    .replace(/ \(default\)$/, '')
}

export function agentCapabilityReason(
  machineName: string,
  label: string,
  rejection: AgentCapabilityRejection | undefined,
  probeDescription?: string,
): string | undefined {
  switch (rejection) {
    case undefined:
      return undefined
    case 'unauthorized':
      return `You don’t have access to run agents on ${machineName}. Ask its owner.`
    case 'offline':
      return `${machineName} is offline.`
    case 'inventory-unavailable':
      return `${machineName} hasn’t reported its agent inventory yet; retry shortly.`
    case 'harness-probe-timed-out':
      return `Couldn’t determine whether ${spawnAgentLabel(label)} is installed on ${machineName}; probe ${probeDescription ?? 'timed out'}. Retry.`
    case 'harness-missing':
      return `${spawnAgentLabel(label)} is not installed on ${machineName}.`
    default: {
      const exhaustive: never = rejection
      return exhaustive
    }
  }
}

export function agentCapabilityHint(
  rejection: AgentCapabilityRejection | undefined,
): string | undefined {
  switch (rejection) {
    case 'unauthorized':
      return 'no access'
    case 'offline':
      return 'offline'
    case 'inventory-unavailable':
      return 'inventory pending'
    case 'harness-probe-timed-out':
      return 'probe timed out'
    case 'harness-missing':
      return 'not installed'
    default:
      return undefined
  }
}

export function agentLoginWarning(
  machineName: string,
  label: string,
  condition: AgentLoginCondition | undefined,
): string | undefined {
  return condition === 'logged-out'
    ? `${spawnAgentLabel(label)} isn’t logged in on ${machineName}; the session will open so you can log in.`
    : undefined
}

export interface AgentCandidate {
  machineName: string
  rejection?: AgentCapabilityRejection
  probeDescription?: string
  loggedOut?: boolean
}

/** Summarize whether a fleet can run one harness without picking an arbitrary host. */
export function agentFleetStatus(
  candidates: readonly AgentCandidate[],
  label: string,
): AgentRowStatus {
  const agent = spawnAgentLabel(label)
  if (candidates.length === 0) {
    return { reason: `No machine here can run ${agent}.`, hint: 'no host' }
  }
  const usable = candidates.filter((candidate) => candidate.rejection === undefined)
  if (usable.length === 0) {
    const only = candidates.length === 1 ? candidates[0] : undefined
    if (only) {
      const reason = agentCapabilityReason(
        only.machineName,
        label,
        only.rejection,
        only.probeDescription,
      )
      const hint = agentCapabilityHint(only.rejection)
      return { ...(reason ? { reason } : {}), ...(hint ? { hint } : {}) }
    }
    if (candidates.every((candidate) => candidate.rejection === 'harness-missing')) {
      return {
        reason: `${agent} is not installed on any available machine.`,
        hint: 'not installed',
      }
    }
    return { reason: `No available machine can run ${agent}.`, hint: 'no host' }
  }
  if (usable.every((candidate) => candidate.loggedOut)) {
    const first = usable[0]
    const warning = first
      ? agentLoginWarning(
          usable.length === 1 ? first.machineName : 'any available machine',
          label,
          'logged-out',
        )
      : undefined
    return warning ? { warning, hint: SIGNED_OUT_HINT } : {}
  }
  return {}
}

/** Build the harness reading after the shared machine-authority slice has
 * already resolved use permission and reachability. */
export function candidateFromAvailability<M extends HandoffMachine & { name: string }>(
  machine: M,
  availability: 'available' | 'unreachable' | 'unauthorized',
  agentKind: string,
): AgentCandidate {
  const rejection: AgentCapabilityRejection | undefined =
    availability === 'unauthorized'
      ? 'unauthorized'
      : availability === 'unreachable'
        ? 'offline'
        : machine.inventory === undefined
          ? undefined
          : harnessRejection(machine, agentKind)
  return {
    machineName: machine.name,
    ...(rejection ? { rejection } : {}),
    ...(rejection === 'harness-probe-timed-out'
      ? { probeDescription: agentProbeTimeoutDescription(machine, agentKind) }
      : {}),
    ...(rejection === undefined && agentLoginCondition(machine, agentKind) === 'logged-out'
      ? { loggedOut: true }
      : {}),
  }
}
