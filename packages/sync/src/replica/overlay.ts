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
 * THE PORT SHAPES AND THE DECISIONS BAKED INTO THEM ARE DOCUMENTED IN
 * `docs/command-and-reducer-ports.md` — the reference POD-372 and POD-311 build on,
 * including which refusals a reducer may PREDICT (arbitration off the authoritative
 * row) versus which it may never evaluate (authorization), and the per-user-state
 * template warning for Phase 3.
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
  /**
   * The command will NOT apply, and the reducer can say why (POD-351).
   *
   * ## Why this is a distinct member and not `no-reducer`
   *
   * `no-reducer` means "I cannot derive the effect"; this means "I have derived
   * that there is no effect". Both leave the value where it was, so a projection
   * that collapsed them would render identically — and the user would be told
   * "in flight" about a write that is already decided against. The difference is
   * the whole reject-and-rebase surface (POD-316), which readiness §3.3 moves
   * from a rare edge case to a ROUTINE path under multi-user. A routine path
   * needs a representable outcome, not an absence.
   *
   * ## Why a reducer may say this WITHOUT becoming an authorization surface
   *
   * The line is WRITER ARBITRATION versus VISIBILITY, and it is not a fine one:
   *
   *   - Permitted: a refusal derivable from the AUTHORITATIVE ROW the principal
   *     was already given, plus the command itself. `session.rename` is the
   *     motivating case — [spec:SP-eb60] makes a user-set `name` sovereign over
   *     an agent-set one, so `base.nameSource === 'user'` decides the outcome of
   *     an agent-authored rename with no principal, no grant and no capability
   *     consulted. The row said so; the reducer only read it.
   *   - FORBIDDEN: anything derived from who the principal IS or what it may
   *     see. That is `authorize()`'s job at the authority, live at every apply
   *     (ADR 3 D8). A reducer has no principal argument, so it cannot do this
   *     even by accident — which is the property, not the convention.
   *
   * The distinction matters because the two failure modes are opposite. A
   * mispredicted ARBITRATION is a cosmetic flicker the authority corrects on the
   * next frame. A mispredicted AUTHORIZATION would render content or an effect
   * the principal is not entitled to, which is exactly the "second, untrusted
   * authorization surface" ADR 2 Amendment 1 D12.7 exists to forbid.
   *
   * ## The prediction is ADVISORY and the authority still decides
   *
   * A reducer returning this has NOT rejected anything — it has predicted that
   * the authority will. The command stays queued, still drains, and is still
   * judged live at apply. Anything else would be the replica arbitrating: a
   * client that dropped the write on its own prediction would lose a write that
   * a concurrent `name = ''` (which clears `nameSource`, see the service) would
   * have made perfectly applicable by the time it landed.
   */
  | { readonly kind: 'rejected'; readonly reason: string }

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
   * The reducer is a PURE function of (base, command, authored) and nothing else.
   * It is never handed a principal, a grant or a visibility class, so it cannot
   * evaluate authorization even by accident: optimism is about the EFFECT of a
   * command the authority has not yet applied, never about the RIGHT to issue it
   * (ADR 1 D1, widened by readiness §3.1).
   *
   * `authored` is the entry's recorded {@link PendingAttribution}, forwarded
   * VERBATIM (POD-351). Three things about it are deliberate:
   *
   *  1. **The Replica does not read it.** It carries the value from the outbox to
   *     the reducer the same way it already carries it to `provisionalOwner` —
   *     untouched, and typed with `actor: unknown` so there is nothing here to
   *     branch on. The direction lint would catch an inspection; the type makes
   *     one uninteresting to attempt.
   *  2. **It is what makes the rejection path REACHABLE.** `session.rename`'s
   *     arbitration ([spec:SP-eb60]) turns on whether an AGENT or a HUMAN authored
   *     the write. Without the authored pair a reducer cannot tell those apart, and
   *     `rejected` would be a member with no possible caller — mechanism presence
   *     rather than coverage. The reducer reads the actor's KIND, never its id.
   *  3. **It is not a principal, and must not grow into one.** It is the pair the
   *     write was AUTHORED under, already stamped from the authenticated transport
   *     by the Outbox (ADR 3 D7/D17). A reducer learns "an agent wrote this", never
   *     "this agent may write this" — the second question has no argument to ask
   *     it with, here or anywhere in this file.
   *
   * Optional because a reducer that ignores attribution is the common case and
   * must not be forced to declare a parameter it does not read.
   */
  reduce(
    base: unknown | undefined,
    command: unknown,
    authored?: PendingAttribution,
  ): OptimisticEffect
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
