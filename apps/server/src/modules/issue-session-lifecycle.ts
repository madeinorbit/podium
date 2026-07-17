import type { IssueWire } from '@podium/protocol'
import type { Ledger } from '@podium/sync'
import type { IssueService } from './issues/service'
import type { SessionsService } from './sessions/service'

export interface DeleteIssueResult {
  issue: IssueWire
  deletedSessionIds: string[]
}

export interface RestoreIssueResult {
  issue: IssueWire
  restoredSessionIds: string[]
}

export class IssueSessionLifecycle {
  constructor(
    private readonly deps: {
      issues: IssueService
      sessions: SessionsService
      ledger: Pick<Ledger, 'commit'>
    },
  ) {}

  /** Soft-delete an issue and tombstone all of its local member sessions.
   *  Both durable entity changes land in one ledger transaction; PTY teardown and
   *  broadcasts happen only after the commit succeeds. */
  deleteIssue(id: string): DeleteIssueResult {
    // Full wire is intentional: no-op deletes return the public IssueWire, and
    // projected membership is the cascade boundary this lifecycle owns.
    const current = this.deps.issues.get(id)
    if (!current) throw new Error(`unknown issue ${id}`)
    if (current.deletedAt) return { issue: current, deletedSessionIds: [] }

    const sessionPlan = this.deps.sessions.prepareIssueSessionDelete(
      current.id,
      current.worktreePath,
    )
    const deletedIds = new Set(sessionPlan.sessionIds)
    const remainingSessions = this.deps.sessions
      .listSessions()
      .filter((s) => !deletedIds.has(s.sessionId))
    const issuePlan = this.deps.issues.prepareSoftDelete(current.id, remainingSessions)

    this.deps.ledger.commit({
      write: () => {
        sessionPlan.write()
        issuePlan.write()
      },
      changes: () => [...sessionPlan.changes(), ...issuePlan.changes()],
    })

    sessionPlan.apply()
    issuePlan.apply()
    this.deps.sessions.broadcastSessions()
    issuePlan.publish()

    return { issue: issuePlan.wire, deletedSessionIds: sessionPlan.sessionIds }
  }
  /** Restore an issue and the exact sessions tombstoned by its deletion. Session
   *  metadata returns as exited because the deletion deliberately killed the PTY;
   *  resumable sessions can then be started through the normal resurrection path. */
  restoreIssue(id: string): RestoreIssueResult {
    // Full wire is intentional for the symmetric public/no-op return contract.
    const current = this.deps.issues.get(id)
    if (!current) throw new Error(`unknown issue ${id}`)
    if (!current.deletedAt) return { issue: current, restoredSessionIds: [] }

    const sessionPlan = this.deps.sessions.prepareIssueSessionRestore(current.id)
    const restoredIds = new Set(sessionPlan.sessionIds)
    const restoredSessions = [
      ...this.deps.sessions.listSessions().filter((s) => !restoredIds.has(s.sessionId)),
      ...sessionPlan.restoredSessions,
    ]
    const issuePlan = this.deps.issues.prepareRestore(current.id, restoredSessions)

    this.deps.ledger.commit({
      write: () => {
        sessionPlan.write()
        issuePlan.write()
      },
      changes: () => [...sessionPlan.changes(), ...issuePlan.changes()],
    })

    sessionPlan.apply()
    issuePlan.apply()
    this.deps.sessions.broadcastSessions()
    issuePlan.publish()

    return {
      issue: issuePlan.wire,
      restoredSessionIds: sessionPlan.sessionIds,
    }
  }
}
