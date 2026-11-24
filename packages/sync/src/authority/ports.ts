/**
 * THE AUTHORITY ROLE'S PORTS — infrastructure-neutral, by construction.
 *
 * Not one line of this file, or of the module that implements it, knows what a
 * database is. That is POD-305's acceptance criterion "the kernel has zero
 * SQLite/Bun/DOM imports", and `scripts/check-boundaries.ts` rule 11 enforces it
 * over the whole of `packages/sync/src` outside `adapters/` — a lint rather than a
 * convention, because the import that breaks it will be added by someone who
 * never read this comment.
 *
 * The layering the ADR asks for, stated once:
 *
 *   KERNEL   (here)                 ports + state machines. Infrastructure-neutral.
 *   ADAPTER  (`../adapters/sqlite`) the generic sync tables, as drizzle
 *                                   schema-as-code feeding the ONE journal.
 *   FEATURE  (its own store)        feature-owned tables — the session inbox and
 *                                   queued sends stay where their feature is.
 *
 * Persistence ownership is LAYERED, not monolithic (POD-279 review finding 5):
 * the kernel does not own the tables, and the adapter does not own the semantics.
 */

import type { ChangeProvenanceFields } from '@podium/model'
import type { MetadataEntityKind, Principal } from '@podium/protocol'
import type { FeedScopingGrade } from '../feed/visibility'
import type { BuiltRecord, RecordIdsByKind, RecordPage } from '../record-builders'
import type { ArbitrationAttempt, ArbitrationRejection, ArbitrationRequest } from './arbitration'
import type {
  ChangeLogReadRow,
  ChangeLogWriteRow,
  SequencedChange,
  StoredChangeRow,
} from './change-lifecycle'
import type { ScopedBootstrap, ScopedDelivery } from './scoping'

/**
 * The durable change log, as the Authority needs it.
 *
 * A NARROW port and not the whole repository: the Authority writes changes and
 * reads ranges, and nothing here can enqueue a message or touch an outbox. A
 * wide port is how a role acquires a capability nobody decided to give it.
 */
export interface ChangeStorePort {
  /**
   * Append pre-deduped rows atomically; returns their contiguous assigned seqs.
   *
   * Takes the full {@link StoredChangeRow} (clock included). The concrete
   * {@link ChangeLogStore} still accepts the batch clock as a second argument
   * because every row in one Authority append shares one eventTime — that is an
   * adapter convenience, not a second row shape.
   */
  appendChanges(rows: readonly StoredChangeRow[]): Promise<number[]>
  /** Highest seq ever assigned — survives head-pruning. 0 before any change. */
  maxChangeSeq(): Promise<number>
  /** Lowest RETAINED seq, or null when the log is empty. Not ADR 2 D5's
   *  `minAvailableSeq` by itself: an empty log has pruned everything before the
   *  head, so the floor is `minChangeSeq() ?? maxChangeSeq() + 1` (POD-7593). */
  minChangeSeq(): Promise<number | null>
  /** Plain range read: rows with seq > cursor, in seq order. The CALLER decides
   *  whether the cursor is still inside the retained range. */
  changesSince(cursor: number): Promise<readonly SequencedChange[]>
}

/** Re-export so adapters and tests name the composed write/read forms once. */
export type { ChangeLogReadRow, ChangeLogWriteRow }

/**
 * Runs `fn` atomically with any AMBIENT entity write (ADR 2 D10).
 *
 * INJECTED, and this is the seam that makes the kernel infrastructure-neutral:
 * the Authority never imports a transaction helper, so composition wires it to
 * whatever the deployment's storage offers, and a unit test wires a pass-through
 * `(fn) => fn()`. What the kernel guarantees is the ORDERING and the shape; what
 * the adapter guarantees is that the span is real.
 */
export type TransactPort = <T>(fn: () => Promise<T>) => Promise<T>

/**
 * Runs an AWAITED FOLLOW-UP once the outermost unit of work has committed
 * (spec §3.3 mechanism 2, POD-3260) — injected for the same reason
 * {@link TransactPort} is: the kernel states the ordering, the adapter owns the
 * span it is ordered against.
 *
 * Visibility preparation may yield, so the transaction's ordered follow-up
 * drain awaits the step under the writer lease until the synchronous subscriber
 * pass has consumed the resolved snapshot.
 */
export type PostCommitFollowUpPort = (step: () => Promise<void>, label: string) => void

/**
 * WHICH COMMAND IS APPENDING NOW (ADR 2 D8, ADR 12; POD-6272).
 *
 * The write entry point opens a provenance scope around each command's handler
 * (in the caller's async context, so two calls in one HTTP batch cannot see each
 * other's). The Authority reads it once per commit, at the call, and stamps every
 * row it appends with the answer.
 *
 * A spec that names any provenance field of its own keeps its own group whole;
 * the ambient answer fills only rows that named none. `undefined` (no scope
 * open) stamps nothing, and a field reported as `undefined` is not written, so
 * an absent field stays an absent key all the way to the reader.
 *
 * Provenance never feeds dedup: a no-op write under a new mutation id still
 * appends nothing (the reply's receipt confirms those writes, ADR 12).
 */
export interface ProvenancePort {
  /** The provenance of the command now appending, read once per commit in the caller's async context. */
  current(): ChangeProvenanceFields | undefined
}

/**
 * RECORDS AS THE DATABASE HOLDS THEM NOW, AND WHICH ONES A WRITE CHANGED
 * (POD-6253 design §3, POD-6920).
 *
 * Writers name no records. The database layer captures which model rows each
 * write transaction changed (generated triggers over every table a kind
 * reads), and {@link drainCapture} turns the rows captured so far in the
 * caller's transaction into the ids of the records they can have changed. A
 * transaction that changed a model row and was not drained before it commits
 * is refused by the database, so no write reaches the tables without its log
 * entry.
 *
 * `build` runs inside the commit's span, so it sees the span's own writes, and
 * answers exactly the asked ids that have a record, once each.
 */
export interface RecordSourcePort {
  /**
   * Take every change captured so far in the caller's transaction, and answer
   * the records those changes can have changed, by kind, each id once, in the
   * order first captured. An id may name a record the write removed or never
   * had: the caller builds it to find out.
   */
  drainCapture(after?: number): Promise<RecordIdsByKind>
  /**
   * Where a commit starts in the capture, taken before its span opens: 0 when
   * no transaction is open (the capture is empty), else the newest captured
   * row so far. The commit drains only what was captured after it, so a commit
   * nested in another write's transaction takes its own write's changes and
   * leaves the enclosing write's to the enclosing commit. Absent: 0.
   */
  captureMark?(): Promise<number>
  /**
   * Runs a commit's body (the write, the drain, the append) inside its span,
   * so the source can tell a write inside a commit from one outside any: a
   * repository hook that commits its own writes joins an open commit instead
   * (POD-6920). Absent: the body runs as is.
   */
  inCommit?<T>(body: () => Promise<T>): Promise<T>
  build(kind: MetadataEntityKind, ids: readonly string[]): Promise<readonly BuiltRecord[]>
  /** Build several kinds at once, sharing reads across kinds. */
  buildMany(idsByKind: RecordIdsByKind): AsyncIterable<RecordPage>
  /** Every kind this source builds, in the order a start-up load streams them (POD-6770). */
  kinds(): readonly MetadataEntityKind[]
  /** Every record of a kind as the database holds it now, a page at a time. */
  streamAll(kind: MetadataEntityKind): AsyncIterable<readonly BuiltRecord[]>
  /** Every record in the start-up load, a page of one kind at a time. */
  streamAllKinds(): AsyncIterable<RecordPage>
}

/**
 * The seam the BASELINE FOLD hangs off [POD-3328, spec §3.3 mechanism 1].
 *
 * Separate from {@link PostCommitFollowUpPort} because the two are different
 * mechanisms with different timing contracts: the broadcast is an awaited
 * post-commit follow-up, while the fold is a commit application — not skippable,
 * and a failure means the in-memory projection no longer matches the database.
 *
 * `spanOpen` is asked BEFORE anything is staged, because the honest answer
 * differs: with no enclosing unit of work a commit IS the outermost commit and
 * the fold applies at once, which is where it happens today. Inside one, the
 * commit is a savepoint release, the rows are not durable yet, and the fold
 * waits for `onCommit`.
 */
/**
 * THE LIVENESS OF ONE REGISTRATION — what `spanOpen()` alone cannot answer
 * [POD-3364].
 *
 * `spanOpen()` answers "is ANY write span open", which is top-level
 * granularity. A MIDDLE span that rolls back inside a committing outer one
 * never makes it answer false, so what that span staged used to survive in the
 * pending layer and shadow every read for the rest of the outer span.
 *
 * This is the same fact at FRAME granularity, and it is a PULL, not a report: a
 * registration is dead because the unit of work that made it discarded its
 * registry, and the reader finds that out by asking. Nothing has to REMEMBER to
 * announce a rollback, which is the asymmetry POD-3328 established and this
 * keeps — the handle is killed by the same `discard()` that already throws the
 * step away, on the unwind path that cannot be skipped.
 *
 * WHY NOT FRAME IDENTITY, which is the obvious shape: a savepoint that RELEASES
 * closes its frame exactly as one that rolls back does, and its staged work is
 * still legitimately pending in the parent's registry. "Which frame staged
 * this" cannot separate those two; "is my registration still going to run" can,
 * because release MOVES it and rollback DROPS it.
 */
export interface CommitRegistration {
  /**
   * Will this step still run? False once the unit of work that registered it
   * rolled back — including a nested one whose enclosing span carries on.
   */
  live(): boolean
}

export interface BaselineFoldPort {
  /** Is an enclosing unit of work open whose commit the fold must wait for? */
  spanOpen(): boolean
  /**
   * Register a commit application to run after the OUTERMOST commit, and hand
   * back {@link CommitRegistration} so a staged value can ask whether the unit
   * of work that staged it is still going to commit.
   */
  onCommit(step: () => void, label: string): CommitRegistration
}

/**
 * The Authority's clock — epoch milliseconds, injected.
 *
 * This is the clock ADR 1 D3 names as the ONLY one `field-LWW` may arbitrate on
 * ("the Authority-assigned event time at commit"). Injecting it is what lets a
 * test drive a stale-write case deterministically instead of sleeping, and there
 * is deliberately no second clock parameter anywhere in this role: a client wall
 * clock may be attribution metadata and may never arbitrate.
 */
export type AuthorityClock = () => number

/**
 * POD-7552 — where each human's LAST ACCESS MOVE is kept: the feed number of
 * the latest change whose visibility edge named them in its audience. The
 * Authority writes it from the batch evaluation every principal's delivery
 * shares, so a human with no device connected is recorded too. It outlives
 * the change-log rows that show the move, which is what lets a resume the log
 * can no longer bridge still be answered as a rescope.
 */
export interface AccessMoveLogPort {
  /**
   * Raise each human's last move to the seq given; never lower it. With
   * `through`, the same statement raises the recorded-through mark
   * (POD-7585): every change at or below it has had its moves recorded.
   */
  recordAccessMoves(moves: ReadonlyMap<string, number>, through?: number): Promise<void>
  /**
   * POD-7585 — the durable recorded-through mark: where a process that starts,
   * or takes over the workspace's writes, replays the log from. Before any
   * pass raised it, where recording started (0 when it started with the feed).
   */
  readRecordedThrough(): Promise<number>
  /**
   * POD-7585 — the changes up to `seq` can no longer be replayed (pruned, or
   * past the replay bound): raise where recording started to `seq`, so a cursor
   * below it is answered as "cannot tell", and the recorded-through mark with it.
   */
  raiseRecordingStart(seq: number): Promise<void>
  /**
   * Whether a visibility edge on a change of this kind moves anyone's access.
   * An edge can stand for a re-delivery that decides nothing (the server's
   * issue edges, since POD-6288); such a kind is not recorded. Absent, every
   * edge is a move.
   */
  movesAccess?(entity: string): boolean
}

/**
 * Fires after every durable append, for ONE principal, with the range that was
 * evaluated (POD-1077).
 *
 * NOT `(changes) => void`. The parameter is a {@link ScopedDelivery}, which
 * carries `throughSeq` beside `changes`, because Amendment 1 D13 requires the
 * filter and the watermark to land together: a subscriber handed only a filtered
 * list has no way to distinguish "nothing happened" from "everything in that
 * range was suppressed for you", and the second one advances a cursor while the
 * first must not. Making the range part of the delivery type is what stops that
 * from being a rule somebody remembers.
 */
export type ChangeSubscriber = (delivery: ScopedDelivery) => void

/**
 * THE AUTHORITY ROLE (ADR 1 D1, ADR 2 D10).
 *
 * The one role that arbitrates. POD-306 builds the Replica and Outbox against the
 * other side of this seam, and the asymmetry between the two is the point of the
 * phase: everything here decides, and nothing there does.
 */
export interface AuthorityPort {
  /**
   * THE WRITE FUNNEL: authorize → arbitrate → write → change-append → broadcast,
   * in that order and nowhere else. See `authority.ts` for why the order is not
   * negotiable at any step.
   */
  commit<T>(op: AuthorityCommit<T>): Promise<AuthorityCommitOutcome<T>>

  /**
   * Resolves once every delivery pass queued so far has run. Optional: a port
   * with no queue has nothing to wait for.
   */
  settled?(): Promise<void>

  /**
   * POD-7585 — the seq through which every change's access moves are recorded,
   * as far as this process knows: the passes it ran, and the log it replayed
   * at start or takeover. `null` while it cannot tell (the replay has not
   * finished, or nothing records). A refusal whose head is above it cannot be
   * answered from the access-move log yet. Absent: the port records nothing.
   */
  accessMovesRecordedThrough?(): number | null

  /**
   * POD-7585 — {@link accessMovesRecordedThrough}, once it has reached `seq`
   * or `withinMs` have passed, whichever is first. It waits on the mark itself,
   * not on every queued pass. A serving edge that records access moves
   * answers "moved" when its port lacks this.
   */
  whenAccessMovesRecordedThrough?(seq: number, withinMs: number): Promise<number | null>

  /**
   * Catch-up read, FOR ONE PRINCIPAL. `null` means "I cannot serve you a delta —
   * re-bootstrap" (bootstrap / compacted-past-cursor / future cursor / corrupt
   * row).
   *
   * The principal is REQUIRED and there is no unscoped overload, which is the
   * read-side half of D12.7 ("the replica never receives a row it may not see").
   * An optional parameter would make the unscoped read the default, and the
   * default is the one every new call site takes.
   */
  changesSince(cursor: number | null, principal: Principal): Promise<ScopedDelivery | null>

  /** Fix the inclusive target before opening a range read. */
  captureHead(): Promise<number>
  /** Bounded scoped pages; typed bootstrap failure or terminal rescope ends the range. */
  changesRange(
    principal: Principal,
    from: number,
    through: number,
    pageRows: number,
  ): AsyncIterable<ScopedDelivery & { readonly fromSeq: number }>

  /** The highest seq ever assigned. 0 before any change. */
  cursor(): Promise<number>

  /**
   * What kind of answer this Authority's visibility policy gives (POD-376).
   *
   * READ OFF THE INSTALLED POLICY OBJECT, never off a deployment config. A
   * serving edge uses it to refuse a wire version that cannot express `evict`
   * while this Authority can actually revoke — and a config that could disagree
   * with the object would make that refusal wrong in the one direction that
   * matters, silently.
   */
  visibilityGrade(): FeedScopingGrade

  /**
   * The INSTALLED WORLD for one principal, at the current head (POD-1203).
   *
   * On the port because bootstrap is a feed operation: a serving edge must be
   * able to ask the same role for "what is there" and "what changed" and get
   * answers that cannot disagree. A composition that read the world from
   * somewhere else would be the second read path the cutover deleted.
   */
  bootstrap(principal: Principal): Promise<ScopedBootstrap>

  /**
   * Subscribe to the ORDERED delta pipe, AS ONE PRINCIPAL. Returns an
   * unsubscribe.
   *
   * ONE pipe, in append order, always — see `authority.ts` on why a reentrant
   * subscriber makes this a correctness property rather than a convenience. The
   * pipe stays single-emitter under scoping: one global batch is evaluated once
   * per subscribed principal, in the same drain, so N principals cannot observe
   * two different orders of the same log.
   *
   * The principal comes FIRST because it is what the delivery is scoped to, and
   * it is required for the same reason `changesSince`'s is: an unscoped
   * subscription would be the read-side leak in a system whose feed is otherwise
   * per-principal.
   */
  subscribe(principal: Principal, subscriber: ChangeSubscriber): () => void
}

/** One write, as the funnel takes it. */
export interface AuthorityCommit<T> {
  /**
   * AUTHORIZATION — runs FIRST, and a throw stops everything.
   *
   * Resolved live over the delegation chain by the caller (ADR 3 D8/D16); the
   * Authority does not resolve principals, it enforces that the question was
   * asked before anything was written. A forbidden op must never write, and the
   * only way to guarantee that is for the write to be unreachable past a throw.
   */
  authorize?: () => Promise<void>
  /**
   * ARBITRATION — which write wins, per the row's declared conflict rule. Absent
   * means the caller declares this write has no concurrent-write question (a
   * `live-ephemeral` fold, a system reconcile); present means the matrix decides.
   */
  arbitrate?: Omit<ArbitrationRequest, 'attempt' | 'current'> & {
    /**
     * `eventTime` is absent HERE and supplied by the Authority at commit. That
     * omission is ADR 1 D3 condition 1 held as a type: the only clock a
     * `field-LWW` row may arbitrate on is the Authority's own, so there is
     * nowhere for a caller to put a client wall clock even if it wanted to.
     */
    readonly attempt: Omit<ArbitrationAttempt, 'eventTime'>
    /** Read CURRENT state inside the transaction that performs the write. */
    readonly current?: () => Promise<ArbitrationRequest['current']>
  }
  /**
   * The entity write, awaited inside the same transaction as the change
   * append. The Authority drains the capture right after it and appends one
   * row for every record the captured changes reach: an upsert of the record
   * as it is now, or a remove when it is gone (POD-6920).
   */
  write: () => Promise<T>
}

export type AuthorityCommitOutcome<T> =
  | {
      readonly outcome: 'committed'
      readonly result: T
      /** The appended rows. Empty when the write changed no column a record reads. */
      readonly changes: readonly SequencedChange[]
    }
  /** Arbitration refused. Nothing was written — the entity write never ran. */
  | {
      readonly outcome: 'rejected'
      readonly reason: ArbitrationRejection
      readonly detail?: string
    }
