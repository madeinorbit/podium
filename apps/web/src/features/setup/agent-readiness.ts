import type { GitRepositoryWire, HarnessAgent, MachineWire } from '@podium/model'
import { agentCapabilityRejectionForSelection } from '@podium/model'

export type ActivationAgentReadiness = {
  state:
    | 'ready'
    | 'login-unknown'
    | 'logged-out'
    | 'missing'
    | 'offline'
    | 'unauthorized'
    | 'checking'
    | 'unavailable'
  machine?: MachineWire
  account?: string
}

function repoMachines(repo: GitRepositoryWire, machines: readonly MachineWire[]): MachineWire[] {
  if (!repo.machineId) return [...machines]
  const exact = machines.find((machine) => machine.id === repo.machineId)
  return exact ? [exact] : []
}

/**
 * Truthful readiness for the exact checkout selected during activation. This is
 * deliberately stricter than a general spawn menu: onboarding advances only
 * with an installed, reachable harness whose known login is usable.
 */
export function activationAgentReadiness(
  repo: GitRepositoryWire | undefined,
  machines: readonly MachineWire[],
  agent: HarnessAgent,
): ActivationAgentReadiness {
  if (!repo) return { state: 'unavailable' }
  const candidates = repoMachines(repo, machines)
  if (candidates.length === 0) return { state: 'unavailable' }

  for (const machine of candidates) {
    if (!machine.online || machine.use === 'denied' || machine.inventory) continue
    return { state: 'checking', machine }
  }

  for (const machine of candidates) {
    if (agentCapabilityRejectionForSelection(machine, agent) !== undefined) continue
    const login = machine.inventory?.agents.find((entry) => entry.kind === agent)?.login
    return login?.state === 'unknown'
      ? { state: 'login-unknown', machine }
      : { state: 'ready', machine, ...(login?.account ? { account: login.account } : {}) }
  }

  const priority = ['logged-out', 'harness-missing', 'offline', 'unauthorized'] as const
  for (const rejection of priority) {
    const machine = candidates.find(
      (candidate) => agentCapabilityRejectionForSelection(candidate, agent) === rejection,
    )
    if (!machine) continue
    return {
      state:
        rejection === 'harness-missing'
          ? 'missing'
          : rejection === 'logged-out'
            ? 'logged-out'
            : rejection,
      machine,
    }
  }
  return { state: 'unavailable' }
}

export function activationAgentIsReady(readiness: ActivationAgentReadiness): boolean {
  return readiness.state === 'ready' || readiness.state === 'login-unknown'
}

/** Onboarding may finish with any installed harness. A native login is useful
 *  before the first task, but it is not a prerequisite for entering Podium. */
export function activationAgentIsInstalled(readiness: ActivationAgentReadiness): boolean {
  return activationAgentIsReady(readiness) || readiness.state === 'logged-out'
}

export function activationReadinessCopy(
  readiness: ActivationAgentReadiness,
  agentLabel: string,
): string {
  const machine = readiness.machine?.name ?? 'the selected project machine'
  switch (readiness.state) {
    case 'ready':
      return readiness.account
        ? `Ready on ${machine} as ${readiness.account}.`
        : `Ready on ${machine}.`
    case 'login-unknown':
      return `Installed on ${machine}. ${agentLabel} verifies its account when it starts.`
    case 'logged-out':
      return `${agentLabel} is installed on ${machine}, but it is not signed in. You can continue now and sign in before you run it.`
    case 'missing':
      return `${agentLabel} is not installed on ${machine}. Install it there, then return; Podium detects readiness automatically.`
    case 'offline':
      return `${machine} is offline. Bring its Podium daemon online, then return to this saved draft.`
    case 'unauthorized':
      return `You do not have access to run agents on ${machine}. Ask its owner for access or choose another project.`
    case 'checking':
      return `Checking which agents are installed on ${machine}.`
    case 'unavailable':
      return 'No machine currently hosts this project. Choose another project or add it again.'
  }
}
