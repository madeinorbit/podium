/**
 * THE SCOPED SLICE — one global batch, evaluated for ONE principal (POD-1077;
 * ADR 2 Amendment 1 D12/D13/D14).
 *
 * ---------------------------------------------------------------------------
 * THE ONE IDEA IN THIS FILE: THE RANGE TRAVELS WITH THE FILTER
 * ---------------------------------------------------------------------------
 *
 * D13 requires the filter and the watermark to land TOGETHER, and POD-351 stated
 * the failure precisely: *a filter without a watermark is a protocol break, and
 * every suppressed row without one is a permanent invisible gap that heal-loops
 * forever.* The replica's rule is `fromSeq === cursor`; a suppressed seq that
 * nobody certifies is a hole the replica can only respond to by healing, and the
 * heal returns the same filtered rows, forever.
 *
 * That failure is not prevented here by remembering to call a second method. It
 * is prevented by the TYPE: {@link ScopedDelivery} carries `throughSeq` — the
 * inclusive upper bound of the range that was evaluated — as a required field
 * beside `changes`. There is no way to hand a caller a filtered list without also
 * handing it the range the filtering covered, so a suppressed row cannot be
 * delivered as silence. `changes: []` with `throughSeq` above the receiver's
 * position IS the watermark, and under private-by-default it is the normal path.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EVALUATION LIVES ON THE AUTHORITY SIDE
 * ---------------------------------------------------------------------------
 *
 * D12 consequence 7: *"the authority evaluates visibility; the replica never
 * filters, never re-checks, and never receives a row it may not see."* The Feed
 * publisher owns FRAMING — per-connection `fromSeq`, coalescing, the bounded
 * queue, demotion. This module owns the DECISION. One filtering site, one framing
 * site, and neither can be written without the other because the framing side is
 * handed a `ScopedDelivery` and nothing else.
 *
 * ---------------------------------------------------------------------------
 * `rescope` IS DERIVED, NEVER SUPPLIED
 * ---------------------------------------------------------------------------
 *
 * D14.4's terminal path is taken when a visibility change is too large to
 * enumerate. It is produced HERE, from the size of the set the POLICY derived —
 * never from a field a caller set. A caller that could ask for a rescope on
 * another principal's behalf would be an oracle for that principal's rights, and
 * the frame it produced would be indistinguishable from an honest one. So the
 * publisher has no `rescope` method to call: it applies the arm the derivation
 * chose, and `authority.scoped.test.ts` asserts the absence of any other route.
 */

import type {
  EntityRef,
  FeedPrincipal,
  FeedVisibilityPolicy,
  VisibilityAnchorPort,
} from '../feed/visibility'
import { humanOf } from '../feed/visibility'
import type { ScopedChange, SequencedChange } from './change-lifecycle'

/**
 * What one principal is delivered for one evaluated range.
 *
 * Two arms and no third: either the range was evaluated and here is exactly what
 * you may see in it (D13), or your rights moved by more than it is worth
 * enumerating and you must re-bootstrap scoped (D14.4 → D7 rung 2). Both carry
 * `throughSeq`, so neither can advance a cursor without saying how far.
 */
export type ScopedDelivery =
  | {
      readonly kind: 'batch'
      /** Inclusive upper bound of the range evaluated against this principal. */
      readonly throughSeq: number
      /** Exactly the rows in that range this principal may see. MAY be empty. */
      readonly changes: readonly ScopedChange[]
    }
  | {
      readonly kind: 'rescope'
      readonly throughSeq: number
      /** Telemetry MUST be able to tell this from `resync-required` (D14.4). */
      readonly reason: string
    }

/** A subscriber on the ordered pipe, for ONE principal. */
export type ScopedSubscriber = (delivery: ScopedDelivery) => void

export interface ScopingDeps {
  readonly policy: FeedVisibilityPolicy
  readonly anchors: VisibilityAnchorPort
  /**
   * Above this many DERIVED anchored rows in one evaluation, take D14.4's
   * terminal path instead of enumerating.
   *
   * A dependency and not a constant because ADR 2 Amendment 1 D13.5/D14.4 leave
   * the numbers to POD-337's measurements and this document does not invent them.
   * The DEFAULT is deliberately small enough that the suite can reach both arms
   * without building a large fixture — a threshold no test can cross is a branch
   * no test covers.
   */
  readonly rescopeThreshold: number
}

export const DEFAULT_RESCOPE_THRESHOLD = 32

/**
 * Evaluate one appended batch for one principal.
 *
 * `throughSeq` is the head of the range the AUTHORITY evaluated, not the last
 * visible row's seq. That distinction is the whole watermark: taking it from the
 * data would certify a range that ends where the visible data ends, silently
 * skipping every seq that was evaluated and suppressed — the invisible permanent
 * gap, arriving through the exact door D13 was written to close.
 */
export function scopeBatch(
  deps: ScopingDeps,
  principal: FeedPrincipal,
  changes: readonly SequencedChange[],
  throughSeq: number,
): ScopedDelivery {
  const visible: ScopedChange[] = []
  const anchored: ScopedChange[] = []
  const human = humanOf(principal)

  for (const change of changes) {
    // 1. The ordinary path: is this row in this principal's slice right now?
    if (deps.policy.mayDeliver(principal, change)) visible.push(change)

    // 2. D14.3: did this row MOVE anyone's visibility? Asked of the port that
    //    owns the tables, never inferred from the payload — a payload-shaped
    //    check would classify by content, and content is exactly what a caller
    //    controls.
    const edge = deps.anchors.visibilityEdge(change)
    if (edge === null) continue
    if (!edge.audience.includes(human)) continue
    for (const subject of edge.subjects) {
      anchored.push(anchorFor(deps, principal, subject, change.seq))
    }
  }

  if (anchored.length > deps.rescopeThreshold) {
    // D14.4: the terminal path, chosen from the size of the DERIVED set. No input
    // reaches this branch; a caller cannot ask for it.
    return {
      kind: 'rescope',
      throughSeq,
      reason: `visibility-change:${anchored.length}-rows-over-threshold-${deps.rescopeThreshold}`,
    }
  }

  // Anchored rows share the seq of the change that caused them (D14.3), so the
  // sort must be STABLE and must not attempt to order within a seq: uniqueness of
  // `seq` is a property of the global log, not of a per-principal frame.
  const rows = [...visible, ...anchored].sort((a, b) => a.seq - b.seq)
  return { kind: 'batch', throughSeq, changes: rows }
}

/**
 * One anchored row, with the OP DERIVED FROM THE POLICY.
 *
 * Re-admission (D14.2) needs the entity's current value; when the port has none —
 * the entity is gone — there is nothing to re-admit and the honest row is the
 * eviction, which is also what a replica holding a stale copy needs.
 *
 * `remove` is unreachable from here and that is normative (D14.5): reusing it
 * would make the replica render a revoked share as a deletion, and a later
 * re-grant as a resurrection.
 */
function anchorFor(
  deps: ScopingDeps,
  principal: FeedPrincipal,
  subject: EntityRef,
  seq: number,
): ScopedChange {
  const base = { seq, entity: subject.entity, entityId: subject.entityId }
  if (deps.policy.mayDeliver(principal, subject)) {
    const value = deps.anchors.currentValueOf(subject)
    if (value !== undefined) return { ...base, op: 'upsert', value }
  }
  return { ...base, op: 'evict' }
}
