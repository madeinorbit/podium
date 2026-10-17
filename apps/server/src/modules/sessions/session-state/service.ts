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
  type MachineId,
  type SessionId,
  type SessionUserOverlay,
  sessionUserStateRowId,
  type IssueId,
  type UserId,
  type WorkState,
} from '@podium/model'
import type { DraftEditMessage, LiveServerMessage } from '@podium/protocol'
import type {
  ControlMessage,
  RuntimeDraftResultMessage,
  RuntimeSnapshotResultMessage,
} from '@podium/protocol/daemon'
import type { EntityChangeSpec } from '@podium/sync'
import type { ClientConn } from '../../../gateway/client-registry'
import type { PinState, SessionStore, SnoozeMap } from '../../../store'
import type { IssueRow } from '../../../store/types'
import type { Session, SessionDurableState } from '../session'

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
> & { hasBoundDriver?: boolean }

/**
 * The only DURABLE fields this module may WRITE [POD-3330], as they appear on a
 * draft rather than on the live session. Read state through
 * {@link SessionStateRecord}; change it through one of these.
 */
export type SessionStateDraft = Pick<
  SessionDurableState,
  'draftUpdatedAt' | 'archived' | 'workState'
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
  /** Issue rows by id. `null` records a LOOKED-UP-AND-ABSENT id, which is not
   *  the same as a `has()` miss — see `SessionAuthz.memoIssueOwner`.
   *
   *  This was `Map<string, unknown>` and `unknown` accepts a promise, so the
   *  unawaited `memo.issues.set(id, store.issues.getIssue(id))` that the async
   *  flip created typechecked clean and the read back answered "no owner"
   *  [POD-3507]. */
  issues: Map<string, IssueRow | null>
  /** Grantee lists by `${resourceKind}:${resourceId}`. */
  grants: Map<string, string[]>
  /**
   * Who owns each session of the pass and which issue it is on (POD-6160): the
   * candidates a projection already read (a parked session's record carries
   * both), and the rows `primeOwnerMemo` reads in one batch for the rest, so a
   * session that is not in memory is not read again per check. `null` records
   * a LOOKED-UP-AND-ABSENT id. Optional: a single-session check reads its row.
   */
  sessions?: Map<SessionId, SessionOwnerFacts | null>
}

/** The ownership fields a visibility check reads off a session. */
export interface SessionOwnerFacts {
  ownerUserId?: UserId | null | undefined
  issueId?: IssueId | null | undefined
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
  }) => Promise<{ owner: UserId | null; grants: readonly string[] } | undefined>
  /** Fill a pass's grant memo in one read per resource kind [POD-1653].
   *  Optional: a fixture that omits it is slow, never wrong, because every key
   *  it would have primed is still computed on demand by `sessionOwner`. */
  readonly primeOwnerMemo?: (
    memo: SessionOwnerMemo,
    sessionIds: readonly SessionId[],
  ) => Promise<void>
  /** Persist one session and an optional satellite-row write atomically. The
   *  session's own durable fields are UNCHANGED by this write — one that changes
   *  them goes through {@link writeSession} or {@link mutateSession}. */
  readonly persistSession: (
    sessionId: SessionId,
    additionalWrite?: () => void | Promise<void>,
    additionalChanges?: () => Promise<EntityChangeSpec[]>,
  ) => Promise<void>
  /** {@link persistSession} with a durable-field write applied to the draft the
   *  commit persists [POD-3330]. Persist-only, like the method it sits beside:
   *  no funnel span and no broadcast of its own. */
  readonly writeSession: (
    sessionId: SessionId,
    mutate: (draft: SessionStateDraft) => void,
  ) => Promise<void>
  /** Shared session-field mutation through the host's canonical metadata seam
   *  — the funnel span and the broadcast that makes it visible. */
  readonly mutateSession: (
    sessionId: SessionId,
    mutate: (draft: SessionStateDraft) => void,
  ) => Promise<void>
  readonly broadcastSessions: () => void
  readonly broadcastToClients: (
    message: LiveServerMessage,
    options?: { exceptClientId?: string },
  ) => void
  readonly deliverToClient: (clientId: string, message: LiveServerMessage) => void
  readonly toMachine: (machineId: MachineId, message: ControlMessage) => void
  readonly runtimeDraft?: (
    input: { sessionId: SessionId; operation: { verb: 'get' } | { verb: 'set'; text: string } },
    machineId: MachineId,
  ) => Promise<{ result: RuntimeDraftResultMessage['result'] }>
  readonly runtimeSnapshot?: (
    sessionId: SessionId,
    machineId: MachineId,
  ) => Promise<{ result: RuntimeSnapshotResultMessage['result'] }>
  /** Re-arm durable inbox delivery after native terminal control is released. */
  readonly onNativeViewReleased?: (sessionId: SessionId) => Promise<void>

  /** Lifecycle owns process parking and issue cleanup after archive. */
  readonly onArchived: (sessionId: SessionId) => Promise<void>
}

export type SessionStateReadResult<T> =
  | { readonly kind: 'found'; readonly value: T }
  /** Invisible and nonexistent intentionally collapse to the same result. */
  | { readonly kind: 'absent' }

const DRAFT_WRITE_DEBOUNCE_MS = 750
const DRAFT_SEND_SUPPRESS_MS = 1_000

export class SessionStateService {
  /**
   * Draft documents of the sessions whose draft was used in this process
   * (POD-6160): read from `session_drafts` on first use ({@link docOf}), never
   * loaded at boot, and dropped with the session.
   */
  private readonly draftDocs = new Map<SessionId, DraftDoc>()
  private readonly draftEdits = new Map<SessionId, { tail: Promise<void>; cancelled: boolean }>()
  /** Draft times read for sessions about to be installed, consumed by
   *  {@link installSession} (POD-6160: one batched read, not every draft). */
  private readonly stagedDraftTimes = new Map<SessionId, string>()
  private readonly draftDocWriteTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private readonly draftInjectTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private readonly draftSendSuppressUntil = new Map<SessionId, number>()
  private draftSyncEnabled_ = false

  private readonly lastPriority = new Map<SessionId, string>()
  /**
   * THE LAST TIME NATIVE VIEW WENT AWAY (POD-4524): the newest pass at which a
   * session stopped being rendered in native mode. Ephemeral, never persisted —
   * the attach-TUI warm-park trigger measures unwatchedMs from here, and absent
   * means "never seen watched-then-unwatched", which disables the row rather
   * than arming it (a session with no client terminal has nothing to park, and
   * a blip must never look like abandonment).
   *
   * Survives `resetPriorities` on purpose: a daemon reconnect re-fans every
   * priority, and the warm deadline of an adopted master must continue across
   * it rather than restart. Cleared when the session is watched again (the next
   * unwatch starts a fresh window) and when the session is removed.
   */
  private readonly lastUnwatchedAt = new Map<SessionId, number>()
  /**
   * THE LAST TIME ANYTHING HELD A SESSION (POD-4435): the newest pass at which
   * some connected client rendered it (viewVisible) or streamed it (attached).
   * Ephemeral, never persisted — the shell policy's unheld grace reads it, and
   * absent means "never seen held", which disables the grace rather than
   * arming it (a network blip must never look like abandonment).
   */
  private readonly lastHeldAt = new Map<SessionId, number>()

  constructor(private readonly ports: SessionStatePorts) {}

  setDraftSyncEnabled(enabled: boolean): void {
    this.draftSyncEnabled_ = enabled
  }

  draftSyncEnabled(): boolean {
    return this.draftSyncEnabled_
  }

  /**
   * Forget what this process holds about drafts. Nothing is loaded: a draft
   * document is read when its session's draft is used (POD-6160).
   *
   * `session_drafts` is ONE row per session, and the versioning columns sit
   * beside the text column older builds wrote. So a draft persisted before the
   * versioned columns reads as an ordinary document at rev 0.
   */
  async loadFromStore(): Promise<void> {
    for (const queue of this.draftEdits.values()) queue.cancelled = true
    this.draftEdits.clear()
    this.draftDocs.clear()
    this.stagedDraftTimes.clear()
  }

  /** Read the draft times of sessions about to be installed, in one read; each
   *  {@link installSession} then seeds its session's DRAFT stamp. */
  async stageDraftTimes(sessionIds: readonly SessionId[]): Promise<void> {
    for (const [sessionId, updatedAt] of await this.ports.store.sessions.draftTimesOf(sessionIds)) {
      this.stagedDraftTimes.set(sessionId, updatedAt)
    }
  }

  /** Read restored drafts before commit; install only those sessions after
   *  commit. A cached document of a restored session is dropped, so its next
   *  use reads the restored row. */
  async prepareStoredDrafts(sessionIds: readonly SessionId[]): Promise<() => void> {
    const times = await this.ports.store.sessions.draftTimesOf(sessionIds)
    return () => {
      for (const sessionId of sessionIds) {
        this.draftDocs.delete(sessionId)
        const updatedAt = times.get(sessionId)
        if (updatedAt !== undefined) this.stagedDraftTimes.set(sessionId, updatedAt)
      }
    }
  }

  /** Attach off-row draft metadata to a newly installed runtime session. */
  installSession(sessionId: SessionId): void {
    const session = this.ports.getSession(sessionId)
    const updatedAt = this.stagedDraftTimes.get(sessionId)
    this.stagedDraftTimes.delete(sessionId)
    if (session && updatedAt !== undefined) session.draftUpdatedAt = updatedAt
  }

  /** A session's draft document: the one this process holds, else its row. */
  private async docOf(sessionId: SessionId): Promise<DraftDoc | undefined> {
    const held = this.draftDocs.get(sessionId)
    if (held) return held
    const stored = await this.ports.store.sessions.draftDocOf(sessionId)
    // An edit that landed while the row was read wins over the row.
    const raced = this.draftDocs.get(sessionId)
    if (raced) return raced
    if (!stored) return undefined
    const doc: DraftDoc = {
      sessionId,
      text: stored.text,
      rev: stored.rev,
      origin: stored.origin ?? 'seed',
      editedAt: stored.updatedAt,
      history: stored.history,
    }
    this.draftDocs.set(sessionId, doc)
    return doc
  }

  /**
   * Unfinished draft work for this session lives in this process only: an edit
   * queued or running, a document write or an inject waiting on its timer
   * (POD-6160 D2f: such a session stays resident until it settles).
   */
  holdsWork(sessionId: SessionId): boolean {
    return (
      this.draftEdits.has(sessionId) ||
      this.draftDocWriteTimers.has(sessionId) ||
      this.draftInjectTimers.has(sessionId)
    )
  }

  /**
   * The session leaves memory without leaving the database (POD-6160 D2f): its
   * draft document is its row again, read on the next use. The view-history
   * stamps stay; they describe the clients, not the session's residency.
   */
  evictSession(sessionId: SessionId): void {
    this.draftDocs.delete(sessionId)
    this.stagedDraftTimes.delete(sessionId)
  }

  removeSession(sessionId: SessionId): void {
    const queue = this.draftEdits.get(sessionId)
    if (queue) queue.cancelled = true
    this.draftEdits.delete(sessionId)
    this.draftDocs.delete(sessionId)
    this.stagedDraftTimes.delete(sessionId)
    this.lastPriority.delete(sessionId)
    this.lastHeldAt.delete(sessionId)
    this.lastUnwatchedAt.delete(sessionId)
    this.draftSendSuppressUntil.delete(sessionId)
    const versioned = this.draftDocWriteTimers.get(sessionId)
    if (versioned) clearTimeout(versioned)
    this.draftDocWriteTimers.delete(sessionId)
    this.cancelDraftInject(sessionId)
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
  async primeOwnerMemo(memo: SessionOwnerMemo, sessionIds: readonly SessionId[]): Promise<void> {
    await this.ports.primeOwnerMemo?.(memo, sessionIds)
  }

  async canReadSession(
    principal: SessionStatePrincipal,
    sessionId: SessionId,
    /** Per-pass memo when a full-list caller is asking [POD-1618]. */
    memo?: SessionOwnerMemo,
  ): Promise<boolean> {
    // Keep single-session reads on their original path: batching inserts an
    // await before ownership resolution and can duplicate durable fallback reads.
    const target = await this.ports.sessionOwner({ sessionId, ...(memo ? { memo } : {}) })
    if (!target) return false
    if (target.owner === principal.userId || target.grants.includes(principal.userId)) {
      return true
    }
    // Narrow agent scopes never widen the on-behalf-of human's visibility.
    return principal.capability.scope.kind === 'all'
  }

  /** One reader-scoped set computation. Principals are already admitted by the
   * transport; re-reading account status here would change the existing policy.
   * The memo belongs to this call (or its enclosing projection), never a user cache.
   */
  async visibleSessions(
    principal: SessionStatePrincipal,
    candidates: readonly SessionId[],
    memo: SessionOwnerMemo = { issues: new Map(), grants: new Map() },
  ): Promise<ReadonlySet<SessionId>> {
    const visible = new Set<SessionId>()
    if (candidates.length === 0) return visible
    const ids = [...new Set(candidates)]
    await this.primeOwnerMemo(memo, ids)
    for (const sessionId of ids) {
      const target = await this.ports.sessionOwner({ sessionId, memo })
      if (
        target &&
        (target.owner === principal.userId ||
          target.grants.includes(principal.userId) ||
          principal.capability.scope.kind === 'all')
      ) {
        visible.add(sessionId)
      }
    }
    return visible
  }

  /**
   * Projection overlay for a caller already proven able to see the session:
   * the reader's own read marker and snooze, read from the database
   * (POD-6160; there is no per-user cache to drop on every write).
   */
  async overlay(userId: UserId, sessionId: SessionId): Promise<SessionUserOverlay> {
    return (await this.overlaySnapshot(userId, [sessionId])).get(sessionId) ?? { readAt: null, snoozedUntil: undefined }
  }

  /** One reader's overlays of a set of sessions, read together; the returned
   *  overlays have no service access. */
  async overlaySnapshot(
    userId: UserId,
    sessionIds: readonly SessionId[],
  ): Promise<ReadonlyMap<SessionId, SessionUserOverlay>> {
    const rows = await this.ports.store.sessions.userStateOf(userId, sessionIds)
    return new Map(
      sessionIds.map((id) => {
        const row = rows.get(id)
        return [id, { readAt: row?.readAt ?? null, snoozedUntil: row && 'snoozedUntil' in row ? row.snoozedUntil : undefined }]
      }),
    )
  }

  async readOverlay(
    principal: SessionStatePrincipal,
    sessionId: SessionId,
  ): Promise<SessionStateReadResult<SessionUserOverlay>> {
    if (!(await this.canReadSession(principal, sessionId))) return { kind: 'absent' }
    return { kind: 'found', value: await this.overlay(principal.userId, sessionId) }
  }

  async isSnoozed(userId: UserId, sessionId: SessionId): Promise<boolean> {
    return (await this.overlay(userId, sessionId)).snoozedUntil !== undefined
  }

  private async persistPerUser(
    userId: UserId,
    sessionId: SessionId,
    write: () => void | Promise<void>,
  ): Promise<boolean> {
    if (!this.ports.getSession(sessionId)) return false
    await this.ports.persistSession(
      sessionId,
      async () => {
        await write()
      },
      () => this.userStateChanges(sessionId, [userId]),
    )
    this.ports.broadcastSessions()
    return true
  }

  private async userStateChanges(
    sessionId: SessionId,
    users: readonly UserId[],
  ): Promise<EntityChangeSpec[]> {
    return Promise.all(
      users.map(async (userId) => ({
        entity: 'sessionUserState' as const,
        id: sessionUserStateRowId(userId, sessionId),
        op: 'upsert' as const,
        value: await this.ports.store.sessions.sessionUserStateFor(
          userId,
          sessionId,
          this.ports.now(),
        ),
      })),
    )
  }

  async markRead(principal: SessionStatePrincipal, sessionId: SessionId): Promise<boolean> {
    if (!(await this.canReadSession(principal, sessionId))) return false
    return this.persistPerUser(
      principal.userId,
      sessionId,
      async () =>
        await this.ports.store.sessions.markSessionRead(
          principal.userId,
          sessionId,
          new Date(this.ports.now()).toISOString(),
        ),
    )
  }

  async markUnread(principal: SessionStatePrincipal, sessionId: SessionId): Promise<boolean> {
    if (!(await this.canReadSession(principal, sessionId))) return false
    return this.persistPerUser(
      principal.userId,
      sessionId,
      async () => await this.ports.store.sessions.markSessionUnread(principal.userId, sessionId),
    )
  }

  async rearmUnreadForAll(sessionId: SessionId): Promise<void> {
    if (!this.ports.getSession(sessionId)) return
    let users: UserId[] = []
    await this.ports.persistSession(
      sessionId,
      async () => {
        users = await this.ports.store.sessions.clearAllReadAt(sessionId)
      },
      () => this.userStateChanges(sessionId, users),
    )
    this.ports.broadcastSessions()
  }

  async setSnooze(
    principal: SessionStatePrincipal,
    sessionId: SessionId,
    until: string | null,
  ): Promise<boolean> {
    if (!(await this.canReadSession(principal, sessionId))) return false
    return this.persistPerUser(
      principal.userId,
      sessionId,
      async () => await this.ports.store.sessions.setSnooze(principal.userId, sessionId, until),
    )
  }

  async clearSnooze(principal: SessionStatePrincipal, sessionId: SessionId): Promise<boolean> {
    if (!(await this.canReadSession(principal, sessionId))) return false
    return this.persistPerUser(
      principal.userId,
      sessionId,
      async () => await this.ports.store.sessions.clearSnooze(principal.userId, sessionId),
    )
  }

  /** Shared session activity invalidates every viewer's snooze independently. */
  async clearAllSnoozes(sessionId: SessionId): Promise<void> {
    if (!this.ports.getSession(sessionId)) return
    if (!(await this.ports.store.sessions.hasAnySnooze(sessionId))) return
    let users: UserId[] = []
    await this.ports.persistSession(
      sessionId,
      async () => {
        users = await this.ports.store.sessions.clearAllSnoozes(sessionId)
      },
      () => this.userStateChanges(sessionId, users),
    )
    this.ports.broadcastSessions()
  }

  async listSnoozes(principal: SessionStatePrincipal): Promise<SnoozeMap> {
    const rows = await this.ports.store.sessions.listSnoozes(principal.userId)
    const visible: SnoozeMap = {}
    for (const [rawId, until] of Object.entries(rows)) {
      const sessionId = rawId as SessionId
      if (await this.canReadSession(principal, sessionId)) visible[sessionId] = until
    }
    return visible
  }

  async listPins(principal: SessionStatePrincipal): Promise<PinState> {
    const rows = await this.ports.store.sessions.listPins(principal.userId)
    const panelVisible = await Promise.all(
      rows.panels.map(async (id) => {
        const sessionId = id as SessionId
        // Not a session (another panel kind) or one that no longer exists: left
        // alone. A session, running or parked, obeys visibility (POD-6160: a
        // parked one is not in memory, so ask its owner, read from its row).
        if (!(await this.ports.sessionOwner({ sessionId }))) return true
        return await this.canReadSession(principal, sessionId)
      }),
    )
    return {
      ...rows,
      // Panel ids that name sessions obey session visibility. Non-session panel
      // ids are left alone; this module is not entitled to classify them.
      // Verdicts awaited into an array first: `.filter` over an async predicate
      // keeps EVERY element, because a pending promise is truthy [POD-3507].
      panels: rows.panels.filter((_id, index) => panelVisible[index] === true),
    }
  }

  async setPin(
    principal: SessionStatePrincipal,
    kind: Parameters<SessionStore['sessions']['setPin']>[1],
    id: string,
    pinned: boolean,
  ): Promise<PinState> {
    await this.ports.store.sessions.setPin(principal.userId, kind, id, pinned)
    return await this.listPins(principal)
  }

  async listTabOrders(principal: SessionStatePrincipal): Promise<Record<string, string[]>> {
    const rows = await this.ports.store.sessions.listTabOrders(principal.userId)
    const visible: Record<string, string[]> = {}
    for (const [worktree, ids] of Object.entries(rows)) {
      const verdicts = await Promise.all(
        ids.map(async (id) => await this.canReadSession(principal, id as SessionId)),
      )
      visible[worktree] = ids.filter((_id, index) => verdicts[index] === true)
    }
    return visible
  }

  async setTabOrder(
    principal: SessionStatePrincipal,
    worktree: string,
    sessionIds: string[],
  ): Promise<Record<string, string[]>> {
    const readable = await Promise.all(
      sessionIds.map(async (id) => await this.canReadSession(principal, id as SessionId)),
    )
    if (readable.some((ok) => ok !== true)) {
      return await this.listTabOrders(principal)
    }
    await this.ports.store.sessions.setTabOrder(principal.userId, worktree, sessionIds)
    return await this.listTabOrders(principal)
  }

  // -------------------------------------------------------------------------
  // Shared session facts
  // -------------------------------------------------------------------------

  async setArchived(sessionId: SessionId, archived: boolean): Promise<void> {
    await this.ports.mutateSession(sessionId, (draft) => {
      draft.archived = archived
    })
    if (archived) await this.ports.onArchived(sessionId)
  }

  async setWorkState(sessionId: SessionId, workState: WorkState | null): Promise<void> {
    await this.ports.mutateSession(sessionId, (draft) => {
      draft.workState = workState ?? undefined
    })
  }

  // -------------------------------------------------------------------------
  // Viewer-derived relay priority (ephemeral, never persisted)
  // -------------------------------------------------------------------------

  resetPriorities(): void {
    this.lastPriority.clear()
  }

  /**
   * Whether any connected client still holds the session — rendering it on
   * screen (viewState `visible`) or streaming its terminal output (attached).
   * The shell lifetime policy reads this as its "any tab holds it" level.
   *
   * `excludeClientId` drops one connection from the answer: the tab-release
   * path reports for the client that just closed, whose own sets may not have
   * caught up with the close yet. A disconnect never consults this — a dropped
   * WebSocket sends no release, so nothing it held is ever evaluated.
   */
  isHeld(sessionId: SessionId, excludeClientId?: string): boolean {
    for (const client of this.ports.clients()) {
      if (excludeClientId !== undefined && client.id === excludeClientId) continue
      if (client.viewVisible.has(sessionId)) return true
      if (client.attached.has(sessionId)) return true
    }
    return false
  }

  /**
   * When anything last held the session (see {@link isHeld}), or undefined
   * when nothing has since boot. The shell policy's unheld grace measures from
   * here; undefined disables it.
   */
  lastHeldAtMs(sessionId: SessionId): number | undefined {
    return this.lastHeldAt.get(sessionId)
  }

  /**
   * When native view last went away (see {@link lastUnwatchedAt}), or undefined
   * when the session was never seen watched-then-unwatched since boot. The
   * attach-TUI warm-park trigger measures unwatchedMs from here; undefined
   * disables its row.
   */
  lastUnwatchedAtMs(sessionId: SessionId): number | undefined {
    return this.lastUnwatchedAt.get(sessionId)
  }

  /**
   * Whether any connected client renders the session in native mode right now
   * (the shell policy's viewer input for attach TUIs). Same exclusion contract
   * as {@link isHeld}.
   */
  isWatched(sessionId: SessionId, excludeClientId?: string): boolean {
    for (const client of this.ports.clients()) {
      if (excludeClientId !== undefined && client.id === excludeClientId) continue
      if (
        client.viewVisible.has(sessionId) &&
        (client.viewModes[sessionId] ?? 'native') === 'native'
      ) {
        return true
      }
    }
    return false
  }

  pushPriorities(): void {
    const clients = [...this.ports.clients()]
    const heldAt = this.ports.now()
    for (const client of clients) {
      for (const sessionId of client.viewVisible) this.lastHeldAt.set(sessionId, heldAt)
      for (const sessionId of client.attached) this.lastHeldAt.set(sessionId, heldAt)
    }
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
        // POD-4524: the warm window starts when the last native viewer leaves —
        // tier-only changes (1:1 → 0:1) never touch it, and a repeat unwatched
        // frame never restarts it.
        this.lastUnwatchedAt.set(sessionId, heldAt)
        // NOT awaited: pushPriorities is a synchronous fan-out over clients,
        // and the release only re-arms a drain (rule 57 — same durable-row
        // contract as machine-reconciler's).
        void this.ports.onNativeViewReleased?.(sessionId)
      } else if (nativeView) {
        // Watched again: the next unwatch starts a fresh warm window.
        this.lastUnwatchedAt.delete(sessionId)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Shared composer document
  // -------------------------------------------------------------------------

  async draftRevision(sessionId: SessionId): Promise<number | undefined> {
    return (await this.docOf(sessionId))?.rev
  }

  /** The current server-side composer text, used only to avoid clobbering a
   * human edit while automatic prompt recovery restores or clears its seed. */
  async draftText(sessionId: SessionId): Promise<string | undefined> {
    return (await this.docOf(sessionId))?.text
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
  async setDraft(
    input: { sessionId: SessionId; text: string },
    fromClientId?: string,
  ): Promise<void> {
    await this.applyVersionedEdit(
      input.sessionId,
      { text: input.text, origin: fromClientId ?? 'seed' },
      fromClientId,
    )
  }

  /** A VERSIONED edit: the sender names the rev it typed against, so a race can
   *  be arbitrated instead of silently resolved in favour of whoever was last. */
  async handleDraftEdit(input: DraftEditMessage, fromClientId: string): Promise<void> {
    await this.applyVersionedEdit(
      input.sessionId,
      { baseRev: input.baseRev, text: input.text, origin: fromClientId },
      fromClientId,
    )
  }

  async handleNativeDraft(sessionId: SessionId, text: string): Promise<void> {
    if (!this.draftSyncEnabled_) return
    if (Date.now() < (this.draftSendSuppressUntil.get(sessionId) ?? 0)) return
    await this.applyVersionedEdit(sessionId, { text, origin: 'native' }, undefined)
  }

  suppressNativeDraft(sessionId: SessionId): void {
    if (this.draftSyncEnabled_) {
      this.draftSendSuppressUntil.set(sessionId, Date.now() + DRAFT_SEND_SUPPRESS_MS)
    }
  }

  async maybeCatchupInject(sessionId: SessionId, machineId: MachineId): Promise<void> {
    if (!this.draftSyncEnabled_) return
    const doc = await this.docOf(sessionId)
    if (!doc?.text) return
    const lastLive = this.ports.getSession(sessionId)?.lastActiveAt
    if (lastLive && doc.editedAt <= lastLive) return
    this.sendDraftTarget(sessionId, machineId, doc.text)
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
  async replayDrafts(
    principal: SessionStatePrincipal,
    send: (message: LiveServerMessage) => void,
  ): Promise<void> {
    // Every stored draft (a row exists only while its text is not empty), with
    // the documents this process holds taking precedence (POD-6160). The stored
    // ones are not cached: a draft is held once its session uses it.
    const stored = await this.ports.store.sessions.loadDraftDocs()
    const candidates = new Set<SessionId>([...(Object.keys(stored) as SessionId[]), ...this.draftDocs.keys()])
    const visibleIds: SessionId[] = []
    for (const sessionId of candidates) {
      if (await this.canReadSession(principal, sessionId)) visibleIds.push(sessionId)
    }
    // No await may separate reading a document from sending it. Live edits can
    // replace draftDocs during authorization; replaying a captured older rev
    // afterward would overwrite the client's newer text (POD-3539).
    for (const sessionId of visibleIds) {
      const row = stored[sessionId]
      const doc =
        this.draftDocs.get(sessionId) ??
        (row
          ? {
              sessionId,
              text: row.text,
              rev: row.rev,
              origin: row.origin ?? 'seed',
              editedAt: row.updatedAt,
              history: row.history,
            }
          : undefined)
      if (doc?.text) send(this.draftWire(doc))
    }
  }

  private applyVersionedEdit(
    sessionId: SessionId,
    edit: { baseRev?: number; text: string; origin: string },
    fromClientId?: string,
  ): Promise<void> {
    // The DRAFT-tag commit suspends. Serialize the complete edit so a later
    // clear cannot overtake that commit and leave the older tag installed.
    let queue = this.draftEdits.get(sessionId)
    if (!queue) {
      queue = { tail: Promise.resolve(), cancelled: false }
      this.draftEdits.set(sessionId, queue)
    }
    const currentQueue = queue
    const operation = currentQueue.tail
      .catch(() => {})
      .then(async () => {
        if (!currentQueue.cancelled) await this.commitVersionedEdit(sessionId, edit, fromClientId)
      })
    currentQueue.tail = operation
    return operation.finally(() => {
      if (this.draftEdits.get(sessionId) === currentQueue && currentQueue.tail === operation) {
        this.draftEdits.delete(sessionId)
      }
    })
  }

  private async commitVersionedEdit(
    sessionId: SessionId,
    edit: { baseRev?: number; text: string; origin: string },
    fromClientId?: string,
  ): Promise<void> {
    const current = (await this.docOf(sessionId)) ?? emptyDraftDoc(sessionId)
    const result = applyDraftEdit(current, {
      baseRev: edit.baseRev ?? current.rev,
      text: edit.text,
      origin: edit.origin,
      at: new Date().toISOString(),
    })
    if (result.status === 'rejected') {
      if (fromClientId) this.ports.deliverToClient(fromClientId, this.draftWire(result.doc))
      return
    }
    if (!result.changed) {
      // A restored/offline edit may already be the server's current text. It
      // still needs an acknowledgement, especially for a retried clear whose
      // empty document is omitted from reconnect replay. Otherwise that device
      // stays dirty and later re-offers its cache over another device's edit.
      if (fromClientId) this.ports.deliverToClient(fromClientId, this.draftWire(result.doc))
      return
    }
    const doc = result.doc
    this.draftDocs.set(sessionId, doc)
    const session = this.ports.getSession(sessionId)
    const draftNonemptyChanged = session && (session.draftUpdatedAt !== undefined) !== !!doc.text
    const editedAt = doc.text ? doc.editedAt : undefined
    // THE TAG IS WRITTEN THROUGH THE WRITE THAT PERSISTS IT [POD-3330] when the
    // DRAFT/no-DRAFT bit flips, because that is the case with a commit in the
    // span. Every other edit only advances a stamp nothing is persisting here —
    // the text itself lives in `session_drafts`, written above — so it stays a
    // live assignment with no window to be captured in.
    if (draftNonemptyChanged) {
      try {
        await this.ports.writeSession(sessionId, (draft) => {
          draft.draftUpdatedAt = editedAt
        })
      } catch (error) {
        log.warn('failed to persist the DRAFT tag', { err: error, sessionId })
      }
    } else if (session) session.draftUpdatedAt = editedAt
    if (this.draftDocs.get(sessionId) !== doc) return
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
    await this.persistDraftDoc(sessionId, doc)
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
  private async persistDraftDoc(sessionId: SessionId, doc: DraftDoc): Promise<void> {
    if (!doc.text) {
      const pending = this.draftDocWriteTimers.get(sessionId)
      if (pending) clearTimeout(pending)
      this.draftDocWriteTimers.delete(sessionId)
      await this.writeDraftDoc(doc)
      return
    }
    if (this.draftDocWriteTimers.has(sessionId)) return
    const timer = setTimeout(async () => {
      this.draftDocWriteTimers.delete(sessionId)
      await this.writeDraftDoc(this.draftDocs.get(sessionId) ?? doc)
    }, DRAFT_WRITE_DEBOUNCE_MS)
    timer.unref?.()
    this.draftDocWriteTimers.set(sessionId, timer)
  }

  private async writeDraftDoc(doc: DraftDoc): Promise<void> {
    try {
      await this.ports.store.sessions.setDraftDoc(doc.sessionId, {
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

  /** Seed a rebound driver-bound session once; subsequent changes arrive as events. */
  async initializeRuntimeDraft(sessionId: SessionId, machineId: MachineId): Promise<void> {
    if (!this.draftSyncEnabled_) return
    const session = this.ports.getSession(sessionId)
    if (!session?.hasBoundDriver) {
      await this.maybeCatchupInject(sessionId, machineId)
      return
    }
    const before = await this.docOf(sessionId)
    const revision = before?.rev
    if (
      before &&
      before.rev > 0 &&
      (!session.lastActiveAt || before.editedAt > session.lastActiveAt)
    ) {
      this.sendDraftTarget(sessionId, machineId, before.text)
      return
    }
    const snapshot = await this.ports.runtimeSnapshot?.(sessionId, machineId)
    let text =
      snapshot && 'snapshot' in snapshot.result ? snapshot.result.snapshot.draft : undefined
    if (text === undefined) {
      const answer = await this.ports.runtimeDraft?.(
        { sessionId, operation: { verb: 'get' } },
        machineId,
      )
      if (answer && 'text' in answer.result) text = answer.result.text
    }
    // A delayed bootstrap must never replace a draft edited while it was in flight.
    if (
      text !== undefined &&
      this.ports.getSession(sessionId) === session &&
      this.draftDocs.get(sessionId)?.rev === revision
    ) {
      await this.handleNativeDraft(sessionId, text)
    }
  }

  private sendDraftTarget(sessionId: SessionId, machineId: MachineId, text: string): void {
    if (!this.ports.getSession(sessionId)?.hasBoundDriver) {
      this.ports.toMachine(machineId, { type: 'draftTarget', sessionId, text })
      return
    }
    void this.ports
      .runtimeDraft?.({ sessionId, operation: { verb: 'set', text } }, machineId)
      .then(({ result }) => {
        if ('reason' in result)
          log.warn('runtime draft write refused', { sessionId, reason: result.reason })
      })
      .catch((error: unknown) => log.warn('runtime draft write failed', { sessionId, err: error }))
  }

  private scheduleDraftInject(sessionId: SessionId): void {
    const existing = this.draftInjectTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.draftInjectTimers.delete(sessionId)
      const doc = this.draftDocs.get(sessionId)
      const session = this.ports.getSession(sessionId)
      if (!doc || !session || doc.origin === 'native') return
      this.sendDraftTarget(sessionId, session.machineId, doc.text)
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
