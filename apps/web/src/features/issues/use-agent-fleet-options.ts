/** Shared capability choices for an issue's repository and optional pinned host.
 * Missing harnesses move into Set up agents; offline/probing readings stay visible. */

import { type RepoView, reposToViews } from '@podium/client-core/values'
import { machinesForRepoOrClone } from '@podium/model/browser'
import { useMemo } from 'react'
import { usePoolMachines, usePoolRepositories } from '@/app/header-data'
import type { IssueViewModel } from '@/app/store'
import { agentFleetStatus, candidateFromAvailability } from '@/lib/agent-capability'
import {
  ISSUE_AGENT_KINDS,
  type IssueAgentKind,
  issueAgentIcon,
  issueAgentLabel,
} from '@/lib/issue-agents'

export interface AgentFleetOption {
  value: IssueAgentKind
  label: string
  icon: ReturnType<typeof issueAgentIcon>
  status: ReturnType<typeof agentFleetStatus>
}

/**
 * Every harness this build offers, each carrying its fleet reading for the
 * machines that hold `repoPath`.
 *
 * A repo the replica has not merged into a view yet resolves to NO hosts, and
 * the status is then left EMPTY rather than refusing everything: an unknown
 * fleet is not evidence that a harness is missing, and greying the whole list
 * on a cold replica would be a refusal the shell cannot support.
 */
export function useAgentFleet(
  issue: Partial<Pick<IssueViewModel, 'repoPath' | 'machineId'>>,
  allMachines = false,
) {
  // Records (POD-6644): the repositories from checkouts, my machines' models.
  const repos = usePoolRepositories()
  const machines = usePoolMachines()
  const { repoPath, machineId } = issue
  return useMemo(() => {
    const repoView: RepoView | undefined = reposToViews(repos).find((r) => r.path === repoPath)
    const hosts = machineId
      ? machines.filter((machine) => machine.id === machineId)
      : allMachines
        ? machines
        : repoView
          ? machinesForRepoOrClone(repoView, machines)
          : []
    const options = ISSUE_AGENT_KINDS.map((kind) => {
      const label = issueAgentLabel(kind)
      const candidates = hosts.map((machine) =>
        candidateFromAvailability(
          machine,
          machine.use === 'denied' ? 'unauthorized' : machine.online ? 'available' : 'unreachable',
          kind,
        ),
      )
      return {
        value: kind,
        label,
        icon: issueAgentIcon(kind),
        status: hosts.length > 0 ? agentFleetStatus(candidates, label) : {},
      }
    })
    return {
      machines: hosts,
      setupMachines: hosts.length ? hosts : machines,
      options,
    }
  }, [repos, machines, repoPath, machineId, allMachines])
}

export function useAgentFleetOptions(
  issue: Partial<Pick<IssueViewModel, 'repoPath' | 'machineId'>>,
): AgentFleetOption[] {
  return useAgentFleet(issue).options
}
