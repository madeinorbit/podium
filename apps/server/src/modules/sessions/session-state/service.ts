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
  type SessionMarksWire,
  sessionMarksRowId,
  type SessionUserOverlay,
  type UserId,
  type WorkState,
  type MachineId,
} from '@podium/model'
import type { DraftEditMessage, LiveServerMessage } from '@podium/protocol'
import type { Ledger } from '@podium/sync'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { ClientConn } from '../../../gateway/client-registry'
import type { PinState, SessionStore, SnoozeMap } from '../../../store'
import type { IssueRow } from '../../../store/types'
import { mayReadPrivate } from '../../../issue-authz'
import type { NullableSessionOwnership } from '../session-ownership'
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

/**
 * AN INTERNAL READ — the server reading its own session surface with NO human
 * behind it (ADR 3 Amendment 1 D21: an in-process job "may read across owners,
 * but it has NO human and must never be assigned one").
 *
 * IT IS A SEPARATE TYPE FROM {@link SessionStatePrincipal}, DELIBERATELY, and
 * that is the whole repair [PDM-291]. Before this, a principal-less read ran as
 * `SessionView.defaultPrincipal()` — the earliest admin, minted by
 * `userCommandPrincipal` with `scope: { kind: 'all' }` — so the ONE disjunct
 * `principal.capability.scope.kind === 'all'` at the bottom of the two rules
 * below was answering for two unrelated callers at once: the server's own
 * projections, and any human who happens to hold an admin capability. PDM-270
 * could remove the matching admin short circuit from `mayWatch`/`mayDrive` and
 * could NOT remove this one, because removing it refused the internal reads
 * too. Splitting the type splits the answer: an internal read is admitted
 * because it is the server, and an admin human is now refused because ADR 9
 * Amendment 1 D7 says an admin may not view another member's session.
 *
 * It cannot be minted from a transport. `sessionStatePrincipalFor()` still
 * THROWS on a system principal, and nothing constructs one of these from a
 * request; the only constructor is {@link internalSessionRead}, called in
 * process. And because the per-user WRITES below (snooze, pins, read markers,
 * tab order) take `SessionStatePrincipal` and not `SessionReader`, the compiler
 * refuses an internal read at every one of them — it has no user id to key a
 * row by, which is exactly D21's "no human" stated as a type.
 */
export interface InternalSessionRead {
  readonly kind: 'internal'
  /** Which in-process caller this is, for attribution in a log or a stack.
   *  NO RULE READS IT — it is a label, never a capability. */
  readonly job: string
}

/** Who a session VISIBILITY question is being asked for: a human (or an agent
 *  acting for one), or the server itself. Reads take this; writes take the
 *  narrower {@link SessionStatePrincipal}. */
export type SessionReader = SessionStatePrincipal | InternalSessionRead

/** The one constructor for {@link InternalSessionRead}. In-process only. */
export function internalSessionRead(job: string): InternalSessionRead {
  return { kind: 'internal', job }
}

/** Narrow a {@link SessionReader}. `SessionStatePrincipal` has no `kind`, so the
 *  discriminant is presence rather than value. */
export function isInternalSessionRead(reader: SessionReader): reader is InternalSessionRead {
  return 'kind' in reader
}

/** The only live-session fields this module may touch; derived from the canonical Session. */
export type SessionStateRecord = Pick<
  Session,
  'sessionId' | 'machineId' | 'lastActiveAt' | 'draftUpdatedAt' | 'archived' | 'workState'
>

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
}

export interface SessionStatePorts {
  /** `transact` is here for the CROSS-OWNER writes [PDM-424 review]:
   *  {@link SessionStateService.rearmUnreadForAll} clears N holders' rows and
   *  must publish N sidecar rows in the SAME transaction, and it has no
   *  `persistSession` to borrow one from. */
  readonly store: Pick<SessionStore, 'sessions' | 'transact'>
  /**
   * WRITE-SEAM LEDGER for the `sessionMarks` sidecar [PDM-424].
   *
   * Per-person read marks and snoozes ride entity kind `sessionMarks`, so
   * bootstrap and delta share one log — the shape `ReadPositionService` uses.
   * `reconcile` is the boot repair for rows that predate the entity.
   *
   * OPTIONAL ONLY FOR PURE UNIT FIXTURES of storage and policy; production
   * always wires it. A fixture that omits it exercises the durable write and
   * skips the publish, which is why the delivery witnesses supply a real one
   * rather than asserting on a spy.
   */
  readonly ledger?: Pick<Ledger, 'capture' | 'reconcile'>
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
  }) => Promise<NullableSessionOwnership | undefined>
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
  readonly persistSession: (sessionId: SessionId, additionalWrite?: () => void | Promise<void>) => Promise<void>
  /** {@link persistSession} with a durable-field write applied to the draft the
   *  commit persists [POD-3330]. Persist-only, like the method it sits beside:
   *  no funnel span and no broadcast of its own. */
  readonly writeSession: (sessionId: SessionId, mutate: (draft: SessionStateDraft) => void) => Promise<void>
  /** Shared session-field mutation through the host's canonical metadata seam
   *  — the funnel span and the broadcast that makes it visible. */
  readonly mutateSession: (sessionId: SessionId, mutate: (draft: SessionStateDraft) => void) => Promise<void>
  readonly broadcastSessions: () => void
  readonly broadcastToClients: (
    message: LiveServerMessage,
    options?: { exceptClientId?: string },
  ) => void
  readonly deliverToClient: (clientId: string, message: LiveServerMessage) => void
  readonly toMachine: (machineId: MachineId, message: ControlMessage) => void
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
  private readonly overlays = new Map<
    UserId,
    { readAt: Record<string, string | null>; snoozes: Record<string, string | null> }
  >()

  private readonly draftDocs = new Map<SessionId, DraftDoc>()
  private readonly draftEdits = new Map<SessionId, { tail: Promise<void>; cancelled: boolean }>()
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
  async loadFromStore(): Promise<void> {
    for (const queue of this.draftEdits.values()) queue.cancelled = true
    this.draftEdits.clear()
    this.draftDocs.clear()
    this.draftTimes.clear()
    for (const [rawSessionId, updatedAt] of Object.entries(
      await this.ports.store.sessions.loadDraftTimes(),
    )) {
      this.draftTimes.set(rawSessionId as SessionId, updatedAt)
    }
    for (const [rawSessionId, stored] of Object.entries(
      await this.ports.store.sessions.loadDraftDocs(),
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

  /** Read restored drafts before commit; install only those sessions after commit. */
  async prepareStoredDrafts(sessionIds: readonly SessionId[]): Promise<() => void> {
    const times = await this.ports.store.sessions.loadDraftTimes()
    const docs = await this.ports.store.sessions.loadDraftDocs()
    return () => {
      for (const sessionId of sessionIds) {
        this.draftTimes.delete(sessionId)
        this.draftDocs.delete(sessionId)
        const updatedAt = times[sessionId]
        if (updatedAt !== undefined) this.draftTimes.set(sessionId, updatedAt)
        const stored = docs[sessionId]
        if (stored) this.draftDocs.set(sessionId, {
          sessionId,
          text: stored.text,
          rev: stored.rev,
          origin: stored.origin ?? 'seed',
          editedAt: stored.updatedAt,
          history: stored.history,
        })
      }
    }
  }

  /** Attach off-row draft metadata to a newly installed runtime session. */
  installSession(sessionId: SessionId): void {
    const session = this.ports.getSession(sessionId)
    const updatedAt = this.draftTimes.get(sessionId)
    if (session && updatedAt !== undefined) session.draftUpdatedAt = updatedAt
  }

  removeSession(sessionId: SessionId): void {
    const queue = this.draftEdits.get(sessionId)
    if (queue) queue.cancelled = true
    this.draftEdits.delete(sessionId)
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
  async primeOwnerMemo(memo: SessionOwnerMemo, sessionIds: readonly SessionId[]): Promise<void> {
    await this.ports.primeOwnerMemo?.(memo, sessionIds)
  }

  async canReadSession(
    reader: SessionReader,
    sessionId: SessionId,
    /** Per-pass memo when a full-list caller is asking [POD-1618]. */
    memo?: SessionOwnerMemo,
  ): Promise<boolean> {
    // Keep single-session reads on their original path: batching inserts an
    // await before ownership resolution and can duplicate durable fallback reads.
    const target = await this.ports.sessionOwner({ sessionId, ...(memo ? { memo } : {}) })
    // ABSENCE FIRST, for an internal read too. Absence and invisibility share
    // one false result here (see the class note), and an internal read of an id
    // that does not exist is still absent.
    if (!target) return false
    // The server reading its own surface, not a person with a wide capability
    // [PDM-291]. Same shape as `memory/visibility.ts`'s `reader.kind ===
    // 'system'`, and the same reason: an internal read has no owner to compare.
    if (isInternalSessionRead(reader)) return true
    // OWNER, AND NOTHING ELSE — asked of the MODEL rather than spelled here
    // (B2/PDM-251). There is deliberately no role or scope arm: ADR 9 Amendment
    // 1 D7 (an admin may not view another member's session) is a rule the model
    // cannot break. A narrow agent scope never widened the on-behalf-of human's
    // visibility; a wide one does not either.
    //
    // This was `target.owner === reader.userId || target.grants.includes(...)`,
    // hand-rolled — the owner-or-GRANT rule, which is the TASK predicate, and
    // the "second spelling of an ownership rule" that `mayReadOwned`'s own
    // header says `authz-single-home` fails the build over. It admitted nobody
    // in practice only because `sessionOwner` happens to return an empty list,
    // which is a convention in another function rather than a property here.
    // `mayReadPrivate` takes the edges as `legacyGrants`, whose type admits no
    // `UserId` to `includes`, so the bypass cannot be re-spelled by accident.
    return mayReadPrivate(reader.userId, {
      id: sessionId,
      owner: target.owner,
      legacyGrants: target.legacyGrants,
    })
  }

  /** One reader-scoped set computation. Principals are already admitted by the
   * transport; re-reading account status here would change the existing policy.
   * The memo belongs to this call (or its enclosing projection), never a user cache.
   */
  async visibleSessions(
    reader: SessionReader,
    candidates: readonly SessionId[],
    memo: SessionOwnerMemo = { issues: new Map(), grants: new Map() },
  ): Promise<ReadonlySet<SessionId>> {
    const visible = new Set<SessionId>()
    if (candidates.length === 0) return visible
    const ids = [...new Set(candidates)]
    await this.primeOwnerMemo(memo, ids)
    // THE SAME RULE AS `canReadSession`, over a batch rather than per id — the
    // two are copies, and PDM-291 changed both. Keep them in step. B2/PDM-251
    // moved the decision itself into the model on both sides, so what is
    // duplicated now is the LOOP, not the policy.
    // `undefined` IS the internal read, and it is not a missing user id: the
    // arm below admits on it, where an absent id would have to refuse.
    const internal = isInternalSessionRead(reader)
    for (const sessionId of ids) {
      const target = await this.ports.sessionOwner({ sessionId, memo })
      if (!target) continue
      const visibleToReader =
        internal ||
        mayReadPrivate(reader.userId, {
          id: sessionId,
          owner: target.owner,
          legacyGrants: target.legacyGrants,
        })
      if (visibleToReader) visible.add(sessionId)
    }
    return visible
  }

  private async cachedOverlay(userId: UserId): Promise<{
    readAt: Record<string, string | null>
    snoozes: Record<string, string | null>
  }> {
    let cached = this.overlays.get(userId)
    if (!cached) {
      cached = {
        readAt: await this.ports.store.sessions.listReadAt(userId),
        snoozes: await this.ports.store.sessions.listSnoozes(userId),
      }
      this.overlays.set(userId, cached)
    }
    return cached
  }

  /** Projection overlay for a caller already proven able to see the session. */
  async overlay(userId: UserId, sessionId: SessionId): Promise<SessionUserOverlay> {
    const cached = await this.cachedOverlay(userId)
    return {
      readAt: cached.readAt[sessionId] ?? null,
      snoozedUntil: sessionId in cached.snoozes ? cached.snoozes[sessionId] : undefined,
    }
  }

  /** Capture the reader cache once; the returned overlays have no service access. */
  async overlaySnapshot(userId: UserId, sessionIds: readonly SessionId[]): Promise<ReadonlyMap<SessionId, SessionUserOverlay>> {
    const cached = await this.cachedOverlay(userId)
    return new Map(sessionIds.map(id => [id, {
      readAt: cached.readAt[id] ?? null,
      snoozedUntil: id in cached.snoozes ? cached.snoozes[id] : undefined,
    }]))
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

  private invalidateOverlay(userId: UserId): void {
    this.overlays.delete(userId)
  }

  invalidateAllOverlays(): void {
    this.overlays.clear()
  }

  private async persistPerUser(userId: UserId, sessionId: SessionId, write: () => void | Promise<void>): Promise<boolean> {
    if (!this.ports.getSession(sessionId)) return false
    try {
      await this.ports.persistSession(sessionId, async () => {
        await write()
        this.invalidateOverlay(userId)
        // INSIDE THE TRANSACTION, AND THAT IS THE CORRECTION [PDM-424]. I first
        // published AFTER the persist, reasoning that the sidecar row must read
        // COMMITTED values rather than pre-write ones. Both halves of that were
        // wrong. The read sees this span's own uncommitted write — same
        // connection — so it is already correct here; and putting a second ledger
        // write outside the transaction meant a FAILED PUBLISH LEFT THE DURABLE
        // ROW COMMITTED while the caller saw a rejection. `sessions.ledger`'s
        // "rolls back live and SQLite snooze state when the durable append fails"
        // caught it: the store kept a snooze the caller was told had failed.
        //
        // Rolling back together is the point, not a hazard to avoid: the mark and
        // the row that announces it are one fact.
        await this.publishSessionMarks(userId, sessionId)
      })
    } finally {
      // The projection read inside persist may cache a value whose transaction
      // later rolls back. A second invalidation prevents serving that ghost row.
      this.invalidateOverlay(userId)
    }
    this.ports.broadcastSessions()
    return true
  }

  /**
   * ONE PERSON'S MARKS FOR ONE SESSION, onto the feed [PDM-424].
   *
   * The sidecar carries the REAL values to the one person they belong to, which
   * is the whole point of the split: the broadcast `session` row now carries
   * nobody's (see `SessionView.buildProjectionPass`). Delivery is decided
   * server-side in `feed-visibility.ts`'s `keyedUserOf`, from the row id.
   *
   * A ROW WITH EVERYTHING CLEARED IS STILL AN UPSERT carrying neutral values,
   * never a remove. The reader already holds the old row, and a remove is how a
   * client is told "this row is gone", not "you have not opened this" — marking
   * unread DELETES the durable row and must still reach the client as
   * `readAt: null`. {@link overlay} answers `NO_SESSION_USER_STATE` for an absent
   * row, so the deleted and the never-existed cases agree without a second
   * spelling.
   */
  private async publishSessionMarks(userId: UserId, sessionId: SessionId): Promise<void> {
    const ledger = this.ports.ledger
    if (!ledger) return
    const overlay = await this.overlay(userId, sessionId)
    const value: SessionMarksWire = {
      userId,
      sessionId,
      readAt: overlay.readAt,
      // Three-valued: an ABSENT key is "no snooze row", which is not the same as
      // `null` ("until the next message"). Spread rather than assigned so the
      // undefined case stays absent in the captured payload.
      ...(overlay.snoozedUntil !== undefined ? { snoozedUntil: overlay.snoozedUntil } : {}),
    }
    await ledger.capture([
      {
        entity: 'sessionMarks',
        id: sessionMarksRowId(userId, sessionId),
        op: 'upsert',
        value,
      },
    ])
  }

  /**
   * **EVERY EXISTING MARK, PUBLISHED ONCE AT BOOT** [PDM-424].
   *
   * {@link publishSessionMarks} is reached only from a WRITE. A row written
   * before this entity existed therefore has no change-log entry, and nothing
   * would ever serve it: on the first upgrade every member's existing unread
   * state and snoozes silently do nothing until they open that session AGAIN —
   * worst for exactly the people who have used the product longest, and
   * invisible, because a list with no marks and a list whose marks never arrived
   * look identical.
   *
   * A RECONCILE RATHER THAN A CAPTURE LOOP, because reconcile is the operation
   * that means "this is the whole truth for this kind": it diffs against what the
   * log already holds, so a boot after a boot writes nothing, and a row deleted
   * out from under the log is retracted rather than left. That is also why
   * {@link SessionsRepository.listAllSessionMarks} must return EVERY row for
   * EVERY person — a partial list would be diffed as a mass REMOVE and would
   * durably delete the marks of whoever was missing.
   */
  async reconcileSessionMarks(): Promise<void> {
    const ledger = this.ports.ledger
    if (!ledger) return
    const rows = await this.ports.store.sessions.listAllSessionMarks(this.ports.now())
    await ledger.reconcile(
      'sessionMarks',
      rows.map((row) => ({
        id: sessionMarksRowId(row.userId, row.sessionId),
        value: {
          userId: row.userId,
          sessionId: row.sessionId,
          readAt: row.readAt,
          ...(row.snoozedUntil !== undefined ? { snoozedUntil: row.snoozedUntil } : {}),
        } satisfies SessionMarksWire,
      })),
    )
  }

  /**
   * Publish one sidecar row per HOLDER after a write that crossed owners.
   *
   * {@link rearmUnreadForAll} and {@link clearAllSnoozes} are the two writes in
   * this family that legitimately touch everybody's rows, and each changes N
   * people's marks. N rows, each an audience of one — not one broadcast row,
   * which would have to say whose marks it meant and is the defect this issue
   * exists to remove. The holder list is read BEFORE the clear, because
   * afterwards there is nobody left to enumerate.
   */
  private async publishMarksForHolders(
    holders: readonly UserId[],
    sessionId: SessionId,
  ): Promise<void> {
    for (const holder of holders) await this.publishSessionMarks(holder, sessionId)
  }

  async markRead(principal: SessionStatePrincipal, sessionId: SessionId): Promise<boolean> {
    if (!(await this.canReadSession(principal, sessionId))) return false
    return this.persistPerUser(principal.userId, sessionId, async () =>
      await this.ports.store.sessions.markSessionRead(
        principal.userId,
        sessionId,
        new Date(this.ports.now()).toISOString(),
      ),
    )
  }

  async markUnread(principal: SessionStatePrincipal, sessionId: SessionId): Promise<boolean> {
    if (!(await this.canReadSession(principal, sessionId))) return false
    return this.persistPerUser(principal.userId, sessionId, async () =>
      await this.ports.store.sessions.markSessionUnread(principal.userId, sessionId),
    )
  }

  async rearmUnreadForAll(sessionId: SessionId): Promise<void> {
    // ONE TRANSACTION FOR THE CLEAR AND EVERY HOLDER'S ROW [PDM-424 review].
    // This used to clear directly and publish afterwards, so a capture failing on
    // the SECOND holder left the clear committed with the first holder's row
    // published and the rest not — and a retry would find the rows already gone
    // and skip the work. `store.transact` rather than `persistSession` because
    // this path has no session to persist and `persistSession` SILENTLY SKIPS a
    // session that is no longer live, which would turn a rollback-safety fix into
    // a behaviour change on the terminal-transition path.
    //
    // Holders BEFORE the clear: the delete is what removes them from the table.
    // A holder whose only row is a SNOOZE is republished here too, carrying the
    // value it already had. That is a deliberate no-op row rather than a bug: one
    // sidecar row carries both halves, so filtering to read-mark holders would
    // need a second statement of which table owns which key, and that is the
    // duplication this split exists to avoid.
    // `finally`, NOT a trailing statement [PDM-424 review 2]. The second
    // invalidation used to sit after the awaited `transact`, so a capture that
    // threw skipped it entirely — and the publish INSIDE the span has already
    // read each holder's overlay through {@link overlay}, which POPULATES the
    // cache. The rollback then discards the rows while the service keeps serving
    // the values it read from the doomed span. Same shape `persistPerUser`
    // already uses, and for the same reason.
    try {
      await this.ports.store.transact(async () => {
        const holders = await this.ports.store.sessions.listSessionMarkHolders(sessionId)
        await this.ports.store.sessions.clearAllReadAt(sessionId)
        this.invalidateAllOverlays()
        await this.publishMarksForHolders(holders, sessionId)
      })
    } finally {
      this.invalidateAllOverlays()
    }
  }

  async setSnooze(
    principal: SessionStatePrincipal,
    sessionId: SessionId,
    until: string | null,
  ): Promise<boolean> {
    if (!(await this.canReadSession(principal, sessionId))) return false
    return this.persistPerUser(principal.userId, sessionId, async () =>
      await this.ports.store.sessions.setSnooze(principal.userId, sessionId, until),
    )
  }

  async clearSnooze(principal: SessionStatePrincipal, sessionId: SessionId): Promise<boolean> {
    if (!(await this.canReadSession(principal, sessionId))) return false
    return this.persistPerUser(principal.userId, sessionId, async () =>
      await this.ports.store.sessions.clearSnooze(principal.userId, sessionId),
    )
  }

  /** Shared session activity invalidates every viewer's snooze independently. */
  async clearAllSnoozes(sessionId: SessionId): Promise<void> {
    if (!this.ports.getSession(sessionId)) return
    if (!await this.ports.store.sessions.hasAnySnooze(sessionId)) return
    // Holders BEFORE the clear, and the read-mark holders come with them: a
    // person whose snooze this clears may also hold a read mark, and one sidecar
    // row carries both halves, so republishing the union keeps every holder's row
    // consistent with the store rather than only the half that changed.
    // THE PUBLISH IS INSIDE THE PERSIST [PDM-424 review], for the same reason
    // `persistPerUser` moved: it used to await the clear and then publish
    // outside it, so an append failure left the snoozes cleared and committed
    // with the holder rows stale or half-published, and a retry would find
    // `hasAnySnooze` false and return early having done nothing.
    // `finally` for the reason {@link rearmUnreadForAll} states: a throw from a
    // capture inside the span skips a trailing statement, and the publish has
    // already populated the overlay cache from rows the rollback discards.
    try {
      await this.ports.persistSession(sessionId, async () => {
        const holders = await this.ports.store.sessions.listSessionMarkHolders(sessionId)
        await this.ports.store.sessions.clearAllSnoozes(sessionId)
        this.invalidateAllOverlays()
        await this.publishMarksForHolders(holders, sessionId)
      })
    } finally {
      this.invalidateAllOverlays()
    }
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
        return !this.ports.getSession(sessionId) || (await this.canReadSession(principal, sessionId))
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
        // NOT awaited: pushPriorities is a synchronous fan-out over clients,
        // and the release only re-arms a drain (rule 57 — same durable-row
        // contract as machine-reconciler's).
        void this.ports.onNativeViewReleased?.(sessionId)
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
  async setDraft(input: { sessionId: SessionId; text: string }, fromClientId?: string): Promise<void> {
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
  async replayDrafts(
    principal: SessionStatePrincipal,
    send: (message: LiveServerMessage) => void,
  ): Promise<void> {
    const visibleIds: SessionId[] = []
    for (const sessionId of this.draftDocs.keys()) {
      if (await this.canReadSession(principal, sessionId)) visibleIds.push(sessionId)
    }
    // No await may separate reading a document from sending it. Live edits can
    // replace draftDocs during authorization; replaying a captured older rev
    // afterward would overwrite the client's newer text (POD-3539).
    for (const sessionId of visibleIds) {
      const doc = this.draftDocs.get(sessionId)
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
    const operation = currentQueue.tail.catch(() => {}).then(async () => {
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
    const current = this.draftDocs.get(sessionId) ?? emptyDraftDoc(sessionId)
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
    if (!result.changed) return
    const doc = result.doc
    this.draftDocs.set(sessionId, doc)
    this.draftTimes.set(sessionId, doc.editedAt)
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
