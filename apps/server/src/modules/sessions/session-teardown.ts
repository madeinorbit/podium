/**
 * ENDING A SESSION (POD-1396, from POD-1385's god-object audit).
 *
 * One job: take a live (or already-parked) session and tear it down in one of
 * four ways that differ ONLY in what survives. That survival table is the whole
 * design, and it lives here so a reader cannot collapse two of the operations:
 *
 * | operation          | process     | worktree           | branch | transcript | row          | resume ref |
 * | ------------------ | ----------- | ------------------ | ------ | ---------- | ------------ | ---------- |
 * | `hibernateSession` | killed      | **kept**           | kept   | kept       | kept         | **required** — refuses without one rather than silently becoming a kill |
 * | `stopSession`      | killed      | **freed** when safe| kept   | kept       | kept         | kept       |
 * | `stopIssue`        | all killed  | freed              | kept   | kept       | kept         | kept       |
 * | `killSession`      | killed      | —                  | —      | kept       | **tombstoned** | —        |
 *
 * Six of the twelve methods call each other and moved together: `stopSession`,
 * `killStoppedSession`, `removeSessionRuntime`, `sessionRemovalSpecs`,
 * `emitSessionExited`, `maybeReapDraftIssue`. The other six are the public
 * entry points and the archive-park side door.
 *
 * ---------------------------------------------------------------------------
 * ORDERING CONTRACT inside `killSession` — load-bearing (#247)
 * ---------------------------------------------------------------------------
 *
 * The durable tombstone commits FIRST, live teardown after. A commit throw must
 * leave the session fully alive — still in the map, clients attached, PTY not
 * signalled — and propagate to the caller, rather than tearing down live state
 * for a row the rolled-back transaction still holds. The remove change also
 * commits in the SAME transaction as the tombstone ([spec:SP-3fe2]) so the
 * durable change log can never say something the sessions table does not.
 * Reversing either is invisible to types and to a passing build.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 *
 * Whether a session *may* be parked. Hibernation is a **reader** of
 * {@link SessionTerminalProof} — it never second-guesses the proof. The proof
 * module gathers and judges; this module only consumes the answer.
 *
 * Dispose: none. No timer, loop, or async work is owned here. Kill frames and
 * bus emits are fire-and-forget through ports.
 */

import type { SessionId, SessionMeta } from '@podium/model'
import {
  AUTO_ARCHIVE_READ_WINDOW_MS,
  type ControlMessage,
  type MetadataChange,
} from '@podium/protocol'
import type { EntityChangeSpec } from '@podium/sync'
import type { AutoContinueController } from '../../auto-continue'
import {
  type CommandPrincipal,
  systemPrincipal,
} from '../../command-principal'
import type { ClientRegistry } from '../../gateway/client-registry'
import {
  liveSessionsUsingWorktree,
  sessionsForIssue,
} from '../../issue-util'
import type { SessionStore } from '../../store'
import type { EventBus } from '../bus'
import type { DurableIssueAccessIndex } from '../issues/access-index'
import type { DaemonRpcService } from '../machines/rpc'
import type { MachinesService } from '../machines/service'
import type { SessionDaemonProjection } from './daemon-projection'
import type { SessionIssueWorkflowPort } from './issue-workflow-port'
import type { SessionRepository } from './repository'
import type { Session } from './session'
import type { SessionStateService } from './session-state/service'
import type { SessionTerminalProof } from './terminal-proof'
import type { SessionView } from './view'

/** Only the ledger face killSession needs — avoids importing lifecycle for a type. */
export type TeardownLedger = {
  commit<T>(op: { write: () => T; changes: (result: T) => EntityChangeSpec[] }): {
    result: T
    changes: MetadataChange[]
  }
}

/**
 * Ports across the lifecycle boundary. Measured, not guessed — every member is
 * already a collaborator or an existing port on SessionLifecycle. None of them
 * reaches into another module's internals.
 */
export interface SessionTeardownPorts {
  store: SessionStore
  view: SessionView
  repository: SessionRepository
  state: SessionStateService
  terminalProof: SessionTerminalProof
  autoContinue: Pick<AutoContinueController, 'onSessionGone'>
  /** Live session map. Shared by reference with lifecycle; this module deletes. */
  sessions: Map<SessionId, Session>
  clients: ClientRegistry
  bus: EventBus
  machines: Pick<MachinesService, 'defaultMachine'>
  rpc: DaemonRpcService
  daemonProjection: Pick<SessionDaemonProjection, 'disposeTitle'>
  now(): number
  listSessions(): SessionMeta[]
  setArchived(input: { sessionId: SessionId; archived: boolean }): void
  rearmUnread(sessionId: SessionId): void
  toMachine(machineId: string, message: ControlMessage): void
  broadcastSessions(): void
  /** Issue meta / cwd ownership for stop/stopIssue. */
  issueAccess: DurableIssueAccessIndex
  /** Snapshot tail for auto-archive parent-issue check. */
  snapshotTail(): { issues: { id: string; parentId?: string | null }[] }
  /** Write-seam change log for killSession's atomic tombstone. */
  ledger: TeardownLedger
}

export class SessionTeardown {
  constructor(private readonly ports: SessionTeardownPorts) {}

  /**
   * Archive also stops the process (POD-108). Archive used to be pure metadata,
   * so every archived-but-live session kept its abduco master + agent resident
   * forever — dozens of idle agent processes with no way to reap them from the
   * UI. Same park as stopSession: 'hibernated' when a cold resume is possible
   * (resume ref kept), else 'exited'. Unlike hibernateSession this does not
   * refuse a working agent — the archive guard already made the user confirm
   * archiving a working session, and that confirmed intent is "stop it".
   * Unarchiving does NOT resurrect; that stays an explicit resume.
   */
  parkArchivedSession(sessionId: SessionId): void {
    const session = this.ports.sessions.get(sessionId)
    if (!session) return
    const running =
      session.status === 'live' ||
      session.status === 'starting' ||
      session.status === 'reconnecting'
    if (!running) return
    if (session.agentKind !== 'shell' && !session.resume) {
      session.status = 'exited'
      session.exitCode = session.exitCode ?? 0
    } else {
      session.status = 'hibernated'
    }
    this.ports.autoContinue.onSessionGone(sessionId)
    session.stoppedAt = new Date(this.ports.now()).toISOString()
    session.stopReason = 'parent'
    // Unlike stopSession, readAt is left alone: archiving IS the acknowledgment —
    // resurfacing the session as unread would undo the tidy-up the user just did.
    this.ports.repository.persist(session)
    this.killStoppedSession(session)
    this.ports.broadcastSessions()
  }

  /** Authoritatively revalidate a stopped-session decay proposal [spec:SP-6144]. */
  tryAutoArchiveStoppedObserved(
    observed: {
      sessionId: SessionId
      issueId: string | null
      stoppedAt: string
      readerUserId: string
      archived: false
    },
    nowMs: number,
  ): 'applied' | 'precondition' | 'not-due' {
    const session = this.ports.sessions.get(observed.sessionId)
    if (!session || session.archived) return 'precondition'
    // WHOSE read (POD-1229) — see `IssueAttention.tryAutoArchiveObserved` for the
    // reasoning. `archived` is shared, so only the viewer this service archives
    // for may gate it, and a proposal naming anyone else is refused outright.
    if (observed.readerUserId !== this.ports.view.broadcastViewer()) return 'precondition'
    // NO compare-and-swap against an observed timestamp (POD-1229 removed it),
    // and no `readAt == null` clause here either: both cases the CAS caught are
    // refused by the checks below — a re-read lands inside the `not-due` window,
    // and a mark-unread makes `Date.parse(null ?? '')` NaN. A guard that can be
    // deleted with every test still green is indistinguishable from an absent
    // one, so the refusal lives in exactly one place.
    if (
      (session.issueId ?? null) !== observed.issueId ||
      session.stoppedAt !== observed.stoppedAt
    ) {
      return 'precondition'
    }
    const stoppedMs = Date.parse(session.stoppedAt ?? '')
    const readMs = Date.parse(this.ports.view.overlay(observed.sessionId).readAt ?? '')
    if (!Number.isFinite(stoppedMs) || !Number.isFinite(readMs) || readMs < stoppedMs) {
      return 'precondition'
    }
    if (Math.max(stoppedMs, readMs) > nowMs - AUTO_ARCHIVE_READ_WINDOW_MS) return 'not-due'
    if (session.issueId) {
      const issue = this.ports
        .snapshotTail()
        .issues.find((candidate) => candidate.id === session.issueId)
      if (!issue || issue.parentId) return 'precondition'
    }
    this.ports.setArchived({ sessionId: session.sessionId, archived: true })
    return 'applied'
  }

  /**
   * Cleanly end a session [spec:SP-9904]: stop its process, free the issue
   * worktree when safe, KEEP branch + transcript + session row (reversible —
   * resume recreates the worktree from the branch). Distinct from hibernate
   * (keeps worktree) and kill/delete (removes the row).
   *
   * Unsaved-work guard: dirty/conflicted working tree refuses without `force`.
   * Self-stop (`selfStop`) defers the process kill so the CLI/relay reply
   * lands before the agent dies.
   */
  async stopSession(
    input: {
      sessionId: SessionId
      force?: boolean
      /** True when the CALLER is stopping itself — defer process kill. */
      selfStop?: boolean
      /** Parent-close/issue-stop provenance; direct forced stops derive below. */
      stopReason?: 'self' | 'parent' | 'forced'
      /**
       * Who asked for the stop (POD-1344). Stamped onto the free-worktree audit
       * comment. Absent only on genuinely caller-less paths (tests, in-process
       * jobs) — those fall back to `systemPrincipal('stop')`.
       */
      principal?: CommandPrincipal
    },
    issues: SessionIssueWorkflowPort,
  ): Promise<{
    ok: boolean
    reason?: string
    worktreeFreed?: boolean
    deferredKill?: boolean
  }> {
    const session = this.ports.sessions.get(input.sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }

    const issueId = session.issueId ?? this.ports.issueAccess.issueForCwd(session.cwd)
    const issue = issueId ? this.ports.issueAccess.getMeta(issueId) : undefined
    const worktreePath = issue?.worktreePath ?? null

    // Unsaved-work guard: inspect the working copy when present. Branch commits
    // alone are not a refusal — the branch is always kept.
    if (worktreePath && !input.force) {
      const st = await this.ports.rpc.repoOp('status', worktreePath, undefined, session.machineId)
      if (st.ok) {
        const dirty = st.output.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('## '))
        if (dirty.length > 0) {
          return {
            ok: false,
            reason: `refusing stop: unsaved changes in the working tree (re-run with --force to free the worktree and discard them; branch is kept either way):\n${dirty.join('\n')}`,
          }
        }
      } else if (!/cannot change to .*: no such file or directory/i.test(st.output)) {
        return {
          ok: false,
          reason: `refusing stop: cannot inspect worktree: ${st.output}`,
        }
      }
    }

    const wasRunning =
      session.status === 'live' ||
      session.status === 'starting' ||
      session.status === 'reconnecting'

    // Park the row first (keep resume ref + transcript). Shells have no resume
    // ref — stop still parks them as exited so they stay inspectable.
    if (wasRunning) {
      if (session.agentKind !== 'shell' && !session.resume) {
        // No resume ref yet: still stop the process but mark exited rather than
        // hibernated (same inspectability; resume may not recover conversation).
        session.status = 'exited'
        session.exitCode = session.exitCode ?? 0
      } else {
        session.status = 'hibernated'
      }
      this.ports.autoContinue.onSessionGone(input.sessionId)
      // A terminal transition is new unread information; acknowledgment begins only
      // after the operator opens it again. [spec:SP-6144]
      session.stoppedAt = new Date(this.ports.now()).toISOString()
      // 'forced' is reserved for --force (work may be discarded); a plain
      // operator/parent stop is an orderly park, labeled 'parent'. [spec:SP-6144]
      session.stopReason = input.force
        ? 'forced'
        : (input.stopReason ?? (input.selfStop ? 'self' : 'parent'))
      this.ports.rearmUnread(input.sessionId)
      this.ports.repository.persist(session, () =>
        this.ports.store.observationCheckpoints.cancelTerminalCandidate(input.sessionId),
      )
      this.ports.broadcastSessions()
    } else if (session.status !== 'hibernated' && session.status !== 'exited') {
      return { ok: false, reason: `cannot stop session in status '${session.status}'` }
    }

    // Free worktree only when no OTHER live session still uses the path —
    // including sessions attached to a different issue but running in this
    // worktree [spec:SP-9904]. Free BEFORE arming any kill so work completes
    // while the agent is still alive; self-stop kill is armed only after the
    // relay reply (finalizeDeferredStopKill), not via a timer.
    let worktreeFreed = false
    if (issueId && worktreePath) {
      const stillUsing = liveSessionsUsingWorktree(
        worktreePath,
        this.ports.listSessions(),
        input.sessionId,
      )
      if (stillUsing.length === 0) {
        const freed = await issues.freeWorktreeKeepBranch(
          issueId,
          input.principal ?? systemPrincipal('stop'),
          {
            force: input.force === true,
          },
        )
        if (!freed.ok) {
          if (wasRunning && !input.selfStop) this.killStoppedSession(session)
          return {
            ok: true,
            reason: `session stopped but worktree not freed: ${freed.output}`,
            worktreeFreed: false,
            deferredKill: input.selfStop === true && wasRunning,
          }
        }
        worktreeFreed = freed.worktreeFreed
      }
    }

    // Peer/operator: kill now. Self-stop: hold the kill until the relay has
    // delivered agentRelayResult (finalizeDeferredStopKill) [spec:SP-9904].
    if (wasRunning && !input.selfStop) this.killStoppedSession(session)

    return {
      ok: true,
      worktreeFreed,
      deferredKill: input.selfStop === true && wasRunning,
    }
  }

  /** Immediate process kill for a session already parked by stop. */
  private killStoppedSession(session: Session): void {
    this.ports.toMachine(session.machineId, {
      type: 'kill',
      sessionId: session.sessionId,
      durableLabel: session.durableLabel,
    })
  }

  /**
   * Arm the process kill for a self-stop AFTER the relay reply has been sent
   * [spec:SP-9904]. Called from AgentRelayGate once agentRelayResult is on the
   * wire — not a fixed timer.
   */
  finalizeDeferredStopKill(sessionId: SessionId): void {
    const session = this.ports.sessions.get(sessionId)
    if (!session) return
    // Only kill if still parked from stop (hibernated/exited) — never a live row.
    if (session.status !== 'hibernated' && session.status !== 'exited') return
    this.killStoppedSession(session)
  }

  /**
   * Stop every session on an issue, then free the issue worktree (keep branch)
   * [spec:SP-9904].
   */
  async stopIssue(
    input: {
      issueId: string
      force?: boolean
      /** Session performing the stop (for self-stop deferral when it is a member). */
      callerSessionId?: string
      /**
       * Who asked for the stop (POD-1344). Stamped onto free-worktree audit
       * comments. Absent only on genuinely caller-less paths — those fall back
       * to `systemPrincipal('stop')`.
       */
      principal?: CommandPrincipal
    },
    issues: SessionIssueWorkflowPort,
  ): Promise<{
    ok: boolean
    reason?: string
    stopped: string[]
    worktreeFreed: boolean
    deferredKill?: boolean
  }> {
    const issue = this.ports.issueAccess.getMeta(input.issueId)
    if (!issue) return { ok: false, reason: 'unknown issue', stopped: [], worktreeFreed: false }
    // sessionsForIssue matches on the canonical issue id; input.issueId may be a
    // human ref/seq that getMeta resolved above but a raw string compare would miss [POD-985].
    const members = sessionsForIssue(issue.worktreePath ?? null, this.ports.listSessions(), issue.id)
    const stopped: string[] = []
    let deferredKill = false
    const principal = input.principal ?? systemPrincipal('stop')
    // Non-self members first (immediate kill). Self last so sibling stops + free
    // finish before the caller's deferred kill is armed after the relay reply.
    const ordered = [
      ...members.filter((m) => m.sessionId !== input.callerSessionId),
      ...members.filter((m) => m.sessionId === input.callerSessionId),
    ]
    for (const m of ordered) {
      const r = await this.stopSession(
        {
          sessionId: m.sessionId,
          force: input.force,
          selfStop: input.callerSessionId === m.sessionId,
          stopReason: input.force ? 'forced' : 'parent',
          principal,
        },
        issues,
      )
      if (!r.ok) {
        return {
          ok: false,
          reason: r.reason ?? `failed to stop session ${m.sessionId}`,
          stopped,
          worktreeFreed: false,
        }
      }
      stopped.push(m.sessionId)
      if (r.deferredKill) deferredKill = true
    }
    // Final free pass: only when no live cwd still uses the worktree (any issue).
    let worktreeFreed = false
    const current = this.ports.issueAccess.getMeta(input.issueId)
    const wt = current?.worktreePath ?? null
    if (wt) {
      const stillUsing = liveSessionsUsingWorktree(wt, this.ports.listSessions())
      if (stillUsing.length === 0) {
        const freed = await issues.freeWorktreeKeepBranch(input.issueId, principal, {
          force: input.force === true,
        })
        if (!freed.ok) {
          return {
            ok: true,
            reason: `sessions stopped but worktree not freed: ${freed.output}`,
            stopped,
            worktreeFreed: false,
            ...(deferredKill ? { deferredKill: true } : {}),
          }
        }
        worktreeFreed = freed.worktreeFreed
      }
    } else {
      worktreeFreed = Boolean(current?.branch && !current.worktreePath)
    }
    return {
      ok: true,
      stopped,
      worktreeFreed,
      ...(deferredKill ? { deferredKill: true } : {}),
    }
  }

  /**
   * Park a live session: kill its process (and durable host) but keep the row,
   * its transcript, and the resume ref. One click brings it back. Returns false
   * when the session can't come back later (no resume ref) — we refuse rather
   * than silently turn "hibernate" into "kill".
   */
  hibernateSession({
    sessionId,
    requireTerminalProof = false,
  }: {
    sessionId: SessionId
    requireTerminalProof?: boolean
  }): { ok: boolean; reason?: string } {
    const session = this.ports.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    if (session.status !== 'live' && session.status !== 'reconnecting')
      return { ok: false, reason: 'not running' }
    if (!session.resume) {
      return { ok: false, reason: 'no resume ref yet — the agent has not reported one' }
    }
    // Never park an agent mid-work: hibernation kills the process, and a
    // working/compacting agent would lose its in-flight turn. Auto-hibernation
    // already filters to idle/ended; enforcing it here makes the primitive (and
    // the manual hibernate button) safe regardless of caller.
    const phase = session.agentState?.phase
    if (phase === 'working' || phase === 'compacting') {
      return { ok: false, reason: 'agent is working — let it reach idle first' }
    }
    const lease = requireTerminalProof ? this.ports.store.observationCheckpoints.get(sessionId) : null
    const facts = lease ? this.ports.terminalProof.facts(session, lease) : null
    if (requireTerminalProof) {
      if (!facts || !this.ports.terminalProof.consumable(facts)) {
        return { ok: false, reason: 'terminal state is not safely reapable' }
      }
      const proof = this.ports.store.observationCheckpoints.getTerminalCandidate(sessionId)
      if (
        !proof?.confirmedAt ||
        proof.consumedAt ||
        JSON.stringify(proof.facts) !== JSON.stringify(facts)
      ) {
        return { ok: false, reason: 'terminal state has not passed live revalidation' }
      }
    }
    const runningStatus = session.status
    session.status = 'hibernated'
    const consumedAt = new Date(this.ports.now()).toISOString()
    try {
      this.ports.repository.persist(
        session,
        facts
          ? () => {
              const currentLease = this.ports.store.observationCheckpoints.get(sessionId)
              const currentFacts = currentLease
                ? this.ports.terminalProof.facts(session, currentLease)
                : null
              if (
                !currentFacts ||
                JSON.stringify(currentFacts) !== JSON.stringify(facts) ||
                !this.ports.store.observationCheckpoints.consumeTerminalCandidate(
                  currentFacts,
                  consumedAt,
                )
              ) {
                throw new Error('terminal proof changed before hibernation')
              }
            }
          : undefined,
      )
    } catch (error) {
      // `persist` restores its captured durable state on any transaction error;
      // keep this lifecycle primitive independently correct even when a caller or
      // test supplies a store without a prior capture.
      session.status = runningStatus
      if (error instanceof Error && error.message === 'terminal proof changed before hibernation') {
        return { ok: false, reason: error.message }
      }
      throw error
    }
    this.ports.autoContinue.onSessionGone(sessionId)
    this.ports.toMachine(session.machineId, {
      type: 'kill',
      sessionId,
      ...(session ? { durableLabel: session.durableLabel } : {}),
    })
    this.ports.broadcastSessions()
    return { ok: true }
  }


  /** issue-as-workspace draft cleanup: after a session dies (kill/remove/exit/
   *  archive), reap its draft issue if the draft is now empty — draft, no
   *  worktree, no children, and every attached session dead (exited/archived) or
   *  gone. Hibernation does NOT land here via a dead status ('hibernated' blocks
   *  the reap inside reapIfEmptyDraft), so a parked draft survives. */
  maybeReapDraftIssue(issueId: string | null | undefined): void {
    if (!issueId) return
    try {
      this.ports.bus.emit('issue.sessionDerived', { kind: 'reapDraft', issueId })
    } catch (err) {
      console.warn(`[podium:issues] draft-issue reap failed for ${issueId}:`, err)
    }
  }

  /** Durable transition for removing a local session. POD-309 removed the second
   *  spec this used to push: a retained hub-mirror entry colliding on the same id was
   *  revealed in the same ordered append. There is no mirror to reveal any more. */
  sessionRemovalSpecs(sessionId: SessionId): EntityChangeSpec[] {
    return [{ entity: 'session', id: sessionId, op: 'remove' }]
  }

  /** Runtime half of a durable session removal. Issue-owned tombstones can be
   * restored and therefore use generic process kill; standalone deletion is
   * terminal and emits the distinct binding-retirement instruction. */
  removeSessionRuntime(
    sessionId: SessionId,
    terminalRetirement?: { retiredAt: string },
  ): void {
    const session = this.ports.sessions.get(sessionId)
    // The issues service owns the per-session Git attribution ledger. Notify it
    // while membership/cwd are still resolvable, before this removal.
    this.ports.bus.emit('issue.sessionDerived', { kind: 'removedOrArchived', sessionId })

    this.ports.toMachine(
      // The live Session is the truth while it exists; after it is dropped the durable
      // row still names the machine that ran it, and only a session with neither gets
      // the fleet default. Every arm is a machine some daemon actually answers to.
      session?.machineId ??
        this.ports.store.sessions.getSession(sessionId)?.machineId ??
        this.ports.machines.defaultMachine(),
      terminalRetirement
        ? {
            type: 'sessionBindingRetire',
            sessionId,
            transitionId: `retire:${sessionId}`,
            retiredAt: terminalRetirement.retiredAt,
            ...(session ? { durableLabel: session.durableLabel } : {}),
          }
        : {
            type: 'kill',
            sessionId,
            ...(session ? { durableLabel: session.durableLabel } : {}),
          },
    )
    this.ports.autoContinue.onSessionGone(sessionId)
    session?.terminal.detachAll()
    this.ports.sessions.delete(sessionId)
    this.ports.state.removeSession(sessionId)
    this.ports.daemonProjection.disposeTitle(sessionId)
    for (const c of this.ports.clients.values()) c.attached.delete(sessionId)
    this.ports.repository.forget(sessionId)
  }

  killSession(input: { sessionId: SessionId }): void {
    const session = this.ports.sessions.get(input.sessionId)
    // Capture before the row is tombstoned — the reap after cleanup needs it.
    const issueId = session?.issueId
    const deletedAt = new Date(this.ports.now()).toISOString()
    // The remove change commits in the SAME transaction as the tombstone (and
    // the queued-send cleanup — a killed session can never deliver, so its rows
    // would only orphan until the next boot's sweep) [spec:SP-3fe2] #256: the
    // durable change log can never say something the sessions table doesn't.
    // Durable tombstone FIRST, live teardown after (#247): a commit throw leaves
    // the session fully alive — still in the map, clients attached, PTY not
    // signalled — and propagates to the caller, instead of tearing down live
    // state for a row the rolled-back transaction still holds.
    const { changes } = this.ports.ledger.commit({
      write: () => {
        this.ports.store.sessions.softDeleteSessions([input.sessionId], deletedAt, 'standalone')
        this.ports.store.sync.deleteQueuedMessagesForSession(input.sessionId)
      },
      changes: () => this.sessionRemovalSpecs(input.sessionId),
    })
    this.removeSessionRuntime(input.sessionId, { retiredAt: deletedAt })
    this.ports.repository.publishSessionProjection(changes)
    this.ports.broadcastSessions()
    // The killed session may have been the last living occupant of an empty
    // draft issue — reap the vessel so "x" doesn't leak orphaned Drafts.
    this.maybeReapDraftIssue(issueId)
    // Session-death notification [spec:SP-85d1] (lock auto-release et al.): a
    // kill deletes the row from the map BEFORE the daemon's agentExit arrives,
    // so the agentExit-path emit would be skipped — fire it here. killSession
    // is never the hibernate path (hibernateSession only flips status).
    // Capture spawnedBy before the row is gone so the steward can still resolve
    // a session-spawner parent wake (POD-904 / exit-without-report).
    this.emitSessionExited(input.sessionId, session?.exitCode ?? -1, session?.spawnedBy, session)
  }

  /**
   * Real process death: bus fan-out (locks, messaging) AND a durable
   * `session.exited` row for the steward's session-parent wake (POD-904).
   * Hibernate does not land here. Best-effort log write — a store throw must
   * not undo the exit side-effects already applied.
   */
  emitSessionExited(
    sessionId: SessionId,
    code: number,
    spawnedBy?: string | null,
    sourceSession: Session | undefined = this.ports.sessions.get(sessionId),
  ): void {
    const session = sourceSession
    const lease = this.ports.store.observationCheckpoints.get(sessionId)
    const fence = lease?.checkpoint?.terminalFence
    const candidate = this.ports.store.observationCheckpoints.getTerminalCandidate(sessionId)
    // A fence suppresses the fixed steward exit fallback only while it still
    // describes the latest causal input. Historical/mixed-version fences without
    // their matching durable candidate, or a prompt sent after the fence, must let
    // the crash surface as a real exit.
    const terminalFenceReported = Boolean(
      session &&
        fence &&
        !fence.closing &&
        candidate &&
        candidate.facts.terminalTransitionId === fence.transitionId &&
        candidate.facts.inputCount === session.terminal.inputCount,
    )
    this.ports.bus.emit('session.exited', { sessionId, code })
    try {
      this.ports.store.events.appendEvent({
        ts: new Date(this.ports.now()).toISOString(),
        kind: 'session.exited',
        subject: sessionId,
        payload: {
          code,
          ...(terminalFenceReported ? { terminalFenceReported: true } : {}),
          ...(spawnedBy ? { spawnedBy } : {}),
        },
      })
    } catch {
      // Durable log is best-effort; bus subscribers already ran.
    }
  }
}
