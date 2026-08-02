/**
 * Session meta mutations and issue session plans (POD-1396).
 * Offers, snooze, read/unread, issue attach, work state, archive, continue,
 * transcript path, issue delete/restore plans.
 * Dispose: none.
 */

// @ts-nocheck — ports typed loosely after mechanical extract; body is a verbatim move.

import type { Attribution, IssueId, SessionId, TranscriptItem, UserId, WorkState } from '@podium/model'
import { asUserId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol'
import type { EntityChangeSpec } from '@podium/sync'
import type { MutationLedgerPort } from '@podium/sync'
import { sessionsForIssue } from '../../issue-util'
import type { SessionRow } from '../../store'
import type { SessionDeletePlan, SessionRestorePlan } from './lifecycle'
import type { Session } from './session'
import type { SessionStateRegistry } from './session-state/registry'

export interface SessionMetaOpsPorts {
  broadcastSessions: any
  funnel: any
  mutations: any
  now: any
  removeSessionRuntime: any
  repository: any
  sessionRemovalSpecs: any
  sessionTeardown: any
  sessions: any
  state: any
  store: any
  toMachine: any
  view: any
}

export class SessionMetaOps {
  constructor(private readonly ports: SessionMetaOpsPorts) {}

  /** Set (replace) a session's agent action offer [spec:SP-c7f1]. A subsequent
   *  offer replaces the previous one. Persisted in the `offers` table (off-row,
   *  like snooze) and broadcast so every client's chat bar updates. */
  setOffer({
    sessionId,
    message,
    actions,
    artifacts,
  }: {
    sessionId: SessionId
    message: string
    actions: { label: string; prompt: string; input?: boolean }[]
    /** Issue-artifact paths named as evidence [POD-120]; resolved client-side. */
    artifacts?: string[]
  }): void {
    const offer = {
      message,
      actions,
      ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
      createdAt: new Date().toISOString(),
    }
    const session = this.ports.sessions.get(sessionId)
    if (!session) {
      this.ports.store.sessions.setOffer(sessionId, offer)
      this.ports.broadcastSessions()
      return
    }
    session.offer = offer
    this.ports.repository.persist(session, () => this.ports.store.sessions.setOffer(sessionId, offer))
    this.ports.broadcastSessions()
  }

  /** Clear a session's agent action offer [spec:SP-c7f1] (explicit `offer clear`
   *  or auto-clear on the next user turn). Skips work when nothing changes. */

  /** Clear a session's agent action offer [spec:SP-c7f1] (explicit `offer clear`
   *  or auto-clear on the next user turn). Skips work when nothing changes. */
  clearOffer(sessionId: SessionId): void {
    const session = this.ports.sessions.get(sessionId)
    if (!session || !session.clearOffer()) {
      this.ports.store.sessions.clearOffer(sessionId)
      this.ports.broadcastSessions()
      return
    }
    this.ports.repository.persist(session, () => this.ports.store.sessions.clearOffer(sessionId))
    this.ports.broadcastSessions()
  }

  /** Agent kind may be omitted — the settings default decides ('auto' = Claude Code).
   *  `initialPrompt` hands the fresh session the human's first prompt: for argv-capable
   *  agents (claude/codex/grok) it rides the launch command (`claude "<prompt>"`,
   *  race-free); for the rest it's seeded into the composer draft. */
  /** Create a session: resolve the request, then spawn it. Delegated to
   *  {@link SessionStart}, which owns both halves. */

  /**
   * Snooze a session for ONE USER (POD-380). Snooze is per-user state keyed
   * `(userId, sessionId)`; `userId` is required so no caller can write a row
   * without saying whose it is.
   *
   * There is no live mirror any more (POD-1076): the broadcast projection reads
   * `viewerOverlay`, so the only thing this writes is the durable row. The
   * projection is still unscoped (ADR 2 D2) and therefore still serves one named
   * viewer, but that choice now lives in ONE method instead of on every session.
   */
  setSnooze({
    userId,
    sessionId,
    until,
  }: {
    userId: string
    sessionId: SessionId
    until: string | null
  }): void {
    this.ports.state.setSnooze(this.ports.view.principalForTrustedUser(asUserId(userId)), sessionId, until)
  }


  clearSnooze(userId: string, sessionId: SessionId): void {
    this.ports.state.clearSnooze(this.ports.view.principalForTrustedUser(asUserId(userId)), sessionId)
  }

  /**
   * OWNER + GRANTS of a session, for the owner-or-grant policy (POD-380).
   *
   * `undefined` means the session does not exist — which the session-state envelope
   * treats identically to a denial (§3.1.5's consistent-error rule).
   *
   * Session rows still have no `owner` column, so existing sessions use
   * the instance's first-admin identity as a transitional owner. This is the ONE place
   * that answer is given; POD-1070 ownership work replaces it here rather than
   * in eleven handlers.
   */

  markSessionRead(userId: string, sessionId: SessionId): void {
    this.ports.state.markRead(this.ports.view.principalForTrustedUser(asUserId(userId)), sessionId)
  }

  /** Mark this session UNREAD again (issue #138, the email-style inverse of
   *  markSessionRead): DELETE the actor's marker so the derived `unread` (readAt
   *  null ⇒ unread) flips back to true, then broadcast. Marking MY copy unread
   *  never touches yours. No-op for an unknown session. */

  /** Mark this session UNREAD again (issue #138, the email-style inverse of
   *  markSessionRead): DELETE the actor's marker so the derived `unread` (readAt
   *  null ⇒ unread) flips back to true, then broadcast. Marking MY copy unread
   *  never touches yours. No-op for an unknown session. */
  markSessionUnread(userId: string, sessionId: SessionId): void {
    this.ports.state.markUnread(this.ports.view.principalForTrustedUser(asUserId(userId)), sessionId)
  }

  /**
   * Re-arm unread for EVERY reader of a session (POD-1076).
   *
   * A terminal transition used to null the one `read_at` column, which re-armed
   * unread for the whole instance because there was only one marker. Per-user
   * that is a delete across every reader's row, which is what this does — the
   * behaviour is unchanged; what changed is that it is now a statement about all
   * readers rather than an accident of there being one.
   */

  /** Set (or clear with null) a session's explicit issue attachment. */
  setSessionIssueId(sessionId: SessionId, issueId: IssueId | null): void {
    this.mutateSessionMeta(sessionId, (session) => {
      session.issueId = issueId ?? undefined
      // Naming point (#474): the first attach on a still-unnamed session brands
      // it with that issue's letter. A detach (null) is NOT a naming point —
      // the session stays unnamed rather than getting a spurious DRAFT ordinal.
      if (issueId) return this.ports.view.prepareRefAllocation(session)
    })
  }

  /** The session's explicit issue attachment (issue-as-workspace), if any. */

  /** The session's explicit issue attachment (issue-as-workspace), if any. */
  getSessionIssueId(sessionId: SessionId): IssueId | null {
    return this.ports.sessions.get(sessionId)?.issueId ?? null
  }


  setWorkState({
    sessionId,
    workState,
  }: {
    sessionId: SessionId
    workState: WorkState | null
  }): void {
    this.ports.state.setWorkState(sessionId, workState)
  }

  /**
   * Cleanly end a session [spec:SP-9904]. Survival table lives on SessionTeardown.
   */

  setArchived({ sessionId, archived }: { sessionId: SessionId; archived: boolean }): void {
    this.ports.state.setArchived(sessionId, archived)
  }

  /** Archive parks a running process (POD-108). See SessionTeardown survival table. */

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
    return this.ports.sessionTeardown.tryAutoArchiveStoppedObserved(observed, nowMs)
  }


  continueSession({ sessionId }: { sessionId: SessionId }): { ok: boolean } {
    const session = this.ports.sessions.get(sessionId)
    if (!session) return { ok: false }
    // Status gate as well as phase: a session can read 'errored' while its
    // process is already gone (hibernated/exited), where typing 'continue' would
    // vanish into a dead PTY yet still report ok. Only a running session can retry.
    if (session.status !== 'live' && session.status !== 'starting') return { ok: false }
    if (session.agentState?.phase !== 'errored') return { ok: false }
    session.terminal.recordInputActivity(this.ports.now())
    this.ports.toMachine(session.machineId, {
      type: 'input',
      sessionId,
      inputOrigin: 'auto_continue',
      data: Buffer.from('continue\r').toString('base64'),
    })
    return { ok: true }
  }

  /** Durable session-state command envelope, built lazily over the module port. */
  sessionStateRegistry: SessionStateRegistry | undefined

  transcriptFor(sessionId: SessionId): TranscriptItem[] {
    return this.ports.sessions.get(sessionId)?.terminal.transcriptItems() ?? []
  }

  /** Raw fan-out to every connected client. Typed LIVE-ONLY (modules/
   *  message-class, issue #190): durable entity messages must go through the
   *  write funnel's publish tail instead, so passing one here is a type error.
   *  `exceptClientId` skips the originator (draft echo suppression).
   *
   *  The MECHANISM is the gateway registry's (POD-390); this method is the
   *  feature's typed entry point to it, and the LiveServerMessage constraint is
   *  why it stays a method rather than becoming a call to `registry.broadcast`
   *  at 8 sites — the registry deliberately has no opinion about message class. */

  /**
   * The write funnel's session-metadata face: apply the field write, persist the
   * row (repository write), then enter the coalesced broadcast — whose trailing
   * run is the funnel's oplog-append → fan-out tail. Every plain metadata
   * mutation (rename/archive/read/issue attachment/work state) goes through
   * here instead of hand-rolling persist+broadcast.
   */
  mutateSessionMeta(
    sessionId: SessionId,
    write: (session: Session) => void | (() => void),
  ): void {
    const session = this.ports.sessions.get(sessionId)
    if (!session) return
    this.ports.funnel.run({
      write: () => {
        const additionalWrite = write(session)
        this.ports.repository.persist(session, additionalWrite ?? undefined)
      },
    })
    this.ports.broadcastSessions()
  }

  private readonly mutations!: MutationLedgerPort

  /**
   * IDEMPOTENCY IS NOT THIS SERVICE'S ANYMORE (POD-382).
   *
   * `withMutation(mutationId, proc, fn)` lived here and every session write, plus
   * the whole issue registry through an injected reference to it, wrapped itself in
   * it. It is now `@podium/sync`'s `MutationLedger` — one implementation, called by
   * the command envelopes (`SessionStateRegistry.execute`, `dispatchSessionCommand`,
   * `IssueCommandCtx.withMutation`) AFTER they authorize, never by a handler.
   *
   * Deliberately not re-exposed as a delegating method: a method here is a seam a
   * new write can wrap itself in, which is exactly the per-proc shape POD-312 set
   * out to delete. The service holds {@link SessionLifecycle.mutations} privately
   * for the session-state envelope it builds and offers no public wrapper.
   */

  /**
   * The write funnel's session-metadata face: apply the field write, persist the
   * row (repository write), then enter the coalesced broadcast — whose trailing
   * run is the funnel's oplog-append → fan-out tail. Every plain metadata
   * mutation (rename/archive/read/issue attachment/work state) goes through
   * here instead of hand-rolling persist+broadcast.
   */

  prepareInboxSend(
    sessionId: SessionId,
    attribution: Attribution,
    kind: 'text' | 'answer',
  ): void {
    const session = this.ports.sessions.get(sessionId)
    if (!session) return
    this.ports.state.clearAllSnoozes(sessionId)
    this.ports.state.suppressNativeDraft(sessionId)
    if (session.offer !== undefined) this.clearOffer(sessionId)
    this.ports.store.events.appendEvent({
      ts: new Date(this.ports.now()).toISOString(),
      kind: kind === 'answer' ? 'session.inbox.answer' : 'session.inbox.send',
      subject: sessionId,
      payload: { sessionId, attribution },
    })
  }


  prepareIssueSessionDelete(issueId: string, worktreePath: string | null): SessionDeletePlan {
    const localMetas = [...this.ports.sessions.values()].map((s) =>
      s.toMeta(this.ports.view.overlay(s.sessionId)),
    )
    const sessionIds = sessionsForIssue(worktreePath, localMetas, issueId).map((s) => s.sessionId)
    const deletedAt = new Date(this.ports.now()).toISOString()
    return {
      sessionIds,
      write: () => {
        this.ports.store.sessions.softDeleteForIssue(sessionIds, issueId, deletedAt)
        for (const sessionId of sessionIds)
          this.ports.store.sync.deleteQueuedMessagesForSession(sessionId)
      },
      changes: () => sessionIds.flatMap((sessionId) => this.ports.sessionRemovalSpecs(sessionId)),
      apply: (changes, ledgerCursor) => {
        for (const sessionId of sessionIds) this.ports.removeSessionRuntime(sessionId)
        this.ports.repository.publishSessionProjection(changes, ledgerCursor)
      },
    }
  }

  /** Prepare restoration of the sessions tombstoned by one issue deletion. The
   *  durable rows and ledger upserts commit with the issue restore; runtime
   *  installation follows only after that transaction succeeds. */

  /** Prepare restoration of the sessions tombstoned by one issue deletion. The
   *  durable rows and ledger upserts commit with the issue restore; runtime
   *  installation follows only after that transaction succeeds. */
  prepareIssueSessionRestore(issueId: string): SessionRestorePlan {
    const rows = this.ports.store.sessions.loadDeletedSessionsForIssue(issueId)
    const restored = rows
      .map((row) => ({ row, session: this.ports.repository.sessionFromStoredRow(row, 'restore') }))
      .filter((entry): entry is { row: SessionRow; session: Session } => entry.session !== null)
    return {
      sessionIds: restored.map(({ session }) => session.sessionId),
      restoredSessions: restored.map(({ session }) => this.ports.view.wire(session)),
      write: () => this.ports.store.sessions.restoreDeletedForIssue(issueId),
      changes: () =>
        restored.map(({ session }) => ({
          entity: 'session' as const,
          id: session.sessionId,
          op: 'upsert' as const,
          value: this.ports.view.wire(session),
        })),
      apply: (changes, ledgerCursor) => {
        this.ports.state.loadFromStore()
        const offers = this.ports.store.sessions.listOffers() // [spec:SP-c7f1]
        for (const { session } of restored) {
          this.ports.repository.installStoredSession(session, offers)
        }
        // Restored sessions may carry per-user rows; the overlay is read fresh.
        this.ports.state.invalidateAllOverlays()
        this.ports.repository.publishSessionProjection(changes, ledgerCursor)
      },
    }
  }

  /** Runtime half of a durable session removal. */
}
