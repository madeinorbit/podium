/**
 * THE OVERLAY, as a pure function: `overlay = f(replica row, pending commands)`.
 *
 * POD-372. It consumes the reducer port `./overlay` declares (POD-351 ships the
 * first real reducer through it, POD-311 populates the rest) and it derives
 * nothing else. There is no class here, no store handle and no `this`: the
 * overlay is DERIVED and never persisted (ADR 4 D7 — normalization law and
 * derivation locality), so a re-bootstrap cannot lose one and a repeated call
 * cannot drift from the last.
 *
 * ── The three rules this file exists to hold ──────────────────────────────────
 *
 * 1. **It never arbitrates and never evaluates visibility.** The rows it is given
 *    are the PRINCIPAL'S SLICE (POD-1077 authority side, POD-369 replica side),
 *    not the world. Nothing here takes a principal, a grant or a visibility class,
 *    so "may this principal see X" is not a question this code can be asked —
 *    which is the property `check-boundaries` rule 9(b) lints for (ADR 1 D1,
 *    ADR 2 Amendment 1 D12.7).
 *
 * 2. **A pending write never makes an entity visible.** A reducer may materialise
 *    a row ONLY where the slice holds none AND nothing has left the view. The
 *    moment an entity is `evict`ed — a revoked share, readiness §3.1 — the
 *    overlay over it DROPS WITH THE ROW. This is the one place where an
 *    "optimistic" render could re-expose revoked content, and it is closed
 *    structurally: the exit branch returns before any reducer is called, so there
 *    is no reducer output to leak.
 *
 * 3. **A command with no reducer renders as pending and changes nothing.** No
 *    fallback, no merge, no guess. A command whose effect depends on server-side
 *    authorization has no client-derivable effect, and `unapplied` is how the UI
 *    says "in flight" without claiming to know the outcome.
 *
 * ── What is deliberately NOT in `OverlayRow` ─────────────────────────────────
 *
 * There is no `visibility` field, and there is no `grants` field. Not empty, not
 * defaulted — absent. Under private-by-default an unclassified class is
 * personal/private (readiness §3.1.1), so a type that could express
 * "optimistically tenant-visible" would be one refactor away from rendering it.
 * The provisional OWNER that is here is not an exception: it is copied from the
 * command's recorded attribution, never chosen (see `provisionalOwner`).
 */

import type { OptimisticEffect, PendingMutation } from './overlay'
import type { EntityRecord, ExitKind } from './types'

/** Everything the projection is allowed to see. Note what is not here: no principal. */
export interface OverlayInputs {
  /** The authoritative row from the principal's slice, or `undefined` if it holds none. */
  readonly base: EntityRecord | undefined
  /**
   * How this entity left the view, if it did (ADR 2 Amendment 1 D14.5).
   * `evicted` is a revoked share; `removed` is a tombstone. Both drop the overlay.
   */
  readonly exit: ExitKind | undefined
  /** Pending commands for this entity, in AUTHOR ORDER. Supplied by the outbox (POD-370). */
  readonly pending: readonly PendingMutation[]
  /** The reducer port (`OptimisticOverlayPort.reduce`), passed as a function. */
  readonly reduce: (base: unknown | undefined, command: unknown) => OptimisticEffect
}

/** Where the rendered value came from. `none` ⇒ there is nothing to render. */
export type OverlayOrigin = 'none' | 'authority' | 'optimistic'

export interface OverlayRow {
  /** False ⇒ render nothing. Never "render the base anyway". */
  readonly present: boolean
  /** The value to render. `undefined` iff `present` is false. */
  readonly value: unknown
  readonly origin: OverlayOrigin
  /**
   * Every pending command over this entity, in author order — reduced or not,
   * dropped-with-the-row or not. This is the honest "you have unsent work here"
   * signal, and it must not shrink just because the effect could not be derived.
   */
  readonly pending: readonly string[]
  /**
   * The subset of `pending` whose effect is NOT reflected in `value`: commands
   * with no reducer, and every command over an entity that has left the view.
   * `pending` minus `unapplied` is exactly what the render is claiming.
   */
  readonly unapplied: readonly string[]
  /**
   * Provisional owner for a row that only the overlay materialises — readiness
   * §3.1.3 A4: entities an agent creates are owned by its ON-BEHALF-OF HUMAN,
   * with the agent as actor. Copied verbatim from the command's recorded
   * attribution so the optimistic row does not flicker between owners when the
   * authoritative row lands.
   *
   * Absent when the authority already owns the row (its owner is authoritative,
   * and echoing it here would be a second home for one fact) and absent when the
   * command carried no attribution. Reflecting the rule is permitted; INVENTING
   * an owner, a grant or a visibility class is not, which is why this is a copy
   * and there is no code path that computes it.
   */
  readonly provisionalOwner?: string
  /** The actor half of the same pair. Opaque; carried through, never inspected. */
  readonly provisionalActor?: unknown
}

/** Nothing to render, with every pending command reported as unapplied. */
const dropped = (pending: readonly string[]): OverlayRow => ({
  present: false,
  value: undefined,
  origin: 'none',
  pending,
  unapplied: pending,
})

/**
 * Fold the pending commands over the authoritative base, in author order.
 *
 * Pure and total: same inputs, same output, no throw. A reducer that throws is a
 * bug in the reducer and is not caught here — swallowing it would render a
 * silently stale value that looks authoritative.
 */
export const computeOverlay = (inputs: OverlayInputs): OverlayRow => {
  const ids = inputs.pending.map((p) => p.mutationId)

  // Rule 2, first and unconditionally. An entity that left the view takes its
  // overlay with it, and no reducer runs at all: a `remove` is a tombstone and a
  // pending edit must not un-delete it, while an `evict` is a REVOCATION and a
  // pending edit that resurrected the row would re-expose content the principal
  // may no longer see. Returning before the fold is what makes that structural
  // rather than a condition somebody could later reorder.
  if (inputs.exit !== undefined) return dropped(ids)

  let value: unknown = inputs.base?.value
  let present = inputs.base !== undefined
  let origin: OverlayOrigin = present ? 'authority' : 'none'
  let materialisedBy: PendingMutation | undefined
  const unapplied: string[] = []

  for (const mutation of inputs.pending) {
    // `undefined` when there is no row, so a reducer can tell "create" from
    // "update" without being told anything about the slice.
    const effect = inputs.reduce(present ? value : undefined, mutation.command)

    if (effect.kind === 'no-reducer') {
      // Rule 3. The command stays visible as pending; the value does not move.
      unapplied.push(mutation.mutationId)
      continue
    }

    if (effect.kind === 'absent') {
      value = undefined
      present = false
      origin = 'optimistic'
      // A later command may materialise the row again; whoever does that owns the
      // provisional attribution, so this one no longer does.
      materialisedBy = undefined
      continue
    }

    if (!present) materialisedBy = mutation
    value = effect.value
    present = true
    origin = 'optimistic'
  }

  if (!present) {
    // Optimistically removed, or never there. Either way there is nothing to
    // render, and the pending commands whose effect WAS applied stay applied —
    // `unapplied` keeps naming only the ones nothing was derived from.
    return { present: false, value: undefined, origin, pending: ids, unapplied }
  }

  const attribution = materialisedBy?.attribution
  return {
    present: true,
    value,
    origin,
    pending: ids,
    unapplied,
    ...(attribution === undefined
      ? {}
      : { provisionalOwner: attribution.onBehalfOf, provisionalActor: attribution.actor }),
  }
}
