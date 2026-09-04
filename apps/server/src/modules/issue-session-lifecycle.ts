import { createLogger } from '@podium/logger'
import { isIssueClosed, type IssueId, type IssueWire } from '@podium/model'
import type { Ledger } from '@podium/sync'
import type { IssueService } from './issues/service'
import { IssueNotFound } from './issues/service/not-found'
import type { HandoffCaller } from './sessions/handoff/ports'
import type { SessionLifecycle } from './sessions/lifecycle'
import { systemPrincipal } from '../command-principal'
import { afterCommit } from '../store/executor/synchronous-span'

const log = createLogger('server:closed-issue-reaper')

/** The periodic backstop for a close frame lost while the owning daemon was offline. */
export const CLOSED_ISSUE_SWEEP_INTERVAL_MS = 15 * 60_000

type ClosedIssueSweepReason = 'close' | 'startup' | 'periodic'

export interface DeleteIssueResult {
  issue: IssueWire
  deletedSessionIds: string[]
}

export interface RestoreIssueResult {
  issue: IssueWire
  restoredSessionIds: string[]
}

export class IssueSessionLifecycle {
  private readonly closedIssueStops = new Map<string, Promise<void>>()
  private closedIssueSweepTimer: ReturnType<typeof setInterval> | undefined
  /** True while a closed-issue sweep is running — see {@link sweepClosedIssues}. */
  private sweepingClosedIssues = false

  constructor(
    private readonly deps: {
      issues: IssueService
      sessions: SessionLifecycle
      ledger: Pick<Ledger, 'commit'>
    },
  ) {}

  /** Resume a durable conversation under one visible issue/session workflow. */
  resumeSession(input: Parameters<SessionLifecycle['resumeSession']>[0]) {
    return this.deps.sessions.resumeSession(input, this.deps.issues)
  }

  /** Recreate a freed issue worktree before respawning its parked session. */
  resurrectSession(input: Parameters<SessionLifecycle['resurrectSession']>[0]) {
    return this.deps.sessions.resurrectSession(input, this.deps.issues)
  }

  /** Park one session and free its worktree without an asynchronous ordering hop. */
  stopSession(input: Parameters<SessionLifecycle['stopSession']>[0]) {
    return this.deps.sessions.stopSession(input, this.deps.issues)
  }

  /** Stop every issue member before the single final worktree-free pass. */
  stopIssue(input: Parameters<SessionLifecycle['stopIssue']>[0]) {
    const issueId = this.deps.issues.resolveRef(input.issueId)
    return this.deps.sessions.stopIssue({ ...input, issueId }, this.deps.issues)
  }
  /**
   * Stop a closed issue through the same no-force path as `podium issue stop`.
   *
   * The issue row is the authority for the decision, not process age or a
   * daemon-local phase. Re-reading immediately before the action prevents a
   * queued close cleanup from stopping work that was reopened before it ran.
   * Dirty worktrees preserve the existing refusal and remain recoverable.
   */
  stopClosedIssue(input: {
    issueId: IssueId
    reason: ClosedIssueSweepReason
  }): void {
    void this.stopClosedIssueNow(input).catch((error) => {
      log.warn('closed issue cleanup failed', { err: error, issueId: input.issueId })
    })
  }

  private stopClosedIssueNow(input: {
    issueId: IssueId
    reason: ClosedIssueSweepReason
  }): Promise<void> {
    let issueId: IssueId
    try {
      issueId = this.deps.issues.resolveRef(input.issueId)
    } catch (error) {
      log.warn('closed-issue cleanup could not resolve its issue', {
        err: error,
        issueId: input.issueId,
        reason: input.reason,
      })
      return Promise.resolve()
    }
    const inFlight = this.closedIssueStops.get(issueId)
    if (inFlight) return inFlight

    const task = (async (): Promise<void> => {
      const current = this.deps.issues.get(issueId)
      if (!current || current.deletedAt || !isIssueClosed(current)) return
      const result = await this.stopIssue({
        issueId,
        // This is a persisted server close intent, not an agent's interactive
        // stop request. Do not defer the closing session's kill as a self-stop:
        // this callback has no reply-finalization hook, and leaving that child
        // alive is the regression this consumer exists to remove.
        reapParked: true,
        principal: systemPrincipal(
          input.reason === 'close' ? 'issue-close' : 'closed-issue-sweep',
        ),
      })
      if (!result.ok) {
        log.warn('closed issue cleanup refused', {
          issueId,
          reason: input.reason,
          cleanupReason: result.reason ?? 'unknown',
          stopped: result.stopped.length,
        })
      }
    })()
    this.closedIssueStops.set(issueId, task)
    void task.finally(() => {
      if (this.closedIssueStops.get(issueId) === task) this.closedIssueStops.delete(issueId)
    }).catch(() => {})
    return task
  }

  private async sweepClosedIssues(reason: Exclude<ClosedIssueSweepReason, 'close'>): Promise<void> {
    // SINGLE-FLIGHT (POD-3258). This one is not waiting for the async store to
    // become a hazard — it already awaits per issue inside the loop, so the
    // startup pass and the first periodic tick can be in the list at the same
    // time on any slow boot. Both would then call `stopClosedIssueNow` for the
    // same issue against the snapshot they each took before the other's stops
    // landed. Skipped, not queued: the sweep is a backstop over durable issue
    // state, so anything a dropped tick would have stopped is still closed and
    // still there for the next one.
    if (this.sweepingClosedIssues) return
    this.sweepingClosedIssues = true
    try {
      let issues: IssueWire[]
      try {
        issues = this.deps.issues.reports.list()
      } catch (error) {
        log.warn('closed issue sweep could not list issues', { err: error, reason })
        return
      }
      for (const issue of issues) {
        await this.stopClosedIssueNow({ issueId: issue.id, reason })
      }
    } finally {
      this.sweepingClosedIssues = false
    }
  }

  /** Start the boot pass and the bounded periodic backstop exactly once. */
  startClosedIssueSweep(): void {
    if (this.closedIssueSweepTimer) return
    void this.sweepClosedIssues('startup').catch((error) => {
      log.warn('closed issue startup sweep failed', { err: error })
    })
    this.closedIssueSweepTimer = setInterval(() => {
      void this.sweepClosedIssues('periodic').catch((error) => {
        log.warn('closed issue periodic sweep failed', { err: error })
      })
    }, CLOSED_ISSUE_SWEEP_INTERVAL_MS)
    this.closedIssueSweepTimer.unref?.()
  }

  dispose(): void {
    if (this.closedIssueSweepTimer) clearInterval(this.closedIssueSweepTimer)
    this.closedIssueSweepTimer = undefined
  }

  /** Carry the transport-derived caller through every handoff apply point. */
  handoffSession(input: Parameters<SessionLifecycle['handoffSession']>[0], caller: HandoffCaller) {
    return this.deps.sessions.handoffSession(input, caller, this.deps.issues)
  }
  /** Soft-delete an issue and tombstone all of its local member sessions.
   *  Both durable entity changes land in one ledger transaction; PTY teardown and
   *  broadcasts happen only after the commit succeeds. */
  deleteIssue(id: string): DeleteIssueResult {
    // Full wire is intentional: no-op deletes return the public IssueWire, and
    // projected membership is the cascade boundary this lifecycle owns.
    const current = this.deps.issues.get(id)
    if (!current) throw new IssueNotFound(id)
    if (current.deletedAt) return { issue: current, deletedSessionIds: [] }

    const sessionPlan = this.deps.sessions.prepareIssueSessionDelete(
      current.id,
      current.worktreePath,
    )
    const deletedIds = new Set(sessionPlan.sessionIds)
    const remainingSessions = this.deps.sessions
      .listSessions(undefined, 'issueDeleteRestore')
      .filter((s) => !deletedIds.has(s.sessionId))
    const issuePlan = this.deps.issues.prepareSoftDelete(current.id, remainingSessions)

    this.deps.ledger.commit({
      write: () => {
        sessionPlan.write()
        issuePlan.write()
      },
      changes: () => [...sessionPlan.changes(), ...issuePlan.changes()],
      // THE RUNTIME HALF WAITS FOR THE OUTERMOST COMMIT [POD-3366]. It used to
      // run on the statement after this call, and when a caller already has a
      // span open that statement is on the success path of a SAVEPOINT release,
      // not of a commit. What it does is irreversible — `removeSessionRuntime`
      // detaches every client and the PTY — so running it while the tombstone
      // can still be rolled back tears down a session the database keeps.
      //
      // Deferring is also the right answer for the in-window reader, which here
      // is anything listing sessions inside the enclosing span: it sees the
      // session still alive, and if that span rolls back the session IS still
      // alive, so the map was right the whole time.
      apply: (_result, changes) => {
        const ledgerCursor = changes.at(-1)?.seq
        if (ledgerCursor === undefined) {
          throw new Error('issue/session delete committed no changes')
        }
        sessionPlan.apply(changes, ledgerCursor)
        issuePlan.apply()
      },
    })
    // The two BROADCASTS are mechanism 3, not mechanism 1, and they are
    // registered separately for that reason: a fan-out failure is an external
    // effect nobody waits for, and routing it through the commit application
    // above would report a socket problem as a divergent projection.
    afterCommit(() => {
      this.deps.sessions.broadcastSessions()
      issuePlan.publish()
    }, 'issue-session-delete-broadcast')

    return { issue: issuePlan.wire(), deletedSessionIds: sessionPlan.sessionIds }
  }
  /** Restore an issue and the exact sessions tombstoned by its deletion. Session
   *  metadata returns as exited because the deletion deliberately killed the PTY;
   *  resumable sessions can then be started through the normal resurrection path. */
  restoreIssue(id: string): RestoreIssueResult {
    // Full wire is intentional for the symmetric public/no-op return contract.
    const current = this.deps.issues.get(id)
    if (!current) throw new IssueNotFound(id)
    if (!current.deletedAt) return { issue: current, restoredSessionIds: [] }

    const sessionPlan = this.deps.sessions.prepareIssueSessionRestore(current.id)
    const restoredIds = new Set(sessionPlan.sessionIds)
    const restoredSessions = [
      ...this.deps.sessions
        .listSessions(undefined, 'issueDeleteRestore')
        .filter((s) => !restoredIds.has(s.sessionId)),
      ...sessionPlan.restoredSessions,
    ]
    const issuePlan = this.deps.issues.prepareRestore(current.id, restoredSessions)

    this.deps.ledger.commit({
      write: () => {
        sessionPlan.write()
        issuePlan.write()
      },
      changes: () => [...sessionPlan.changes(), ...issuePlan.changes()],
      // The same argument as the delete above, in the other direction: the
      // restore's apply INSTALLS runtime sessions and reloads the session state,
      // and installing a live session for a restore the enclosing span can still
      // roll back leaves the map holding sessions no row backs [POD-3366].
      apply: (_result, changes) => {
        const ledgerCursor = changes.at(-1)?.seq
        if (ledgerCursor === undefined) {
          throw new Error('issue/session restore committed no changes')
        }
        sessionPlan.apply(changes, ledgerCursor)
        issuePlan.apply()
      },
    })
    afterCommit(() => {
      this.deps.sessions.broadcastSessions()
      issuePlan.publish()
    }, 'issue-session-restore-broadcast')

    return {
      issue: issuePlan.wire(),
      restoredSessionIds: sessionPlan.sessionIds,
    }
  }
}
