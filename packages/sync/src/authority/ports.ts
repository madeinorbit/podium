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
import type {
  ArbitrationAttempt,
  ArbitrationRejection,
  ArbitrationRequest,
} from './arbitration'
import type { StagedChangeSpec, SequencedChange, StoredChangeRow } from './change-lifecycle'

/**
 * The durable change log, as the Authority needs it.
 *
 * A NARROW port and not the whole repository: the Authority writes changes and
 * reads ranges, and nothing here can enqueue a message or touch an outbox. A
 * wide port is how a role acquires a capability nobody decided to give it.
 */
export interface ChangeStorePort {
  /** Append pre-deduped rows atomically; returns their contiguous assigned seqs. */
  appendChanges(rows: readonly StoredChangeRow[]): number[]
  /** Highest seq ever assigned — survives head-pruning. 0 before any change. */
  maxChangeSeq(): number
  /** Lowest RETAINED seq, or null when the log is empty (ADR 2 D5's
   *  `minAvailableSeq`: below it a heal is refused and the ladder goes to rung 2). */
  minChangeSeq(): number | null
  /** Plain range read: rows with seq > cursor, in seq order. The CALLER decides
   *  whether the cursor is still inside the retained range. */
  changesSince(cursor: number): readonly SequencedChange[]
  /** Latest retained row per (entity, id) — the boot seed for the dedup baseline. */
  latestChangeStates(): readonly Omit<StoredChangeRow, 'eventTime'>[]
}

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

/** Fires after every durable append, never with an empty batch. */
export type ChangeSubscriber = (changes: readonly SequencedChange[]) => void

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

  /** Catch-up read. `null` means "I cannot serve you a delta — re-bootstrap"
   *  (bootstrap / compacted-past-cursor / future cursor / corrupt row). */
  changesSince(cursor: number | null): readonly SequencedChange[] | null

  /** The highest seq ever assigned. 0 before any change. */
  cursor(): number

  /**
   * Subscribe to the ORDERED delta pipe. Returns an unsubscribe.
   *
   * ONE pipe, in append order, always — see `authority.ts` on why a reentrant
   * subscriber makes this a correctness property rather than a convenience.
   */
  subscribe(subscriber: ChangeSubscriber): () => void
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
