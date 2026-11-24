import { useCommands } from '@podium/client-core/react'
import type { ProposalPorts } from '@podium/client-graph/mission-proposals'
import { issueWrites } from '@podium/commands/issues-synced'
import { useMemo } from 'react'
import { useTrpc } from '../client/hooks'
import type { MobileTrpc } from '../client/trpc'

/** The phone's bindings of the shared proposal verbs, as on the desktop: the
 *  synced promote write, a declined close, and the `issue.begin` start record
 *  (POD-6526). */
export function useProposalPorts(): ProposalPorts {
  const trpc = useTrpc()
  const startIssueSession = useCommands<MobileTrpc>().sessions.startIssueSession
  return useMemo(
    () => ({
      promote: (input) => issueWrites(trpc).promote.mutate(input),
      decline: (input) => trpc.issues.close.mutate({ ...input, reason: 'declined' }),
      startIssueSession,
    }),
    [trpc, startIssueSession],
  )
}
