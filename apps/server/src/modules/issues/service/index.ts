import { IssueAttentionModule } from './attention'
import { IssueStore } from './core'
import { IssueCrudModule } from './crud'
import { IssueHierarchyModule } from './hierarchy'
import { IssueCommentsMailModule } from './mail'
import { IssueReportsModule } from './reads'
import type { IssueDeps } from './types'
import { IssueGitWorkflowModule } from './workflow'

/** Public command-facing CRUD and stage-machine contract. */
export type IssueCrudCapability = Pick<
  IssueCrudModule,
  | 'setState'
  | 'panelApply'
  | 'panelArtifactAdd'
  | 'panelArtifactUpload'
  | 'panelArtifactTransfer'
  | 'stageArtifactUpload'
  | 'panelArtifactRemove'
  | 'panelArtifactRead'
  | 'planArtifactAdd'
  | 'snapshotArtifact'
  | 'publishStagedUpload'
  | 'discardArtifact'
  | 'artifactEntries'
  | 'panelChatUploadClaim'
  | 'chatUploadOwner'
  | 'chatUploadBytes'
  | 'create'
  | 'update'
  | 'textRevisions'
  | 'restoreTextRevision'
  | 'move'
  | 'markIssueRead'
  | 'markIssueUnread'
  | 'setIssueTucked'
  | 'prepareSoftDelete'
  | 'purgeEmptyDraft'
  | 'prepareRestore'
  | 'setLabels'
  | 'refuseUnknownLabels'
  | 'claim'
  | 'isActiveMember'
  | 'setCoordinator'
  | 'close'
  | 'applySuggestion'
  | 'dismissSuggestion'
>

/** Public hierarchy and dependency contract. */
export type IssueHierarchyCapability = Pick<
  IssueHierarchyModule,
  | 'addDep'
  | 'removeDep'
  | 'reparent'
  | 'ancestorIds'
  | 'inProposedSubtree'
  | 'supersede'
  | 'duplicate'
>

/** Public comments and tracker-mail contract. */
export type IssueCommentsMailCapability = Pick<
  IssueCommentsMailModule,
  | 'comments'
  | 'addComment'
  | 'addCallerComment'
  | 'editComment'
  | 'deleteComment'
  | 'mailInbox'
  | 'mailClaim'
  | 'mailPending'
  | 'mailMessage'
>

/** Public attention, per-user markers and subscription contract. */
export type IssueAttentionCapability = Pick<
  IssueAttentionModule,
  | 'attachSession'
  | 'discardUnlaunchedDraft'
  | 'createDraftFor'
  | 'subscriptionAdd'
  | 'subscriptionRemove'
  | 'subscriptionList'
  | 'subscriptionPage'
  | 'subscriptionOwnPage'
  | 'subscriptionSetEnabled'
  | 'subscriptionGet'
  | 'archive'
  | 'sweepAutoArchive'
  | 'tryAutoArchiveObserved'
  | 'defer'
  | 'undefer'
  | 'setNeedsHuman'
  | 'clearNeedsHuman'
  | 'markIssueRead'
  | 'markIssueUnread'
  | 'setIssueTucked'
  | 'recordIssuePin'
  | 'recordParticipation'
  | 'joinIssue'
  | 'dismissAssignment'
  | 'collaborators'
>

/** Public worktree, PR/merge and assistant contract. */
export type IssueGitWorkflowCapability = Pick<
  IssueGitWorkflowModule,
  | 'rehome'
  | 'start'
  | 'answerWithoutMachine'
  | 'createAndMaybeStart'
  | 'action'
  | 'finishLanding'
  | 'branchLanded'
  | 'projectionNow'
  | 'freeWorktreeKeepBranch'
  | 'releaseWorktreeIfIdle'
  | 'tryWorktreeGcObserved'
  | 'listReclaimableWorktrees'
  | 'releaseReclaimableWorktrees'
  | 'ensureWorktree'
  | 'cleanup'
  | 'integrate'
  | 'addSession'
  | 'addShell'
  | 'workMachine'
  | 'linearSearch'
  | 'onSessionAttention'
  | 'onSessionActivity'
  | 'recordSessionGitActivity'
  | 'onSessionTurnEnd'
  | 'onSessionRemovedOrArchived'
  | 'refreshGitState'
  | 'sweepParentBranchMovement'
  | 'refreshAssistant'
>

/** Public read/report contract. */
export type IssueReportsCapability = Pick<
  IssueReportsModule,
  | 'readyList'
  | 'blockedList'
  | 'graph'
  | 'epicStatus'
  | 'children'
  | 'tree'
  | 'deck'
  | 'depReport'
  | 'closeEligibleEpics'
  | 'labelList'
  | 'findDuplicates'
  | 'staleList'
  | 'doctor'
  | 'preflight'
  | 'orphans'
  | 'search'
  | 'searchNormalized'
  | 'count'
  | 'stats'
  | 'get'
  | 'getMeta'
  | 'getBySeq'
  | 'closedWithWork'
  | 'preloadIssues'
  | 'has'
  | 'issueForCwd'
  | 'issuesForCwds'
  | 'soleOwnerForCwd'
  | 'listEvents'
  | 'niceRef'
  | 'prime'
  | 'seatFor'
  | 'assigneeScope'
  | 'list'
  | 'resolveRef'
  | 'resolveRefs'
  | 'unreadFor'
  | 'visibilityPolicy'
  | 'commandResult'
>

export interface IssueTrackerCapabilities {
  readonly crud: IssueCrudCapability
  readonly hierarchy: IssueHierarchyCapability
  readonly commentsMail: IssueCommentsMailCapability
  readonly attention: IssueAttentionCapability
  readonly gitWorkflow: IssueGitWorkflowCapability
  readonly reports: IssueReportsCapability
}

export { DEFAULT_ISSUE_REPORT_VISIBILITY, type IssueReportVisibilityPolicy } from './reads'

/**
 * Server-side issue tracker composition root.
 *
 * Six independent capability objects share exactly one IssueStore. Cross-module
 * behavior travels through narrow constructor ports, never through another
 * module's state. Callers address the owning capability directly.
 */
class IssueServiceRoot implements IssueTrackerCapabilities {
  readonly crud: IssueCrudModule
  readonly hierarchy: IssueHierarchyModule
  readonly commentsMail: IssueCommentsMailModule
  readonly attention: IssueAttentionModule
  readonly gitWorkflow: IssueGitWorkflowModule
  readonly reports: IssueReportsModule

  /**
   * Compose the tracker without reading stored issues. Reads and bootstraps
   * use the database directly; every write names its affected records.
   */
  static compose(deps: IssueDeps): IssueServiceRoot {
    return new IssueServiceRoot(deps)
  }

  /**
   * Compose the tracker — the entry point for a caller that has no boot list of
   * its own. There is nothing to load first: since POD-6158 every issue read
   * asks the database.
   */
  static async create(deps: IssueDeps): Promise<IssueServiceRoot> {
    return IssueServiceRoot.compose(deps)
  }

  private constructor(deps: IssueDeps) {
    const store = new IssueStore(deps)

    let crud: IssueCrudModule
    let hierarchy: IssueHierarchyModule
    let commentsMail: IssueCommentsMailModule
    let attention: IssueAttentionModule
    let gitWorkflow: IssueGitWorkflowModule
    const reports = new IssueReportsModule(store)
    hierarchy = new IssueHierarchyModule(store, () => crud)
    attention = new IssueAttentionModule(
      store,
      () => crud,
      () => hierarchy,
      () => reports,
      () => gitWorkflow,
    )
    crud = new IssueCrudModule(
      store,
      () => hierarchy,
      () => attention,
      () => gitWorkflow,
      deps.onIssueClosed,
    )
    commentsMail = new IssueCommentsMailModule(store, () => reports)
    gitWorkflow = new IssueGitWorkflowModule(
      store,
      () => crud,
      () => commentsMail,
      () => attention,
    )

    this.reports = reports
    this.crud = crud
    this.hierarchy = hierarchy
    this.commentsMail = commentsMail
    this.attention = attention
    this.gitWorkflow = gitWorkflow
  }

  /** Historical cwd-only memberships are written through the session funnel
   * once. A later start checks one durable receipt instead of listing sessions. */
  async recoverLegacyMembership(): Promise<void> {
    const store = this.reports.store
    const settings = store.deps.store.settings
    const migration = 'session-issue-membership-v1'
    if (await settings.dataMigrationComplete(migration)) return
    const setSessionIssueId = store.deps.setSessionIssueId
    if (!setSessionIssueId) return
    for (const session of await store.deps.readSessionFacts()) {
      if (session.issueId != null) continue
      const issueId = await this.reports.soleOwnerForCwd(session.cwd)
      if (issueId) await setSessionIssueId(store.serverWriter, session.sessionId, issueId)
    }
    await settings.completeDataMigration(migration)
  }

  // Comment writes go through commentsMail.addComment, whose principal is
  // required. No operator/admin default is supplied by this root (POD-1315).
}

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
  type IssueTreeSession,
  UNSNOOZE_BACKDATE_MS,
} from './types'

export { IssueServiceRoot as IssueService }
