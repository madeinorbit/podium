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
export class IssueService extends IssueServiceWorkflow {
  /**
   * Boot-time lifecycle hook (the composition root calls this once, replacing
   * the old inline relay-constructor sequence): eager hydration, the
   * leaked-draft reap, and the oplog boot-reconciliation record — a
   * cursor-holding client that reconnects heals via changesSince instead of
   * silently missing the gap.
   */
  boot(): this {
    this.init()
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
    try {
      this.deps.funnel.record?.(
        'issue',
        this.allWire().map((i) => ({ id: i.id, value: i })),
      )
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
  UNSNOOZE_BACKDATE_MS,
} from './types'
