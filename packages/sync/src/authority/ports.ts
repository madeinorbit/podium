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

import type { MetadataEntityKind } from '@podium/protocol'
import { type Principal } from '@podium/protocol'
import type {
  ArbitrationAttempt,
  ArbitrationRejection,
  ArbitrationRequest,
} from './arbitration'
import type { FeedScopingGrade } from '../feed/visibility'
import type {
  ChangeLogReadRow,
  ChangeLogWriteRow,
  SequencedChange,
  StagedChangeSpec,
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
  appendChanges(rows: readonly StoredChangeRow[]): number[]
  /** Highest seq ever assigned — survives head-pruning. 0 before any change. */
  maxChangeSeq(): number
  /** Lowest RETAINED seq, or null when the log is empty (ADR 2 D5's
   *  `minAvailableSeq`: below it a heal is refused and the ladder goes to rung 2). */
  minChangeSeq(): number | null
  /** Plain range read: rows with seq > cursor, in seq order. The CALLER decides
   *  whether the cursor is still inside the retained range. */
  changesSince(cursor: number): readonly SequencedChange[]
  /**
   * Latest retained row per (entity, id) — the boot seed for the dedup baseline,
   * and the ONLY honest source for a bootstrap ({@link AuthorityPort.bootstrap}).
   *
   * `seq` is that row's position in the one global sequence, and it is here
   * because a bootstrap is a set of feed rows and a feed row has a position.
   * Reading the current state out of `changesSince(0)` instead would look
   * equivalent and would be wrong the moment anything is pruned: head-pruning
   * drops old rows, so an entity whose last change fell below the retention floor
   * would simply be MISSING from the installed world — silently, and only on
   * long-lived servers. This read is defined per (entity, id) over the whole
   * table precisely so it survives that.
   *
   * Shape is {@link ChangeLogReadRow} — the composed store-read form, not a
   * hand-restated field list.
   */
  latestChangeStates(): readonly ChangeLogReadRow[]
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
export type TransactPort = <T>(fn: () => T) => T

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
  commit<T>(op: AuthorityCommit<T>): AuthorityCommitOutcome<T>

  /**
   * An explicitly owned mutation with no durable entity-row write to bind to
   * (volatile session view state, an upstream mirror). The caller supplies the
   * exact upserts and removes; this never diffs a list.
   */
  capture(specs: readonly StagedChangeSpec[]): readonly SequencedChange[]

  /**
   * BOOT-ONLY reconciliation: `rows` is the FULL truth for one entity kind.
   * The only surviving full-list diff path, INCLUDING removes, so anything that
   * changed or vanished while the Authority was down lands in the log before the
   * first reader sees it.
   */
  reconcile(
    entity: MetadataEntityKind,
    rows: readonly { readonly id: string; readonly value: unknown }[],
  ): readonly SequencedChange[]

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
  changesSince(cursor: number | null, principal: Principal): ScopedDelivery | null

  /** The highest seq ever assigned. 0 before any change. */
  cursor(): number

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
  bootstrap(principal: Principal): ScopedBootstrap

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
  authorize?: () => void
  /**
   * ARBITRATION — which write wins, per the row's declared conflict rule. Absent
   * means the caller declares this write has no concurrent-write question (a
   * `live-ephemeral` fold, a system reconcile); present means the matrix decides.
   */
  arbitrate?: Omit<ArbitrationRequest, 'attempt'> & {
    /**
     * `eventTime` is absent HERE and supplied by the Authority at commit. That
     * omission is ADR 1 D3 condition 1 held as a type: the only clock a
     * `field-LWW` row may arbitrate on is the Authority's own, so there is
     * nowhere for a caller to put a client wall clock even if it wanted to.
     */
    readonly attempt: Omit<ArbitrationAttempt, 'eventTime'>
  }
  /**
   * The entity write. MUST be synchronous — an async write would commit its
   * change row now and its entity row later, OUTSIDE the transaction, which is
   * the torn state the span exists to prevent.
   */
  write: () => T
  /** What the write touched, declared by the writer. Never diffed from a list. */
  changes: (result: T) => readonly StagedChangeSpec[]
}

export type AuthorityCommitOutcome<T> =
  | {
      readonly outcome: 'committed'
      readonly result: T
      /** The appended rows. EMPTY when every declared change deduped away. */
      readonly changes: readonly SequencedChange[]
    }
  /** Arbitration refused. Nothing was written — the entity write never ran. */
  | {
      readonly outcome: 'rejected'
      readonly reason: ArbitrationRejection
      readonly detail?: string
    }
