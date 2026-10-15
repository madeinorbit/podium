/** The repository reads hot paths are handed, as named ports (POD-3869,
 * POD-6155). They grant no new repository methods and import no runtime store
 * code; keeping them outside the hot-path modules arms the direct store-import
 * boundary (`checkHotPathStoreBoundary` in scripts/check-boundaries.ts). Every
 * read behind them asks the database.
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
  readonly shipping: Pick<
    SessionStore['shipping'],
    'issueIdsForOrders' | 'laneMemberIssueIds' | 'laneMemberIssueIdsMany' | 'getOrder'
  >
  readonly automations: Pick<SessionStore['automations'], 'ownersOf' | 'runOwnersOf'>
  readonly grants: Pick<SessionStore['grants'], 'loadForResource' | 'listForResources'>
  readonly sync: Pick<SessionStore['sync'], 'latestChangeStatesGeneration' | 'latestChangeStates'>
}
export type DeliveryMessages = Pick<
  SessionStore['messages'],
  'countPending' | 'countQueued' | 'listQueuedPage' | 'pendingForPage'
>
