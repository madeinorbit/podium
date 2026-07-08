import { IssueServiceWorkflow } from './workflow'

/**
 * Server-side issue tracker (issue #190: moved from apps/server/src/issues.ts
 * into modules/issues/service/, split along its seams into an inheritance
 * chain). One service, one instance — the layers are files, not modules:
 *
 *   core      — row map, wire serializer, ref resolution, persist/broadcast tail
 *   reads     — list projections, tree/dep reports, search/stats/doctor, prime
 *   crud      — create/update, stage machine (#24), deps/hierarchy, labels/comments
 *   attention — archive + auto-archive sweep (#127), drafts/attach, subscriptions
 *   mail      — agent mail (#103)
 *   workflow  — worktree start/cleanup, PR/merge, integration (#70), assistant
 */
export class IssueService extends IssueServiceWorkflow {}

export {
  AUTO_ARCHIVE_READ_WINDOW_MS,
  type CreateIssueInput,
  type DepReportEntry,
  type DepReportRef,
  type IssueDeps,
  type IssuePanelOp,
  type IssuePatch,
  type IssueTree,
  type IssueTreeNode,
  UNSNOOZE_BACKDATE_MS,
} from './types'
