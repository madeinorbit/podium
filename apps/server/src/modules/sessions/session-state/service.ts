/**
 * DURABLE SESSION STATE — viewer state plus shared session-surface state.
 *
 * This module deliberately is NOT called "presence". Live co-presence is the
 * ephemeral, room-scoped stream-plane concern owned by POD-1078: it is derived
 * from live connections, has no durable rows, and never touches the oplog. This
 * module owns durable state around a session and keeps its three subjects
 * explicit:
 *
 * - viewer state (`readAt`, snooze, pins, tab order), keyed by the calling
 *   principal's HUMAN user id and never shared;
 * - shared session facts (`archived`, `workState`), one owner/grant-governed
 *   value visible to every authorized viewer;
 * - the shared composer document, deliberately NOT keyed by user. Its stored
 *   materialized text, revision, origin and bounded history are the seam for the
 *   reserved future op stream; this module does not implement that op stream.
 * Sidebar/tab/pane layout has no server row and remains client-local; personal
 * preferences already have their own principal-scoped settings module and store.
 * This module does not reach into either sibling merely to make the family appear
 * co-located: they share the `(userId, entityId)` contract, not protected state.
 *
 *
 * Focus/visibility is viewer-scoped EPHEMERAL input. The priority sent to a
 * daemon is only the strongest derived aggregate across current viewers; it is
 * neither a durable session field nor shared viewer state.
 *
 * The class owns every mutable cache/timer for these concerns. Its host receives
 * changes only through the explicit ports below, so lifecycle/inbox siblings do
 * not reach protected state and this module does not reach theirs.
 */

import { createLogger } from '@podium/logger'
import {
  applyDraftEdit,
  type Capability,
  computePriorities,
  DEFAULT_LEASE_MS,
  type DraftDoc,
  emptyDraftDoc,
  type SessionId,
  type SessionUserOverlay,
  type UserId,
  type WorkState,
  type MachineId,
} from '@podium/model'
import type { DraftEditMessage, LiveServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { ClientConn } from '../../../gateway/client-registry'
import type { PinState, SessionStore, SnoozeMap } from '../../../store'
import type { Session } from '../session'

const log = createLogger('server:sessions')

export interface SessionStatePrincipal {
  /** The human row owner. For an agent this is its on-behalf-of human. */
  readonly userId: UserId
  readonly capability: Capability
  /** Acting agent, when delegated. Attribution never collapses into userId. */
  readonly actorSessionId?: SessionId
  /** Must equal userId for an agent; retained as the explicit attribution pair. */
  readonly onBehalfOf?: UserId
  readonly humanDirect: boolean
  /** Sending websocket connection, used only for draft echo suppression. */
  readonly clientId?: string
}

/** The only live-session fields this module may touch; derived from the canonical Session. */
export type SessionStateRecord = Pick<
  Session,
  'sessionId' | 'machineId' | 'lastActiveAt' | 'draftUpdatedAt' | 'archived' | 'workState'
>

/**
 * The half of a full-list pass's memo that ownership resolution reads
 * [POD-1618]. Structural, so `SessionListMemo` (which also carries repo
 * prefixes) satisfies it without either module importing the other.
 *
 * Lifetime is one list pass — see {@link SessionListMemo} for why that makes
 * staleness unobservable.
 */
export interface SessionOwnerMemo {
  /** Issue rows by id. */
  issues: Map<string, unknown>
  /** Grantee lists by `${resourceKind}:${resourceId}`. */
  grants: Map<string, string[]>
}

export interface SessionStatePorts {
  readonly store: Pick<SessionStore, 'sessions'>
  readonly now: () => number
  readonly getSession: (sessionId: SessionId) => SessionStateRecord | undefined
  readonly sessionIds: () => Iterable<SessionId>
  readonly clients: () => Iterable<ClientConn>
  /**
   * ONE OBJECT ARGUMENT, DELIBERATELY [POD-1653].
   *
   * This was `(sessionId, memo?)`, and the wiring passed
   * `(sessionId) => bag.sessionOwner(sessionId)`. TypeScript accepts that — a
   * 1-arg function IS assignable to a 2-arg function type — so the compiler
   * could not go red, and POD-1618's memo was silently discarded at the wiring
   * for every full-list pass. The only symptom was that an optimisation quietly
   * did nothing, which is why it survived POD-1618, POD-1638 and POD-1639 and
   * corrupted the per-session cost those issues attributed.
   *
   * An OPTIONAL TRAILING PARAMETER threaded through a function-typed port is
   * invisible to the compiler when a call site drops it. The object form does
   * NOT restore a compile error here — `bag.sessionOwner` is `(...args: any[])`,
   * so a wiring that destructures nothing still type-checks (verified: the old
   * shape compiles clean against this port). What it changes is the FAILURE
   * MODE, and that is the point. Dropping the parameter now passes the whole
   * input object where a `SessionId` is expected, so ownership resolves to
   * undefined and the suite goes red — 150 tests in `modules/sessions` alone.
   * The two-parameter form failed silently and cost nothing but speed, which is
   * exactly why it survived three issues. Loud beats invisible; prefer this
   * shape for any port threading a memo, cache, principal or cancellation
   * token.
   */
  readonly sessionOwner: (input: {
    sessionId: SessionId
    /** Per-pass read-through memo for full-list callers [POD-1618]. */
    memo?: SessionOwnerMemo
  }) => { owner: UserId | null; grants: readonly string[] } | undefined
  /** Fill a pass's grant memo in one read per resource kind [POD-1653].
   *  Optional: a fixture that omits it is slow, never wrong, because every key
   *  it would have primed is still computed on demand by `sessionOwner`. */
  readonly primeOwnerMemo?: (memo: SessionOwnerMemo, sessionIds: readonly SessionId[]) => void
  /** Persist one session and an optional satellite-row write atomically. */
  readonly persistSession: (sessionId: SessionId, additionalWrite?: () => void) => void
  /** Shared session-field mutation through the host's canonical metadata seam. */
  readonly mutateSession: (
    sessionId: SessionId,
    mutate: (session: SessionStateRecord) => void,
  ) => void
  readonly broadcastSessions: () => void
  readonly broadcastToClients: (
    message: LiveServerMessage,
    options?: { exceptClientId?: string },
  ) => void
  readonly deliverToClient: (clientId: string, message: LiveServerMessage) => void
  readonly toMachine: (machineId: MachineId, message: ControlMessage) => void
  /** Re-arm durable inbox delivery after native terminal control is released. */
  readonly onNativeViewReleased?: (sessionId: SessionId) => void

  /** Lifecycle owns process parking and issue cleanup after archive. */
  readonly onArchived: (sessionId: SessionId) => void
}

export type SessionStateReadResult<T> =
  | { readonly kind: 'found'; readonly value: T }
  /** Invisible and nonexistent intentionally collapse to the same result. */
  | { readonly kind: 'absent' }

const DRAFT_WRITE_DEBOUNCE_MS = 750
const DRAFT_SEND_SUPPRESS_MS = 1_000

export class SessionStateService {
  private readonly overlays = new Map<
    UserId,
    { readAt: Record<string, string | null>; snoozes: Record<string, string | null> }
  >()

  private readonly draftDocs = new Map<SessionId, DraftDoc>()
  private readonly draftTimes = new Map<SessionId, string>()
  private readonly draftDocWriteTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private readonly draftInjectTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private readonly draftSendSuppressUntil = new Map<SessionId, number>()
  private draftSyncEnabled_ = false

  private readonly lastPriority = new Map<SessionId, string>()

  constructor(private readonly ports: SessionStatePorts) {}

  setDraftSyncEnabled(enabled: boolean): void {
    this.draftSyncEnabled_ = enabled
  }

  draftSyncEnabled(): boolean {
    return this.draftSyncEnabled_
  }

  /**
   * Hydrate shared draft documents. Per-user rows remain lazy per principal.
   *
   * `session_drafts` is ONE row per session, and the versioning columns sit
   * beside the text column older builds wrote. So a draft persisted before this
   * change loads here as an ordinary document at rev 0 — nothing has to migrate
   * it, and nothing has to know whether it was written before or after.
   */
  loadFromStore(): void {
    this.draftDocs.clear()
    this.draftTimes.clear()
    for (const [rawSessionId, updatedAt] of Object.entries(
      this.ports.store.sessions.loadDraftTimes(),
    )) {
      this.draftTimes.set(rawSessionId as SessionId, updatedAt)
    }
    for (const [rawSessionId, stored] of Object.entries(
      this.ports.store.sessions.loadDraftDocs(),
    )) {
      const sessionId = rawSessionId as SessionId
      this.draftDocs.set(sessionId, {
        sessionId,
        text: stored.text,
        rev: stored.rev,
        origin: stored.origin ?? 'seed',
        editedAt: stored.updatedAt,
        history: stored.history,
      })
    }
    this.invalidateAllOverlays()
  }

  /** Attach off-row draft metadata to a newly installed runtime session. */
  installSession(sessionId: SessionId): void {
    const session = this.ports.getSession(sessionId)
    const updatedAt = this.draftTimes.get(sessionId)
    if (session && updatedAt !== undefined) session.draftUpdatedAt = updatedAt
  }

  removeSession(sessionId: SessionId): void {
    this.draftDocs.delete(sessionId)
    this.draftTimes.delete(sessionId)
    this.lastPriority.delete(sessionId)
    this.draftSendSuppressUntil.delete(sessionId)
    const versioned = this.draftDocWriteTimers.get(sessionId)
    if (versioned) clearTimeout(versioned)
    this.draftDocWriteTimers.delete(sessionId)
    this.cancelDraftInject(sessionId)
    this.invalidateAllOverlays()
  }

  // -------------------------------------------------------------------------
  // Access and per-user state
  // -------------------------------------------------------------------------

  /**
   * Default-closed visibility check used identically by reads and writes.
   * Absence and invisibility intentionally share one false result, so callers
   * cannot turn this module into a session-existence oracle.
   */
  /** Prime a full-list pass's memo before the per-session questions start
   *  [POD-1653] — see `SessionAuthz.primeOwnerMemo`. */
  primeOwnerMemo(memo: SessionOwnerMemo, sessionIds: readonly SessionId[]): void {
    this.ports.primeOwnerMemo?.(memo, sessionIds)
  }

  canReadSession(
    principal: SessionStatePrincipal,
    sessionId: SessionId,
    /** Per-pass memo when a full-list caller is asking [POD-1618]. */
    memo?: SessionOwnerMemo,
  ): boolean {
    const target = this.ports.sessionOwner({ sessionId, ...(memo ? { memo } : {}) })
    if (!target) return false
    if (target.owner === principal.userId || target.grants.includes(principal.userId)) {
      return true
    }
    // The current operator capability is the transitional one-account read.
    // Narrow agent scopes never widen the on-behalf-of human's visibility.
    return principal.capability.scope.kind === 'all'
  }

  private cachedOverlay(userId: UserId): {
    readAt: Record<string, string | null>
    snoozes: Record<string, string | null>
  } {
    let cached = this.overlays.get(userId)
    if (!cached) {
      cached = {
        readAt: this.ports.store.sessions.listReadAt(userId),
        snoozes: this.ports.store.sessions.listSnoozes(userId),
      }
      this.overlays.set(userId, cached)
    }
    return cached
  }

  /** Projection overlay for a caller already proven able to see the session. */
  overlay(userId: UserId, sessionId: SessionId): SessionUserOverlay {
    const cached = this.cachedOverlay(userId)
    return {
      readAt: cached.readAt[sessionId] ?? null,
      snoozedUntil: sessionId in cached.snoozes ? cached.snoozes[sessionId] : undefined,
    }
  }

  readOverlay(
    principal: SessionStatePrincipal,
    sessionId: SessionId,
  ): SessionStateReadResult<SessionUserOverlay> {
    if (!this.canReadSession(principal, sessionId)) return { kind: 'absent' }
    return { kind: 'found', value: this.overlay(principal.userId, sessionId) }
  }

  isSnoozed(userId: UserId, sessionId: SessionId): boolean {
    return this.overlay(userId, sessionId).snoozedUntil !== undefined
  }

  private invalidateOverlay(userId: UserId): void {
    this.overlays.delete(userId)
  }

  invalidateAllOverlays(): void {
    this.overlays.clear()
  }

  private persistPerUser(userId: UserId, sessionId: SessionId, write: () => void): boolean {
    if (!this.ports.getSession(sessionId)) return false
    try {
      this.ports.persistSession(sessionId, () => {
        write()
        this.invalidateOverlay(userId)
      })
    } finally {
      // The projection read inside persist may cache a value whose transaction
      // later rolls back. A second invalidation prevents serving that ghost row.
      this.invalidateOverlay(userId)
    }
    this.ports.broadcastSessions()
    return true
  }

  markRead(principal: SessionStatePrincipal, sessionId: SessionId): boolean {
    if (!this.canReadSession(principal, sessionId)) return false
    return this.persistPerUser(principal.userId, sessionId, () =>
      this.ports.store.sessions.markSessionRead(
        principal.userId,
        sessionId,
        new Date(this.ports.now()).toISOString(),
      ),
    )
  }

  markUnread(principal: SessionStatePrincipal, sessionId: SessionId): boolean {
    if (!this.canReadSession(principal, sessionId)) return false
    return this.persistPerUser(principal.userId, sessionId, () =>
      this.ports.store.sessions.markSessionUnread(principal.userId, sessionId),
    )
  }

  rearmUnreadForAll(sessionId: SessionId): void {
    this.ports.store.sessions.clearAllReadAt(sessionId)
    this.invalidateAllOverlays()
  }

  setSnooze(principal: SessionStatePrincipal, sessionId: SessionId, until: string | null): boolean {
    if (!this.canReadSession(principal, sessionId)) return false
    return this.persistPerUser(principal.userId, sessionId, () =>
      this.ports.store.sessions.setSnooze(principal.userId, sessionId, until),
    )
  }

  clearSnooze(principal: SessionStatePrincipal, sessionId: SessionId): boolean {
    if (!this.canReadSession(principal, sessionId)) return false
    return this.persistPerUser(principal.userId, sessionId, () =>
      this.ports.store.sessions.clearSnooze(principal.userId, sessionId),
    )
  }

  /** Shared session activity invalidates every viewer's snooze independently. */
  clearAllSnoozes(sessionId: SessionId): void {
    if (!this.ports.getSession(sessionId)) return
    if (!this.ports.store.sessions.hasAnySnooze(sessionId)) return
    this.ports.persistSession(sessionId, () => this.ports.store.sessions.clearAllSnoozes(sessionId))
    this.invalidateAllOverlays()
    this.ports.broadcastSessions()
  }

  listSnoozes(principal: SessionStatePrincipal): SnoozeMap {
    const rows = this.ports.store.sessions.listSnoozes(principal.userId)
    const visible: SnoozeMap = {}
    for (const [rawId, until] of Object.entries(rows)) {
      const sessionId = rawId as SessionId
      if (this.canReadSession(principal, sessionId)) visible[sessionId] = until
    }
    return visible
  }

  listPins(principal: SessionStatePrincipal): PinState {
    const rows = this.ports.store.sessions.listPins(principal.userId)
    return {
      ...rows,
      // Panel ids that name sessions obey session visibility. Non-session panel
      // ids are left alone; this module is not entitled to classify them.
      panels: rows.panels.filter((id) => {
        const sessionId = id as SessionId
        return !this.ports.getSession(sessionId) || this.canReadSession(principal, sessionId)
      }),
    }
  }

  setPin(
    principal: SessionStatePrincipal,
    kind: Parameters<SessionStore['sessions']['setPin']>[1],
    id: string,
    pinned: boolean,
  ): PinState {
    this.ports.store.sessions.setPin(principal.userId, kind, id, pinned)
    return this.listPins(principal)
  }

  listTabOrders(principal: SessionStatePrincipal): Record<string, string[]> {
    const rows = this.ports.store.sessions.listTabOrders(principal.userId)
    const visible: Record<string, string[]> = {}
    for (const [worktree, ids] of Object.entries(rows)) {
      visible[worktree] = ids.filter((id) => {
        const sessionId = id as SessionId
        return this.canReadSession(principal, sessionId)
      })
    }
    return visible
  }

  setTabOrder(
    principal: SessionStatePrincipal,
    worktree: string,
    sessionIds: string[],
  ): Record<string, string[]> {
    if (sessionIds.some((id) => !this.canReadSession(principal, id as SessionId))) {
      return this.listTabOrders(principal)
    }
    this.ports.store.sessions.setTabOrder(principal.userId, worktree, sessionIds)
    return this.listTabOrders(principal)
  }

  // -------------------------------------------------------------------------
  // Shared session facts
  // -------------------------------------------------------------------------

  setArchived(sessionId: SessionId, archived: boolean): void {
    this.ports.mutateSession(sessionId, (session) => {
      session.archived = archived
    })
    if (archived) this.ports.onArchived(sessionId)
  }

  setWorkState(sessionId: SessionId, workState: WorkState | null): void {
    this.ports.mutateSession(sessionId, (session) => {
      session.workState = workState ?? undefined
    })
  }

  // -------------------------------------------------------------------------
  // Viewer-derived relay priority (ephemeral, never persisted)
  // -------------------------------------------------------------------------

  resetPriorities(): void {
    this.lastPriority.clear()
  }

  pushPriorities(): void {
    const clients = [...this.ports.clients()]
    const priorities = computePriorities(clients, this.ports.sessionIds())
    for (const [sessionId, priority] of priorities) {
      const nativeView = clients.some(
        (client) =>
          client.viewVisible.has(sessionId) &&
          (client.viewModes[sessionId] ?? 'native') === 'native',
      )
      const state = `${priority}:${nativeView ? 1 : 0}`
      const previous = this.lastPriority.get(sessionId)
      if (previous === state) continue
      this.lastPriority.set(sessionId, state)
      // No live session means no machine to prioritise on. This used to fall back to
      // the placeholder, which sent the frame to a queue keyed by a name no daemon
      // answers to — a message that could only ever be dropped, pretending to be sent.
      const machineId = this.ports.getSession(sessionId)?.machineId
      if (machineId === undefined) continue
      this.ports.toMachine(machineId, {
        type: 'sessionPriority',
        sessionId,
        priority,
        nativeView,
      })
      if (!nativeView && previous?.endsWith(':1')) {
        this.ports.onNativeViewReleased?.(sessionId)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Shared composer document
  // -------------------------------------------------------------------------

  draftRevision(sessionId: SessionId): number | undefined {
    return this.draftDocs.get(sessionId)?.rev
  }

  /** The current server-side composer text, used only to avoid clobbering a
   * human edit while automatic prompt recovery restores or clears its seed. */
  draftText(sessionId: SessionId): string | undefined {
    return this.draftDocs.get(sessionId)?.text
  }

  /**
   * An UNVERSIONED write — a legacy `setSessionDraft` frame, or the server
   * seeding a draft itself (a spawn's initial prompt).
   *
   * It is sequenced like any other edit, based on whatever rev the document is
   * at, which makes it unconditionally fresh and therefore always accepted. That
   * is precisely the old last-writer-wins behaviour, now expressed inside the
   * one arbitration rather than beside it.
   */
  setDraft(input: { sessionId: SessionId; text: string }, fromClientId?: string): void {
    const current = this.draftDocs.get(input.sessionId) ?? emptyDraftDoc(input.sessionId)
    this.applyVersionedEdit(
      input.sessionId,
      { baseRev: current.rev, text: input.text, origin: fromClientId ?? 'seed' },
      fromClientId,
    )
  }

  /** A VERSIONED edit: the sender names the rev it typed against, so a race can
   *  be arbitrated instead of silently resolved in favour of whoever was last. */
  handleDraftEdit(input: DraftEditMessage, fromClientId: string): void {
    this.applyVersionedEdit(
      input.sessionId,
      { baseRev: input.baseRev, text: input.text, origin: fromClientId },
      fromClientId,
    )
  }

  handleNativeDraft(sessionId: SessionId, text: string): void {
    if (!this.draftSyncEnabled_) return
    if (Date.now() < (this.draftSendSuppressUntil.get(sessionId) ?? 0)) return
    const current = this.draftDocs.get(sessionId) ?? emptyDraftDoc(sessionId)
    this.applyVersionedEdit(sessionId, { baseRev: current.rev, text, origin: 'native' }, undefined)
  }

  suppressNativeDraft(sessionId: SessionId): void {
    if (this.draftSyncEnabled_) {
      this.draftSendSuppressUntil.set(sessionId, Date.now() + DRAFT_SEND_SUPPRESS_MS)
    }
  }

  maybeCatchupInject(sessionId: SessionId, machineId: MachineId): void {
    if (!this.draftSyncEnabled_) return
    const doc = this.draftDocs.get(sessionId)
    if (!doc?.text) return
    const lastLive = this.ports.getSession(sessionId)?.lastActiveAt
    if (lastLive && doc.editedAt <= lastLive) return
    this.ports.toMachine(machineId, { type: 'draftTarget', sessionId, text: doc.text })
  }

  /**
   * Serve every draft this principal may see to a freshly connected client.
   *
   * The document carries its rev, and that is what makes the replay SAFE rather
   * than destructive. A client with unsent text of its own compares the rev it
   * is told against the one it last confirmed, keeps whatever the person is
   * mid-sentence on, and re-offers it (POD-2045). An unstamped replay left the
   * receiver no way to tell "newer than you" from "older than you", so it took
   * the server's word — and a reconnect after a slow patch deleted typing.
   */
  replayDrafts(principal: SessionStatePrincipal, send: (message: LiveServerMessage) => void): void {
    for (const doc of this.draftDocs.values()) {
      if (doc.text && this.canReadSession(principal, doc.sessionId)) send(this.draftWire(doc))
    }
  }

  private applyVersionedEdit(
    sessionId: SessionId,
    edit: { baseRev: number; text: string; origin: string },
    fromClientId?: string,
  ): void {
    const current = this.draftDocs.get(sessionId) ?? emptyDraftDoc(sessionId)
    const result = applyDraftEdit(current, {
      baseRev: edit.baseRev,
      text: edit.text,
      origin: edit.origin,
      at: new Date().toISOString(),
    })
    if (result.status === 'rejected') {
      if (fromClientId) this.ports.deliverToClient(fromClientId, this.draftWire(result.doc))
      return
    }
    if (!result.changed) return
    const doc = result.doc
    this.draftDocs.set(sessionId, doc)
    this.draftTimes.set(sessionId, doc.editedAt)
    const session = this.ports.getSession(sessionId)
    const draftNonemptyChanged = session && (session.draftUpdatedAt !== undefined) !== !!doc.text
    if (session) session.draftUpdatedAt = doc.text ? doc.editedAt : undefined
    if (draftNonemptyChanged) {
      try {
        this.ports.persistSession(sessionId)
      } catch (error) {
        log.warn('failed to persist the DRAFT tag', { err: error, sessionId })
      }
    }
    // TO EVERY CLIENT, THE SENDER INCLUDED (POD-2045).
    //
    // The sender is not being told what it typed — it already knows that. It is
    // being told WHERE IN THE SEQUENCE it landed, and there is no other way for
    // it to find out. Excluding it left its `baseRev` frozen at whatever it knew
    // before its own edit, so the next edit after a typing pause arrived with a
    // stale base, fell outside the soft lease, and was rejected: a wasted round
    // trip on every pause, and a draft that could never be confirmed at all.
    //
    // The echo is safe by construction on the receiving end — a client whose
    // text already equals the document treats it as convergence, not as an
    // instruction to repaint what it is typing into.
    this.ports.broadcastToClients(this.draftWire(doc))
    this.persistDraftDoc(sessionId, doc)
    if (draftNonemptyChanged) this.ports.broadcastSessions()
    // THE NATIVE COMPOSER STAYS BEHIND THE EXPERIMENT. Sequencing a document is
    // bookkeeping; typing into somebody's terminal is not, and `draft-sync` is
    // the switch for the second one only.
    if (!this.draftSyncEnabled_) return
    if (doc.origin === 'native') this.cancelDraftInject(sessionId)
    else this.scheduleDraftInject(sessionId)
  }

  private draftWire(doc: DraftDoc): LiveServerMessage {
    return {
      type: 'sessionDraftChanged',
      sessionId: doc.sessionId,
      text: doc.text,
      rev: doc.rev,
      origin: doc.origin,
      editedAt: doc.editedAt,
    }
  }

  /**
   * Persist the document behind a FIXED WINDOW, not a per-keystroke debounce
   * (POD-1204).
   *
   * It used to clear the pending timer on every accepted edit and start a new
   * one, which meant continuous typing wrote NOTHING: the window only ever
   * elapsed after the person paused. Meanwhile every one of those revs had been
   * broadcast to the clients — so anything that re-hydrates from the store
   * (a restart, `restoreDeletedForIssue` at runtime) reloaded a document whose
   * rev was BELOW the one the clients had already adopted, and their next edit
   * arrived with a base the arbitration could only reject.
   *
   * A window that is not restarted bounds that loss to one interval however long
   * the burst runs, and the write still lands on the LATEST document — the timer
   * re-reads `draftDocs`, so nothing coalesced away is lost. A clear is written
   * immediately and closes the window: it is the state that must never be a
   * debounce behind, since a stale non-empty row is what holds a session's
   * delivery.
   */
  private persistDraftDoc(sessionId: SessionId, doc: DraftDoc): void {
    if (!doc.text) {
      const pending = this.draftDocWriteTimers.get(sessionId)
      if (pending) clearTimeout(pending)
      this.draftDocWriteTimers.delete(sessionId)
      this.writeDraftDoc(doc)
      return
    }
    if (this.draftDocWriteTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.draftDocWriteTimers.delete(sessionId)
      this.writeDraftDoc(this.draftDocs.get(sessionId) ?? doc)
    }, DRAFT_WRITE_DEBOUNCE_MS)
    timer.unref?.()
    this.draftDocWriteTimers.set(sessionId, timer)
  }

  private writeDraftDoc(doc: DraftDoc): void {
    try {
      this.ports.store.sessions.setDraftDoc(doc.sessionId, {
        text: doc.text,
        updatedAt: doc.editedAt,
        rev: doc.rev,
        origin: doc.origin,
        history: doc.history,
      })
    } catch (error) {
      log.warn('failed to persist the versioned draft', { err: error, sessionId: doc.sessionId })
    }
  }

  private scheduleDraftInject(sessionId: SessionId): void {
    const existing = this.draftInjectTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.draftInjectTimers.delete(sessionId)
      const doc = this.draftDocs.get(sessionId)
      const session = this.ports.getSession(sessionId)
      if (!doc || !session || doc.origin === 'native') return
      this.ports.toMachine(session.machineId, {
        type: 'draftTarget',
        sessionId,
        text: doc.text,
      })
    }, DEFAULT_LEASE_MS)
    timer.unref?.()
    this.draftInjectTimers.set(sessionId, timer)
  }

  private cancelDraftInject(sessionId: SessionId): void {
    const timer = this.draftInjectTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.draftInjectTimers.delete(sessionId)
  }
}
