/**
 * THE ARBITRATION SURFACE — **Authority-side callers only.**
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE
 * ---------------------------------------------------------------------------
 *
 * ADR 1 D1: durable truth is committed only by the Authority; the Replica
 * applies Authority-ordered revisions and **never merges concurrent truths,
 * never invents LWW, and never overrides an Authority revision**. Multi-user
 * does not relax this — including for `op-stream`, where the Replica applies an
 * ordering the Authority decided (Amendment 1 D12 part 2).
 *
 * The matrix rows themselves are documentation and are readable anywhere: a UI
 * that wants to explain "this field is admin-managed" is not arbitrating. What
 * a Replica must never reach is the CONFLICT RULE — the input to "which of these
 * two writes wins". So the arbitration reads live behind this one door, and
 * `arbitration-direction.test.ts` fails when a file outside the Authority-side
 * allowlist imports it.
 *
 * That is the lint/test-enforced direction the acceptance criteria ask for. It
 * is a tripwire on the READ, in the spirit of POD-387's capability-read
 * tripwire: an import-site check catches the mistake at the moment it is
 * written, which a code review of merge logic does not.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * Not an arbitrator. These functions return the DECLARED rule for a row; the
 * write funnel that applies it is POD-305's. And per ADR 4 D3.9 the ownership
 * annotations govern Authority arbitration ONLY — they must never derive
 * optimistic effects, which are command-contract reducers (ADR 3, POD-311).
 */

import type { ConflictRule, MatrixRow } from './ownership'
import { MATRIX_INDEX_HOLDER } from './ownership'

/**
 * The conflict rule the Authority must apply to a row.
 *
 * Fails LOUD on an unknown class rather than returning a default: unlike
 * visibility — where a missing declaration has a safe answer (private) — there
 * is no safe default merge policy. Picking one silently is how a class ends up
 * with whole-aggregate LWW that nobody chose.
 */
export function conflictRuleFor(
  rowId: string,
  index: ReadonlyMap<string, MatrixRow> = MATRIX_INDEX_HOLDER.index,
): ConflictRule {
  const row = index.get(rowId)
  if (!row) {
    throw new Error(
      `ownership matrix: no row for '${rowId}' — the Authority may not arbitrate a class with no ` +
        'declared conflict rule (ADR 1 D4 / POD-304 totality). Declare the row in matrix.ts.',
    )
  }
  return row.conflict
}

/** Does a mutating command for this row have to carry an expected revision? */
export function requiresExpectedRevision(
  rowId: string,
  index: ReadonlyMap<string, MatrixRow> = MATRIX_INDEX_HOLDER.index,
): boolean {
  return conflictRuleFor(rowId, index) === 'exp-rev'
}

/**
 * May this row be arbitrated by field-level last-writer-wins?
 *
 * `true` only for a row whose declared rule IS `field-LWW`, which ADR 1 D3
 * admits only with a defined Authority clock and an invariant note — both of
 * which the totality test requires on the row. Amendment 1 D10 shrank that set
 * to instance-scope preference keys plus the composer draft's dated interim.
 */
export function permitsFieldLww(
  rowId: string,
  index: ReadonlyMap<string, MatrixRow> = MATRIX_INDEX_HOLDER.index,
): boolean {
  return conflictRuleFor(rowId, index) === 'field-LWW'
}

/**
 * The clock a `field-LWW` row arbitrates on — ADR 1 D3 condition 1: the
 * **Authority-assigned event time at commit**. Client wall clocks never
 * arbitrate; they may be attribution metadata only.
 *
 * A single exported constant rather than a per-row string, because "which
 * clock?" has exactly one legal answer and a row that wanted a different one
 * would need an ADR amendment, not a field.
 */
export const FIELD_LWW_CLOCK = 'authority-event-time-at-commit' as const
