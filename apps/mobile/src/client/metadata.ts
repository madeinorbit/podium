import type { ConversationSummaryWire, IssueWire, SessionMeta } from '@podium/protocol'

export interface MobileMetadataState {
  sessions: SessionMeta[]
  issues: IssueWire[]
  conversations: ConversationSummaryWire[]
  connected: boolean
  cursor: number | null
  error: string | null
}

export const EMPTY_METADATA: MobileMetadataState = {
  sessions: [],
  issues: [],
  conversations: [],
  connected: false,
  cursor: null,
  error: null,
}
