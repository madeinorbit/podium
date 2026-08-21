/**
 * ONE READING OF "CAN THIS HARNESS RUN HERE", FOR EVERY ISSUE SURFACE (POD-1457).
 *
 * The shell offers "start an agent" from several places, and POD-1201 already
 * made the spawn menus agree: a harness the target machines cannot run stays
 * VISIBLE and goes grey, with `not installed` beside it, because a row that
 * simply disappears is indistinguishable from one this build never supported.
 *
 * The issue surfaces were the holdout. `NewIssueDialog` did the work inline;
 * the launch box on the issue page and in the right dock's task panel listed
 * every harness the build knows about as equally startable, so picking Cursor
 * on a machine without Cursor wrote a default that could only fail later — a
 * refusal delivered as a dead session instead of as a greyed row.
 *
 * This hook is that reading, once: the issue's repo resolved to the machines
 * that hold it, each candidate machine's availability folded into one fleet
 * status per harness. Gating is UX only; the Authority re-authorizes at apply
 * (ADR 3 D8).
 */
import { type RepoView, reposToViews } from '@podium/client-core/viewmodels'
import { machinesForRepoOrClone } from '@podium/model/browser'
import { useMemo } from 'react'
import type { IssueViewModel } from '@/app/store'
import { useStoreSelector } from '@/app/store'
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
export function useAgentFleetOptions(issue: Pick<IssueViewModel, 'repoPath'>): AgentFleetOption[] {
  const { repos, machines } = useStoreSelector((s) => ({ repos: s.repos, machines: s.machines }))
  const repoPath = issue.repoPath
  return useMemo(() => {
    const repoView: RepoView | undefined = reposToViews(repos).find((r) => r.path === repoPath)
    const hosts = repoView ? machinesForRepoOrClone(repoView, machines) : []
    return ISSUE_AGENT_KINDS.map((kind) => {
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
  }, [repos, machines, repoPath])
}
