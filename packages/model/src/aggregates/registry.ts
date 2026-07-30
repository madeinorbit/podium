/**
 * The CANONICAL AGGREGATE REGISTRY, and the default-closed classification it
 * enforces (POD-365).
 *
 * ADR 9 D4: *"an entity class with no declared visibility class is
 * personal/private, never tenant-visible. Forgetting to classify must fail
 * toward privacy."* POD-304 landed that rule for the ownership MATRIX — 53
 * annotated rows, `visibilityClassOf`'s total resolver, and a totality test that
 * plants an unclassified fixture. This file is the same obligation for the
 * CANONICAL AGGREGATES: adding one without a visibility class must fail, and
 * `registry.test.ts` proves it with a fixture aggregate rather than asserting it.
 *
 * ---------------------------------------------------------------------------
 * THREE MECHANISMS, AND WHY NONE SUBSTITUTES FOR ANOTHER
 * ---------------------------------------------------------------------------
 *
 * 1. **The type has no hole.** {@link CanonicalAggregate} makes `visibility` and
 *    `matrixRow` REQUIRED. You cannot register an aggregate without declaring —
 *    which is a compile error, the cheapest possible failure.
 *
 * 2. **The declaration is checked against the matrix.** A required field only
 *    forces you to write *something*; {@link classificationViolations} forces you
 *    to write the *same thing ADR 1's matrix says*. This is the mechanism that
 *    catches the real mistake — an aggregate that declares
 *    `deployment-substrate` for a row the matrix calls `personal` would
 *    otherwise be a well-typed exposure.
 *
 * 3. **The resolver still fails closed with every test deleted.**
 *    `visibilityClassOf` (POD-304) resolves an unknown row to `personal`. That
 *    is the SEMANTIC backstop, and it is why an aggregate pointing at a
 *    nonexistent matrix row is caught by (2): the resolver answers `personal`,
 *    so any declaration other than `personal` mismatches, and a declaration OF
 *    `personal` is caught by the separate missing-row check. Both halves are
 *    needed — the default is not the test (ADR 9 D4, model README invariant 4).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is not authorization. Nothing here decides whether a principal may see a
 * row: that is `visibility` first, then `owner`, then `grants`, then role (ADR 9
 * D2 rule 2), evaluated LIVE at apply time by ADR 3 D8, and it is Phase 3's
 * (POD-290). This registry only makes sure every canonical aggregate has said
 * which class it belongs to — the input that policy will read.
 *
 * It is also not a place to snapshot rights. See `fields/README.md` rule 4.
 */

import type { z } from 'zod'
import {
  MATRIX_INDEX_HOLDER,
  type MatrixRow,
  type MatrixRowId,
  type VisibilityClass,
  visibilityClassOf,
} from '../annotations/ownership'
import { ROW } from '../annotations/matrix'
import { IssueAggregate } from './issue'
import { SessionAggregate } from './session'

/**
 * One canonical R1 aggregate, completely classified.
 *
 * Every field is REQUIRED, for the reason `MatrixRow` gives for its own
 * columns: optionality is how a column silently stops being filled in, and a
 * totality check only has teeth if the type has no hole for it to miss.
 */
export interface CanonicalAggregate {
  /** Stable name, used by the checks and in failure messages. */
  readonly name: string
  /** The zod shape. Typed loosely on purpose — the checks below read keys, and
   *  narrowing this would make the registry generic over 2 shapes for no gain. */
  readonly schema: z.ZodObject<z.ZodRawShape>
  /** The ADR 1 matrix row that declares this class. A typed edge, not a string
   *  that can point at nothing — a nonexistent row is a violation, not a
   *  silently-permissive default. */
  readonly matrixRow: MatrixRowId
  /** The declared class (ADR 9 D3). Checked against the matrix, never trusted
   *  on its own. */
  readonly visibility: VisibilityClass
}

/**
 * THE canonical aggregates. Two today.
 *
 * Both are `personal` — ADR 9 D3's first class: private to their owner and
 * shareable by explicit grant. That is the human decision of 2026-07-29 (§3.1
 * "C's mechanism, B's default") applied to the two classes this issue defines,
 * and it matches the `session-identity` and `issue-core` rows the matrix already
 * carries. Neither is `deployment-substrate`: the tenant-visible floor is
 * deliberately small (readiness §3.1.1) and a session or an issue is not
 * substrate.
 */
export const CANONICAL_AGGREGATE_NAMES = ['Session', 'Issue'] as const
export type CanonicalAggregateName = (typeof CANONICAL_AGGREGATE_NAMES)[number]

/**
 * Keyed by name rather than an array literal, and that is the whole point.
 *
 * `Record<CanonicalAggregateName, …>` makes an OMISSION a compile error, and the
 * excess-property check makes an entry with no name in the union one too. An
 * array cannot express either: dropping a member from
 * `readonly CanonicalAggregate[]` is perfectly well-typed, and
 * `registry.test.ts`'s mutant E proved the consequence — the whole `Session`
 * entry deleted, the suite green, `bunx tsgo --noEmit` green, and the test count
 * silently down by three as every `it.each` iterated one fewer case.
 *
 * This is the shape POD-367 found on the other side of the same lesson: its
 * command list is guarded by `satisfies Record<IssueCommandName, …>` in the
 * server registry, so a deletion there fails compilation. Mine had no such
 * guard. Now it does — and the runtime membership pin stays, because the two
 * instruments do not overlap: a type can see an omitted KEY, and only a runtime
 * assertion can see the coverage of a loop over that key set shrinking.
 *
 * `name` is NOT a member of the values. It is the key, applied when the list is
 * built, so a key/name mismatch is unrepresentable rather than merely tested.
 */
const AGGREGATE_BY_NAME: Record<CanonicalAggregateName, Omit<CanonicalAggregate, 'name'>> = {
  Session: {
    schema: SessionAggregate,
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  Issue: {
    schema: IssueAggregate,
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
}

export const CANONICAL_AGGREGATES: readonly CanonicalAggregate[] = CANONICAL_AGGREGATE_NAMES.map(
  (name) => ({ name, ...AGGREGATE_BY_NAME[name] }),
)

/**
 * PER-USER STATE MEMBERS that must never appear as a field on a canonical
 * aggregate (ADR 4 Amendment 1 D10, inventory §7.1).
 *
 * Key NAMES rather than a structural rule, because that is what the mistake
 * actually looks like: nobody adds a per-user aggregate to a session, they add
 * `readAt` back as a singleton "for now". The eleven §7.1 members reduce to
 * these nine distinct key spellings across the two entities.
 *
 * `deferUntil` is deliberately NOT in this list and its absence is a decision:
 * unlike `snoozedUntil` it is a claim about the WORK ("this cannot start before
 * Tuesday"), identical for every viewer, and the defer/snooze split is already
 * settled in `../predicates/issue-stage.ts`.
 */
export const PER_USER_STATE_KEYS = [
  'readAt',
  'snoozedUntil',
  'tuckedAt',
  'pinned',
  'pins',
  'tabOrder',
  'paneA',
  'paneB',
  'preferences',
] as const

/** A classification failure, with enough detail to fix it without re-deriving. */
export interface ClassificationViolation {
  readonly aggregate: string
  readonly kind: 'no-matrix-row' | 'declaration-disagrees-with-matrix' | 'per-user-state-member'
  readonly detail: string
}

/**
 * THE TOTALITY CHECK. Empty result = every aggregate is classified and carries
 * no per-user state.
 *
 * Takes the aggregate list and the matrix index as PARAMETERS so the test can
 * run it over a fixture set containing an unclassified aggregate and observe it
 * fail. A check that could only ever be run over the real, correct registry
 * would be a check nobody has seen fail — mechanism presence, not coverage.
 */
export function classificationViolations(
  aggregates: readonly CanonicalAggregate[] = CANONICAL_AGGREGATES,
  index: ReadonlyMap<string, MatrixRow> = MATRIX_INDEX_HOLDER.index,
): ClassificationViolation[] {
  const out: ClassificationViolation[] = []
  for (const agg of aggregates) {
    // (a) The row must EXIST. An aggregate pointing at nothing is unclassified,
    //     however confidently its own `visibility` field is filled in.
    if (!index.has(agg.matrixRow)) {
      out.push({
        aggregate: agg.name,
        kind: 'no-matrix-row',
        detail:
          `declares visibility '${agg.visibility}' against matrix row '${agg.matrixRow}', ` +
          'which is not in the ownership matrix. ADR 9 D4: an undeclared class is ' +
          'personal/private — but a MISSING declaration must still fail the build (ADR 1 ' +
          'Amendment 1 D9). Add the row in annotations/matrix.ts.',
      })
    }

    // (b) The declaration must AGREE with the matrix. `visibilityClassOf` is
    //     default-closed, so a missing row resolves to `personal` here and any
    //     louder declaration is caught as a disagreement — the exposure case.
    const resolved = visibilityClassOf(agg.matrixRow, index)
    if (resolved !== agg.visibility) {
      out.push({
        aggregate: agg.name,
        kind: 'declaration-disagrees-with-matrix',
        detail:
          `declares '${agg.visibility}' but ADR 1's matrix resolves row '${agg.matrixRow}' ` +
          `to '${resolved}'. The matrix is the normative column set (ADR 9 D2 rule 1); ` +
          'change the row, not the aggregate.',
      })
    }

    // (c) No per-user singleton may have crept back onto the aggregate.
    for (const key of PER_USER_STATE_KEYS) {
      if (key in agg.schema.shape) {
        out.push({
          aggregate: agg.name,
          kind: 'per-user-state-member',
          detail:
            `carries '${key}', which is per-user state (ADR 4 Amendment 1 D10, inventory ` +
            '§7.1). It belongs to POD-1076\'s (userId, entityId) family over the one ' +
            'PerUserKey fragment. A singleton left here is later a table migration PLUS a ' +
            'wire change PLUS a replica migration.',
        })
      }
    }
  }
  return out
}

/** The declared class of a canonical aggregate BY NAME, resolved default-closed:
 *  an aggregate nobody registered is `personal`, exactly as an unknown matrix
 *  row is. A total function with no "unclassified" outcome a caller could
 *  mishandle and no throw a caller could catch and treat as permissive. */
export function aggregateVisibilityOf(
  name: string,
  aggregates: readonly CanonicalAggregate[] = CANONICAL_AGGREGATES,
): VisibilityClass {
  return aggregates.find((a) => a.name === name)?.visibility ?? 'personal'
}
