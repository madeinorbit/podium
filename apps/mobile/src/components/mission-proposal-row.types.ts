import type { FullDeckTask } from '@podium/client-graph/mission-full-deck'
import type { ProposalAction, ProposalSubmissions } from '@podium/client-graph/mission-proposals'

export interface MissionProposalRowProps {
  task: FullDeckTask
  first: boolean
  submissions: ProposalSubmissions
  onSubmit: (action: ProposalAction) => void
  onPress: () => void
}
