/** Transitional persistence ports for the per-path WorldIndexReader switches.
 * These describe today's injected calls; they grant no new repository methods
 * and import no runtime store code. Keeping them outside the hot-path modules
 * arms the direct store-import boundary without switching reads in POD-3869.
 * Child issues replace the owned-fact reads with WorldIndexReader. Checkpoints
 * remain a durable port because they are explicitly outside the owned set.
 */
import type { SessionStore } from './store'
export type { GrantRow } from './store/grants'
export type {
  IssueRow,
  SessionRow,
  MessageRow,
  ObservationLeaseRecord,
  TerminalCandidateFacts,
} from './store/types'
export type { MessagePageCursor } from './store/messages'

export interface DaemonObservationStore {
  readonly observationCheckpoints: SessionStore['observationCheckpoints']
}
export interface FeedVisibilityStore {
  readonly issues: Pick<SessionStore['issues'], 'getIssue' | 'getIssues'>
  readonly sessions: Pick<
    SessionStore['sessions'],
    'getSessions' | 'findSessionsByResumeValues' | 'findSessionsByIssueIds'
  >
  readonly shipping: Pick<SessionStore['shipping'], 'issueIdsForOrders'>
  readonly automations: Pick<SessionStore['automations'], 'ownerOf' | 'runOwnerOf'>
  readonly sync: Pick<SessionStore['sync'], 'latestChangeStatesGeneration' | 'latestChangeStates'>
}
export type DeliveryMessages = Pick<
  SessionStore['messages'],
  'countQueued' | 'listQueuedPage' | 'pendingForPage'
>
