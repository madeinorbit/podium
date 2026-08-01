import {
  attributionOf,
  type CommandPrincipal,
  FIRST_ADMIN_USER_ID,
  type SystemCommandPrincipal,
  systemPrincipal,
  userCommandPrincipal,
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
  | 'panelArtifactRemove'
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
  'comments' | 'addComment' | 'sendMail' | 'mailInbox' | 'mailClaim' | 'mailPending' | 'mailMessage'
>

/** Public attention, per-user markers and subscription contract. */
export type IssueAttentionCapability = Pick<
  IssueAttentionModule,
  | 'attachSession'
  | 'reapIfEmptyDraft'
  | 'reapLeakedDrafts'
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
  | 'worktreePaths'
  | 'unreadFor'
  | 'visibilityPolicy'
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

type PublicSurface<T> = Pick<T, keyof T>

type IssueLegacySurface = PublicSurface<IssueStore> &
  PublicSurface<IssueReportsModule> &
  PublicSurface<IssueCrudModule> &
  PublicSurface<IssueHierarchyModule> &
  PublicSurface<IssueAttentionModule> &
  PublicSurface<IssueCommentsMailModule> &
  PublicSurface<IssueGitWorkflowModule>

/**
 * Server-side issue tracker composition root.
 *
 * Six independent capability objects share exactly one IssueStore. Cross-module
 * behavior travels through narrow constructor ports, never through another
 * module's state. The Proxy only preserves the legacy flat service API: it
 * forwards each old call to its owning object and never copies methods.
 */
class IssueServiceRoot implements IssueTrackerCapabilities {
  private readonly store: IssueStore
  readonly crud: IssueCrudModule
  readonly hierarchy: IssueHierarchyModule
  readonly commentsMail: IssueCommentsMailModule
  readonly attention: IssueAttentionModule
  readonly gitWorkflow: IssueGitWorkflowModule
  readonly reports: IssueReportsModule
  private readonly legacyOwners: object[]

  constructor(deps: IssueDeps) {
    const store = new IssueStore(deps)
    this.store = store

    let crud: IssueCrudModule
    let hierarchy: IssueHierarchyModule
    let commentsMail: IssueCommentsMailModule
    let attention: IssueAttentionModule
    const reports = new IssueReportsModule(store)
    hierarchy = new IssueHierarchyModule(store, () => crud)
    attention = new IssueAttentionModule(
      store,
      () => crud,
      () => hierarchy,
      () => reports,
    )
    crud = new IssueCrudModule(
      store,
      () => hierarchy,
      () => attention,
    )
    commentsMail = new IssueCommentsMailModule(store, () => reports)
    const gitWorkflow = new IssueGitWorkflowModule(
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
    this.legacyOwners = [store, reports, crud, hierarchy, attention, commentsMail, gitWorkflow]

    const ownerOf = (property: PropertyKey): object | undefined =>
      this.legacyOwners.find((owner) => Reflect.has(owner, property))
    const descriptorOf = (owner: object, property: PropertyKey): PropertyDescriptor | undefined => {
      let current: object | null = owner
      while (current) {
        const descriptor = Reflect.getOwnPropertyDescriptor(current, property)
        if (descriptor) return descriptor
        current = Reflect.getPrototypeOf(current)
      }
      return undefined
    }

    // biome-ignore lint/correctness/noConstructorReturn: compatibility-only forwarding; behavior stays on the owning store/module object.
    return new Proxy(this, {
      has: (target, property) => Reflect.has(target, property) || ownerOf(property) !== undefined,
      get: (target, property, receiver) => {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
        const owner = ownerOf(property)
        if (!owner) return undefined
        const value = Reflect.get(owner, property, owner)
        return typeof value === 'function' ? value.bind(owner) : value
      },
      set: (target, property, value, receiver) => {
        if (Reflect.has(target, property)) return Reflect.set(target, property, value, receiver)
        const owner = ownerOf(property)
        return owner ? Reflect.set(owner, property, value, owner) : false
      },
      getOwnPropertyDescriptor: (target, property) => {
        const own = Reflect.getOwnPropertyDescriptor(target, property)
        if (own) return own
        const owner = ownerOf(property)
        return owner ? descriptorOf(owner, property) : undefined
      },
      defineProperty: (target, property, descriptor) => {
        const owner = ownerOf(property)
        return owner
          ? Reflect.defineProperty(owner, property, descriptor)
          : Reflect.defineProperty(target, property, descriptor)
      },
    })
  }

  /**
   * The flat legacy service is an authenticated in-process operator seam. Keep
   * its comment attribution aligned with CLI/tRPC while the capability module
   * itself continues to require transport callers to pass their principal.
   */
  addComment(
    id: string,
    author: string,
    body: string,
    principal: CommandPrincipal = userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin'),
  ): ReturnType<IssueCommentsMailModule['addComment']> {
    return this.commentsMail.addComment(id, author, body, principal)
  }

  /** Boot hydration, membership totalization, draft reap and ledger reconcile. */
  boot(principal: SystemCommandPrincipal = systemPrincipal('boot-reconcile')): this {
    const store = this.store
    store.init()
    const setSessionIssueId = store.deps.setSessionIssueId
    if (setSessionIssueId) {
      let totalized = 0
      for (const session of store.deps.listSessions()) {
        if (session.issueId != null) continue
        const issueId = this.reports.soleOwnerForCwd(session.cwd)
        if (!issueId) continue
        setSessionIssueId(session.sessionId, issueId)
        totalized += 1
      }
      if (totalized > 0) {
        console.warn(`[podium:issues] boot attached ${totalized} legacy cwd-only session(s)`)
      }
    }
    try {
      const reaped = this.attention.reapLeakedDrafts()
      if (reaped > 0) {
        console.warn(`[podium:issues] boot sweep reaped ${reaped} leaked draft issue(s)`)
      }
    } catch (err) {
      console.warn('[podium:issues] boot draft sweep failed:', err)
    }
    try {
      store.deps.ledger.reconcile(
        'issue',
        store.allWire().map((i) => ({ id: i.id, value: i })),
      )
      const projections = store.allProjections()
      if (projections) store.deps.ledger.reconcile('issueProjection', projections)
      const depProjections = store.allDepProjections()
      if (depProjections) store.deps.ledger.reconcile('issueDep', depProjections)
      store.publishRepos()
      store.emitEvent('issue.boot_reconciled', 'system', { attribution: attributionOf(principal) })
    } catch (err) {
      console.warn('[podium:issues] boot reconciliation record failed:', err)
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

/**
 * Typed compatibility value for legacy callers while command handlers consume
 * IssueTrackerCapabilities. Runtime behavior remains on the owning capability.
 */
export type IssueService = IssueServiceRoot & IssueLegacySurface
export const IssueService = IssueServiceRoot as unknown as {
  new (deps: IssueDeps): IssueService
}
