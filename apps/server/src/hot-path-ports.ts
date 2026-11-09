/** The repository reads hot paths are handed, as named ports (POD-3869,
 * POD-6155). They grant no new repository methods and import no runtime store
 * code; keeping them outside the hot-path modules arms the direct store-import
 * boundary (`checkHotPathStoreBoundary` in scripts/check-boundaries.ts). Every
 * read behind them asks the database.
 */
import type { SessionStore } from './store'

export type { GrantRow } from './store/grants'
export type { MessagePageCursor } from './store/messages'
export type {
  IssueRow,
  MessageRow,
  ObservationLeaseRecord,
  SessionRow,
  TerminalCandidateFacts,
} from './store/types'

export interface DaemonObservationStore {
  readonly observationCheckpoints: SessionStore['observationCheckpoints']
}
export interface FeedVisibilityStore {
  readonly issues: Pick<
    SessionStore['issues'],
    'getIssue' | 'getIssues' | 'liveWorktreeIssuesOnMachines'
  >
  readonly sessions: Pick<
    SessionStore['sessions'],
    'getSessions' | 'findSessionsByResumeValues' | 'findSessionsByIssueIds'
  >
  readonly shipping: Pick<
    SessionStore['shipping'],
    'issueIdsForOrders' | 'laneMemberIssueIdsMany' | 'ordersByIds' | 'orderIdsForIssues'
  >
  readonly automations: Pick<SessionStore['automations'], 'ownersOf' | 'runOwnersOf'>
  readonly effects: Pick<SessionStore['effects'], 'audiencesOf' | 'liveOnTargets'>
  /** The owners workflow-family rows are decided by (POD-6676). */
  readonly workflows: Pick<SessionStore['workflows'], 'visibilityFacts'>
  /** Admins read every instance-wide effect record (POD-6358). */
  readonly users: Pick<SessionStore['users'], 'activeAdminIds'>
  readonly grants: Pick<
    SessionStore['grants'],
    'loadForResource' | 'loadForResources' | 'loadForResourcesOfKinds' | 'listForResources'
  >
  readonly sync: Pick<SessionStore['sync'], 'installedStates' | 'installedIdsWithPrefixes'>
}
export type DeliveryMessages = Pick<
  SessionStore['messages'],
  'countQueued' | 'listQueuedPage' | 'pendingForPages' | 'pendingTargets'
>
