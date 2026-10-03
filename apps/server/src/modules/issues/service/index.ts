import {
  attributionOf,
  type SystemCommandPrincipal,
  systemPrincipal,
} from '../../../command-principal'
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
  | 'panelArtifactRemove'
  | 'panelArtifactRead'
  | 'create'
  | 'update'
  | 'markIssueRead'
  | 'markIssueUnread'
  | 'setIssueTucked'
  | 'prepareSoftDelete'
  | 'purgeEmptyDraft'
  | 'prepareRestore'
  | 'setLabels'
  | 'share'
  | 'unshare'
  | 'claim'
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
>

/** Public worktree, PR/merge and assistant contract. */
export type IssueGitWorkflowCapability = Pick<
  IssueGitWorkflowModule,
  | 'rehome'
  | 'start'
  | 'createAndMaybeStart'
  | 'action'
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
  | 'depReport'
  | 'closeEligibleEpics'
  | 'findDuplicates'
  | 'staleList'
  | 'lint'
  | 'doctor'
  | 'preflight'
  | 'orphans'
  | 'search'
  | 'searchNormalized'
  | 'count'
  | 'stats'
  | 'get'
  | 'getMeta'
  | 'has'
  | 'ownedTarget'
  | 'issueForCwd'
  | 'soleOwnerForCwd'
  | 'listEvents'
  | 'niceRef'
  | 'prime'
  | 'list'
  | 'resolveRef'
  | 'resolveRefs'
  | 'worktreePaths'
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
  private readonly store: IssueStore
  readonly crud: IssueCrudModule
  readonly hierarchy: IssueHierarchyModule
  readonly commentsMail: IssueCommentsMailModule
  readonly attention: IssueAttentionModule
  readonly gitWorkflow: IssueGitWorkflowModule
  readonly reports: IssueReportsModule

  /**
   * Compose the tracker WITHOUT reading anything. The caller owns hydration and
   * runs {@link IssueServiceRoot.boot} as its own boot step — this
   * is the shape a composition root needs, because at the flip a constructor
   * cannot await and `relay.ts` composes this object inside one.
   */
  static compose(deps: IssueDeps): IssueServiceRoot {
    return new IssueServiceRoot(deps)
  }

  /**
   * Compose the tracker and load the row map it serves — the entry point for a
   * caller that has no boot list of its own.
   *
   * The load is an explicit step rather than a lazy getter (POD-3256):
   * `IssueStore`'s `rows` getter used to hydrate on first touch, and a getter
   * cannot await. The body is synchronous today and gains an await at the flip.
   */
  static async create(deps: IssueDeps): Promise<IssueServiceRoot> {
    const service = IssueServiceRoot.compose(deps)
    await service.store.init()
    return service
  }

  private constructor(deps: IssueDeps) {
    const store = new IssueStore(deps)
    this.store = store

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

  // Comment writes go through commentsMail.addComment, whose principal is
  // required. No operator/admin default is supplied by this root (POD-1315).

  /** Boot hydration, membership totalization and ledger reconcile. */
  async boot(principal: SystemCommandPrincipal = systemPrincipal('boot-reconcile')): Promise<this> {
    const store = this.store
    await store.init()
    const setSessionIssueId = store.deps.setSessionIssueId
    if (setSessionIssueId) {
      let totalized = 0
      for (const session of store.deps.sessionFacts()) {
        if (session.issueId != null) continue
        const issueId = await this.reports.soleOwnerForCwd(session.cwd)
        if (!issueId) continue
        await setSessionIssueId(session.sessionId, issueId)
        totalized += 1
      }
      if (totalized > 0) {
        log.warn('boot attached legacy cwd-only sessions', { attached: totalized })
      }
    }
    try {
      const projections = await store.allProjections()
      if (projections) await store.deps.ledger.reconcile('issueProjection', projections)
      await store.reconcileCompanions()
      const depProjections = await store.allDepProjections()
      if (depProjections) await store.deps.ledger.reconcile('issueDep', depProjections)
      await store.publishRepos()
      await store.emitEvent('issue.boot_reconciled', 'system', {
        attribution: attributionOf(principal),
      })
    } catch (err) {
      log.warn('boot reconciliation record failed', { err })
    }
    return this
  }
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

import { createLogger } from '@podium/logger'

const log = createLogger('server:issues')

export { IssueServiceRoot as IssueService }
