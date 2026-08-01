import {
  attributionOf,
  type SystemCommandPrincipal,
  systemPrincipal,
} from '../../../command-principal'
import { IssueAttentionMethods } from './attention'
import { IssueStore } from './core'
import { IssueCrudMethods } from './crud'
import { IssueHierarchyMethods } from './hierarchy'
import { IssueCommentsMailMethods } from './mail'
import {
  DEFAULT_ISSUE_REPORT_VISIBILITY,
  IssueReportsMethods,
  type IssueReportVisibilityPolicy,
} from './reads'
import type { IssueDeps } from './types'
import { IssueGitWorkflowMethods } from './workflow'

/** Public command-facing CRUD and stage-machine contract. */
export type IssueCrudCapability = Pick<
  IssueCrudMethods,
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
  IssueHierarchyMethods,
  | 'addDep'
  | 'removeDep'
  | 'reparent'
  | 'ancestorIds'
  | 'inProposedSubtree'
  | 'supersede'
  | 'duplicate'
>

/** Public comments and tracker-mail contract. */
export type IssueCommentsMailCapability = Pick<IssueReportsMethods, 'comments'> &
  Pick<
    IssueCommentsMailMethods,
    'addComment' | 'sendMail' | 'mailInbox' | 'mailClaim' | 'mailPending' | 'mailMessage'
  >

/** Public attention, per-user markers and subscription contract. */
export type IssueAttentionCapability = Pick<
  IssueAttentionMethods,
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
> &
  Pick<
    IssueCrudMethods,
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
  IssueGitWorkflowMethods,
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
  IssueReportsMethods,
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
> &
  Pick<IssueStore, 'list' | 'resolveRef' | 'worktreePaths' | 'unreadFor'> & {
    readonly visibilityPolicy: Readonly<IssueReportVisibilityPolicy>
  }

export interface IssueTrackerCapabilities {
  readonly crud: IssueCrudCapability
  readonly hierarchy: IssueHierarchyCapability
  readonly commentsMail: IssueCommentsMailCapability
  readonly attention: IssueAttentionCapability
  readonly gitWorkflow: IssueGitWorkflowCapability
  readonly reports: IssueReportsCapability
}

export { DEFAULT_ISSUE_REPORT_VISIBILITY, type IssueReportVisibilityPolicy } from './reads'

type IssueCapabilityHost = IssueStore &
  IssueReportsMethods &
  IssueCrudMethods &
  IssueHierarchyMethods &
  IssueAttentionMethods &
  IssueCommentsMailMethods &
  IssueGitWorkflowMethods

/** Install one stateless method set onto the single mutable IssueStore. */
function installMethods(host: object, methods: object): void {
  for (const key of Reflect.ownKeys(methods)) {
    if (key === 'constructor') continue
    const descriptor = Object.getOwnPropertyDescriptor(methods, key)
    if (descriptor) Object.defineProperty(host, key, descriptor)
  }
}

/**
 * Server-side issue tracker composition root.
 *
 * Capability modules are stateless method sets over exactly one IssueStore.
 * Command handlers receive {@link IssueTrackerCapabilities}; the Proxy is a
 * compatibility face for older non-command integrations while they migrate.
 */
export interface IssueService extends IssueCapabilityHost {}
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: this is the temporary typed compatibility face for non-command callers.
export class IssueService implements IssueTrackerCapabilities {
  private readonly store: IssueCapabilityHost
  readonly crud: IssueCrudCapability
  readonly hierarchy: IssueHierarchyCapability
  readonly commentsMail: IssueCommentsMailCapability
  readonly attention: IssueAttentionCapability
  readonly gitWorkflow: IssueGitWorkflowCapability
  readonly reports: IssueReportsCapability

  constructor(deps: IssueDeps) {
    const store = new IssueStore(deps) as IssueCapabilityHost
    installMethods(store, IssueReportsMethods.prototype)
    installMethods(store, IssueCrudMethods.prototype)
    installMethods(store, IssueHierarchyMethods.prototype)
    installMethods(store, IssueAttentionMethods.prototype)
    installMethods(store, IssueCommentsMailMethods.prototype)
    installMethods(store, IssueGitWorkflowMethods.prototype)
    this.store = store

    this.crud = store
    this.hierarchy = store
    this.commentsMail = store
    this.attention = store
    this.gitWorkflow = store
    Object.defineProperty(store, 'visibilityPolicy', {
      value: DEFAULT_ISSUE_REPORT_VISIBILITY,
      enumerable: true,
      writable: false,
    })
    this.reports = store as unknown as IssueReportsCapability

    // biome-ignore lint/correctness/noConstructorReturn: the compatibility face must preserve legacy `svc.method()` interception while commands use capabilities.
    return new Proxy(this, {
      has: (target, property) => Reflect.has(target, property) || Reflect.has(store, property),
      get: (target, property, receiver) => {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
        const value = Reflect.get(store, property, store)
        return typeof value === 'function' ? value.bind(store) : value
      },
      set: (target, property, value, receiver) => {
        if (Reflect.has(target, property)) return Reflect.set(target, property, value, receiver)
        return Reflect.set(store, property, value, store)
      },
      getOwnPropertyDescriptor: (target, property) =>
        Reflect.getOwnPropertyDescriptor(target, property) ??
        Reflect.getOwnPropertyDescriptor(store, property),
      defineProperty: (target, property, descriptor) =>
        Reflect.has(store, property)
          ? Reflect.defineProperty(store, property, descriptor)
          : Reflect.defineProperty(target, property, descriptor),
    })
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
