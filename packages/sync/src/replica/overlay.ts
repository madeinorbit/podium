/**
 * The optimistic-overlay REDUCER SEAM — declared here, implemented elsewhere.
 *
 * POD-372 derives overlays from contract reducers and POD-351 ships the first
 * real contract + reducer. This file therefore defines the PORT and nothing else:
 * inventing a reducer vocabulary here would guarantee two competing ones later,
 * which is the specific failure POD-349 names (anything left undecided becomes N
 * divergent local decisions). The projection that CONSUMES this port is
 * `./overlay-projection`; it is a pure function and holds no state.
 *
 * Two properties the Replica relies on and neither invents:
 *
 * 1. **The overlay is DERIVED, never stored twice** (ADR 4 D7 — normalization law
 *    and derivation locality). It is a function of (authoritative base, pending
 *    commands). The Replica never persists an overlay row, which is also why a
 *    re-bootstrap cannot lose one: the outbox survives every rung (ADR 2 D7), so
 *    the overlay simply recomputes.
 * 2. **Retirement is EXACT, via envelope provenance** — a change is "my own write
 *    coming back" when its `causationId`/`mutationId` matches a pending command
 *    (ADR 2 D8), never when its value looks similar. Value comparison would be the
 *    replica arbitrating.
 */

import type { SyncSpan } from './ports'

/**
 * The attribution pair a queued command was authored under (readiness §3.1.3 A3;
 * ADR 3 amendment D17). The Outbox owns its shape and its source — both halves
 * come from the authenticated transport, never from a payload.
 *
 * It appears here for exactly ONE reason: readiness §3.1.3 A4 says entities an
 * agent creates are owned by its on-behalf-of human, with the agent as actor. A
 * provisional row materialised for a not-yet-applied create must therefore carry
 * that same pair, or the row flickers from "owned by the agent" to "owned by the
 * human" the moment the authoritative row lands.
 *
 * `actor` is `unknown` deliberately. The Outbox types it by KIND (user vs
 * agent-session) so nobody has to prefix-type an id; re-declaring that union here
 * would be a second definition of one identity vocabulary, and the direction lint
 * forbids importing the first. The Replica never inspects this value — it carries
 * it through untouched — so `unknown` is both honest and structurally enforcing.
 */
export interface PendingAttribution {
  /** The human the write is on behalf of. Becomes the provisional OWNER (A4). */
  readonly onBehalfOf: string
  /** Which agent or user issued it. Becomes the provisional ACTOR (A4). Opaque here. */
  readonly actor: unknown
}

/**
 * A queued client command, from the Replica's point of view. `command` is
 * deliberately `unknown`: the command contract is ADR 3's and POD-351's, and the
 * Replica must not be able to interpret it — interpreting it would be arbitration.
 */
export interface PendingMutation {
  readonly mutationId: string
  readonly entity: string
  readonly entityId: string
  readonly command: unknown
  /** Absent ⇒ no provisional attribution is rendered. Never synthesised. */
  readonly attribution?: PendingAttribution
}

/**
 * What a reducer says a pending command would do — a CLOSED set, because the
 * three answers are genuinely different and the difference is load-bearing.
 *
 * This shape exists instead of `unknown | undefined` because that spelling cannot
 * distinguish the two answers that matter most: "this command deletes the row"
 * and "I have no reducer for this command" both arrive as `undefined`, and they
 * must render differently (an optimistic removal versus pending-with-no-guess).
 * One ambiguous return would have made the reducer-less rule unimplementable
 * without the projection guessing — the exact thing the rule forbids.
 */
export type OptimisticEffect =
  /** The provisional value after this command. Materialises a row if there is none. */
  | { readonly kind: 'value'; readonly value: unknown }
  /** Optimistically absent — the command removes the row from the view. */
  | { readonly kind: 'absent' }
  /**
   * NO REDUCER for this command (ADR 4 / POD-311 has not populated one, or the
   * effect is not client-derivable). The projection renders the command as
   * PENDING and changes nothing. It must never fall back to a guess: a command
   * whose effect depends on server-side authorization has no client-derivable
   * effect at all, and inventing one is how an optimistic render becomes a lie.
   */
  | { readonly kind: 'no-reducer' }

/** One applied change's provenance, as the outbox needs to see it (ADR 2 D8). */
export interface RetirementIntent {
  readonly entity: string
  readonly entityId: string
  readonly causationId?: string
  readonly mutationId?: string
}

export interface OptimisticOverlayPort {
  /** Pending commands for this entity, in author order. Supplied by the outbox (POD-370). */
  pending(entity: string, entityId: string): readonly PendingMutation[]
  /**
   * The reducer seam (POD-372/POD-351). `base` is `undefined` when the principal's
   * slice holds no row — the only case in which a reducer may materialise one.
   *
   * The reducer is a PURE function of (base, command) and nothing else. It is
   * never handed a principal, a grant or a visibility class, so it cannot evaluate
   * authorization even by accident: optimism is about the EFFECT of a command the
   * authority has not yet applied, never about the RIGHT to issue it (ADR 1 D1,
   * widened by readiness §3.1).
   */
  reduce(base: unknown | undefined, command: unknown): OptimisticEffect
  /**
   * Called ONCE PER TRANSACTION with every provenance-bearing change that
   * transaction applied, in FEED ORDER, deduplicated. The Replica reports the
   * facts; it does not decide what the outbox should do with them.
   *
   * A batch rather than a call per change, because per-change calls are unsafe
   * inside a shared unit of work: two retirements in one span each stage from the
   * same pre-commit outbox snapshot, so the second resurrects the first
   * (POD-370's re-review). One frame routinely carries several provenance-bearing
   * changes, so the replica was handing the outbox exactly that sequence.
   *
   * With a `span` (ADR 2 D10 clause 1) the batch is STAGED and takes effect only
   * when that span commits, in the same publish as the entity operations and the
   * cursor that confirmed these commands. The Replica always passes one, because
   * its commit is by definition multi-region: no cursor may certify a change whose
   * retirement did not land, and no command may be retired against a frame that
   * did not commit.
   *
   * **The return type admits a PROMISE, and that is load-bearing** (POD-1158). A
   * durable outbox store is asynchronous — `OutboxStorePort.read`/`apply` return
   * promises because IndexedDB and SQLite do — while every `SyncSpan` hook is
   * synchronous by decision, because an IndexedDB transaction auto-closes on an
   * unrelated await. Those two compose only if the enrolment itself may be awaited
   * somewhere that is allowed to await: `SyncUnitOfWork.transact`'s BODY. So the
   * Replica awaits this call inside that body, and the hooks it registers stay
   * synchronous.
   *
   * Before this, `retire` returned `void` and the Replica committed its own span
   * synchronously, so an async participant could never enrol: the span had already
   * settled by the time `retireAllApplied` reached `span.join`. Measured against both
   * real kernels, the result was a cursor advanced past a frame whose confirmed
   * command was still durable and stuck in `applied` — the torn state D10 forbids, on
   * the normal path, with no crash involved.
   *
   * Only changes that were ACTUALLY APPLIED contribute. A frame that was dropped,
   * rejected at rung 3, or left buffered contributes nothing — retiring a command
   * whose effect never landed would tell the user their write was accepted when it
   * was not. A cache discard (rung 2-6, `rescope` included) contributes nothing
   * either, and must never reach this method at all.
   */
  retire(matches: readonly RetirementIntent[], span?: SyncSpan): void | PromiseLike<void>
}
