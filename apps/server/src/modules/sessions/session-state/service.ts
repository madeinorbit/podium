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

import {
  computePriorities,
  type Capability,
  type SessionId,
  type SessionUserOverlay,
  type UserId,
  type WorkState,
} from '@podium/model'
import type { ControlMessage, DraftEditMessage, LiveServerMessage } from '@podium/protocol'
import type { PinState, SessionStore, SnoozeMap } from '../../../store'
import type { ClientConn } from '../../../gateway/client-registry'
import { applyDraftEdit, DEFAULT_LEASE_MS, type DraftDoc, emptyDraftDoc } from '../draft-doc'
import type { Session } from '../session'

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
  readonly toMachine: (machineId: string, message: ControlMessage) => void
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

  private readonly drafts = new Map<SessionId, string>()
  private readonly draftDocs = new Map<SessionId, DraftDoc>()
  private readonly draftTimes = new Map<SessionId, string>()
  private readonly draftWriteTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private readonly draftDocWriteTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private readonly draftInjectTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private readonly draftSendSuppressUntil = new Map<SessionId, number>()
  private draftSyncEnabled_ = false

  private readonly lastPriority = new Map<SessionId, number>()

  constructor(private readonly ports: SessionStatePorts) {}

  setDraftSyncEnabled(enabled: boolean): void {
    this.draftSyncEnabled_ = enabled
  }

  draftSyncEnabled(): boolean {
    return this.draftSyncEnabled_
  }

  /** Hydrate shared draft documents. Per-user rows remain lazy per principal. */
  loadFromStore(): void {
    this.drafts.clear()
    this.draftDocs.clear()
    this.draftTimes.clear()
    for (const [rawSessionId, text] of Object.entries(this.ports.store.sessions.loadDrafts())) {
      const sessionId = rawSessionId as SessionId
      this.drafts.set(sessionId, text)
    }
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
    this.drafts.delete(sessionId)
    this.draftDocs.delete(sessionId)
    this.draftTimes.delete(sessionId)
    this.lastPriority.delete(sessionId)
    this.draftSendSuppressUntil.delete(sessionId)
    const legacy = this.draftWriteTimers.get(sessionId)
    if (legacy) clearTimeout(legacy)
    this.draftWriteTimers.delete(sessionId)
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
    const priorities = computePriorities([...this.ports.clients()], this.ports.sessionIds())
    for (const [sessionId, priority] of priorities) {
      if (this.lastPriority.get(sessionId) === priority) continue
      this.lastPriority.set(sessionId, priority)
      // No live session means no machine to prioritise on. This used to fall back to
      // the placeholder, which sent the frame to a queue keyed by a name no daemon
      // answers to — a message that could only ever be dropped, pretending to be sent.
      const machineId = this.ports.getSession(sessionId)?.machineId
      if (machineId === undefined) continue
      this.ports.toMachine(machineId, { type: 'sessionPriority', sessionId, priority })
    }
  }

  // -------------------------------------------------------------------------
  // Shared composer document
  // -------------------------------------------------------------------------

  draftRevision(sessionId: SessionId): number | undefined {
    return this.draftDocs.get(sessionId)?.rev
  }

  setDraft(input: { sessionId: SessionId; text: string }, fromClientId?: string): void {
    if (this.draftSyncEnabled_) {
      const current = this.draftDocs.get(input.sessionId) ?? emptyDraftDoc(input.sessionId)
      this.applyVersionedEdit(
        input.sessionId,
        { baseRev: current.rev, text: input.text, origin: fromClientId ?? 'seed' },
        fromClientId,
      )
      return
    }
    const previous = this.drafts.get(input.sessionId)
    if (input.text) this.drafts.set(input.sessionId, input.text)
    else this.drafts.delete(input.sessionId)
    const session = this.ports.getSession(input.sessionId)
    const draftNonemptyChanged = session && (session.draftUpdatedAt !== undefined) !== !!input.text
    if (session) session.draftUpdatedAt = input.text ? new Date().toISOString() : undefined
    if (draftNonemptyChanged) {
      try {
        this.ports.persistSession(input.sessionId)
      } catch (error) {
        if (previous === undefined) this.drafts.delete(input.sessionId)
        else this.drafts.set(input.sessionId, previous)
        throw error
      }
    }
    this.ports.broadcastToClients(
      { type: 'sessionDraftChanged', sessionId: input.sessionId, text: input.text },
      fromClientId === undefined ? undefined : { exceptClientId: fromClientId },
    )
    this.persistLegacyDraft(input.sessionId, input.text)
    if (draftNonemptyChanged) this.ports.broadcastSessions()
  }

  handleDraftEdit(input: DraftEditMessage, fromClientId: string): void {
    if (!this.draftSyncEnabled_) {
      this.setDraft({ sessionId: input.sessionId, text: input.text }, fromClientId)
      return
    }
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

  maybeCatchupInject(sessionId: SessionId, machineId: string): void {
    if (!this.draftSyncEnabled_) return
    const doc = this.draftDocs.get(sessionId)
    if (!doc?.text) return
    const lastLive = this.ports.getSession(sessionId)?.lastActiveAt
    if (lastLive && doc.editedAt <= lastLive) return
    this.ports.toMachine(machineId, { type: 'draftTarget', sessionId, text: doc.text })
  }

  replayDrafts(principal: SessionStatePrincipal, send: (message: LiveServerMessage) => void): void {
    if (this.draftSyncEnabled_) {
      for (const doc of this.draftDocs.values()) {
        if (doc.text && this.canReadSession(principal, doc.sessionId)) send(this.draftWire(doc))
      }
      return
    }
    for (const [sessionId, text] of this.drafts) {
      if (this.canReadSession(principal, sessionId)) {
        send({ type: 'sessionDraftChanged', sessionId, text })
      }
    }
  }

  private persistLegacyDraft(sessionId: SessionId, text: string): void {
    const existing = this.draftWriteTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    this.draftWriteTimers.delete(sessionId)
    if (!text) {
      this.writeLegacyDraft(sessionId, '')
      return
    }
    const timer = setTimeout(() => {
      this.draftWriteTimers.delete(sessionId)
      this.writeLegacyDraft(sessionId, this.drafts.get(sessionId) ?? '')
    }, DRAFT_WRITE_DEBOUNCE_MS)
    timer.unref?.()
    this.draftWriteTimers.set(sessionId, timer)
  }

  private writeLegacyDraft(sessionId: SessionId, text: string): void {
    try {
      const updatedAt = this.ports.store.sessions.setDraft(sessionId, text)
      if (updatedAt === undefined) this.draftTimes.delete(sessionId)
      else this.draftTimes.set(sessionId, updatedAt)
    } catch (error) {
      console.warn(`[podium] failed to persist draft for ${sessionId}:`, error)
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
        console.warn(`[podium] failed to persist DRAFT tag for ${sessionId}:`, error)
      }
    }
    this.ports.broadcastToClients(
      this.draftWire(doc),
      fromClientId === undefined ? undefined : { exceptClientId: fromClientId },
    )
    this.persistDraftDoc(sessionId, doc)
    if (draftNonemptyChanged) this.ports.broadcastSessions()
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

  private persistDraftDoc(sessionId: SessionId, doc: DraftDoc): void {
    const existing = this.draftDocWriteTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    this.draftDocWriteTimers.delete(sessionId)
    if (!doc.text) {
      this.writeDraftDoc(doc)
      return
    }
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
      console.warn(`[podium] failed to persist versioned draft for ${doc.sessionId}:`, error)
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
