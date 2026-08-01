import { IssueServiceWorkflow } from './workflow'
import {
  attributionOf,
  systemPrincipal,
  type SystemCommandPrincipal,
} from '../../../command-principal'

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
export class IssueService extends IssueServiceWorkflow {
  /**
   * Boot-time lifecycle hook (the composition root calls this once, replacing
   * the old inline relay-constructor sequence): eager hydration, the
   * leaked-draft reap, and the ledger boot reconcile — a cursor-holding
   * client that reconnects heals via changesSince instead of silently missing
   * the gap.
   */
  boot(principal: SystemCommandPrincipal = systemPrincipal('boot-reconcile')): this {
    this.init()
    // One-shot membership totalization [POD-856]: historical sessions predate
    // sessions.issue_id, while the normalized replica indexes membership ONLY by
    // that field. Reuse soleOwnerForCwd verbatim so repo-root claims, archived
    // owners, and ambiguous equal-depth owners remain excluded exactly as at
    // spawn. Route every stamp through the injected session mutation seam: it
    // persists normally and the coalesced session/issue feed re-emits. Running
    // before draft reaping also prevents a living cwd-only session from looking
    // like an empty leaked draft. The null guard makes every later boot a no-op.
    const setSessionIssueId = this.deps.setSessionIssueId
    if (setSessionIssueId) {
      let totalized = 0
      for (const session of this.deps.listSessions()) {
        if (session.issueId != null) continue
        const issueId = this.soleOwnerForCwd(session.cwd)
        if (!issueId) continue
        setSessionIssueId(session.sessionId, issueId)
        totalized += 1
      }
      if (totalized > 0) {
        console.warn(`[podium:issues] boot attached ${totalized} legacy cwd-only session(s)`)
      }
    }
    // Reap draft issues leaked before the kill-path reaper existed (sessions
    // killed/removed while attached to an empty draft). Sessions are hydrated
    // by the composition root BEFORE boot(), so the emptiness predicate sees
    // real statuses: live sessions come back as 'reconnecting' (not 'exited')
    // and hibernated stays 'hibernated' — both block the reap.
    try {
      const reaped = this.reapLeakedDrafts()
      if (reaped > 0) {
        console.warn(`[podium:issues] boot sweep reaped ${reaped} leaked draft issue(s)`)
      }
    } catch (err) {
      console.warn('[podium:issues] boot draft sweep failed:', err)
    }
    // Ledger boot reconcile ([spec:SP-3fe2] #255): full LOCAL wire truth diffed
    // against the persisted baseline (including removes), no fan-out — same
    // local-only list the legacy funnel.record boot pass fed the oplog.
    try {
      this.deps.ledger.reconcile(
        'issue',
        this.allWire().map((i) => ({ id: i.id, value: i })),
      )
      // The normalized kind seeds its baseline in the same boot pass [POD-796],
      // so a projection feed that was enabled while the server was down starts
      // from truth rather than replaying every issue as new on the first write.
      const projections = this.allProjections()
      if (projections) this.deps.ledger.reconcile('issueProjection', projections)
      // The two kinds the replica joins against seed here too [POD-822]. Boot is
      // the only pass that can heal them: edges and prefixes both change through
      // paths with no ledger commit of their own (an issue delete CASCADEs its
      // edges away; a prefix is written by the repo registry), so a change made
      // while the server was down is invisible to every declared-change path and
      // only a full-truth diff finds it.
      const depProjections = this.allDepProjections()
      if (depProjections) this.deps.ledger.reconcile('issueDep', depProjections)
      this.publishRepos()
      this.emitEvent('issue.boot_reconciled', 'system', { attribution: attributionOf(principal) })
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
