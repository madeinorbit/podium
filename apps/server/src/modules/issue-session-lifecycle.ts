import { createLogger } from '@podium/logger'
import type { IssueId, IssueWire } from '@podium/model'
import type { Ledger } from '@podium/sync'
import type { IssueService } from './issues/service'
import { IssueNotFound } from './issues/service/not-found'
import type { HandoffCaller } from './sessions/handoff/ports'
import type { SessionLifecycle } from './sessions/lifecycle'
import { systemPrincipal } from '../command-principal'

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
      if (!current || current.deletedAt || !current.closed) return
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

    const { changes } = this.deps.ledger.commit({
      write: () => {
        sessionPlan.write()
        issuePlan.write()
      },
      changes: () => [...sessionPlan.changes(), ...issuePlan.changes()],
    })
    const ledgerCursor = changes.at(-1)?.seq
    if (ledgerCursor === undefined) throw new Error('issue/session delete committed no changes')

    sessionPlan.apply(changes, ledgerCursor)
    issuePlan.apply()
    this.deps.sessions.broadcastSessions()
    issuePlan.publish()

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

    const { changes } = this.deps.ledger.commit({
      write: () => {
        sessionPlan.write()
        issuePlan.write()
      },
      changes: () => [...sessionPlan.changes(), ...issuePlan.changes()],
    })
    const ledgerCursor = changes.at(-1)?.seq
    if (ledgerCursor === undefined) throw new Error('issue/session restore committed no changes')

    sessionPlan.apply(changes, ledgerCursor)
    issuePlan.apply()
    this.deps.sessions.broadcastSessions()
    issuePlan.publish()

    return {
      issue: issuePlan.wire(),
      restoredSessionIds: sessionPlan.sessionIds,
    }
  }
}
