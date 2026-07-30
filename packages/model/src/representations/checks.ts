/**
 * The RETAINED-REPRESENTATION vocabulary and its default-closed totality checks
 * (POD-368, closing POD-302).
 *
 * ---------------------------------------------------------------------------
 * WHY A THIRD REGISTRY, WHEN TWO ALREADY EXIST
 * ---------------------------------------------------------------------------
 *
 * POD-304 classified the 53 ownership-matrix rows. POD-365 classified the 2
 * canonical aggregates. Neither covers the thing this epic actually contains
 * most of: the **39 retained representations** POD-364 counted — the storage
 * rows, the live-state contracts, the wire projections and the narrow ports that
 * ADR 4 D1 deliberately keeps as DISTINCT types.
 *
 * That gap mattered in four concrete ways, one per audit item below. Every one of
 * them was, before this file, a rule stated in prose in a document:
 *
 *   1. A new representation could arrive with **no visibility class**. ADR 9 D4
 *      says an undeclared class resolves to personal/private; that resolution is
 *      the semantic backstop, and the missing DECLARATION still has to fail a
 *      build (ADR 1 Amendment 1 D9). It did not.
 *   2. `owner`, `visibility` and the (actor, on-behalf-of) pair each have one
 *      definition in `../fields/`, but nothing checked that a representation
 *      composes them rather than restating a look-alike.
 *   3. `findCapabilitySnapshotKeys` (POD-643) existed and was pointed at exactly
 *      ONE representation. ADR 9 D5 A1's rule is about all of them.
 *   4. `PER_USER_STATE_KEYS` was enforced on the 2 aggregates. The singleton
 *      `readAt` that ADR 4 Am1 D10 is about does not live on an aggregate — it
 *      lives on `SessionDurableState` and on `IssueWire`, i.e. on
 *      representations.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is **not the composition instrument.** Branding is compile-time, so a
 * composed field swapped for a fresh `z.string()` is byte-identical and passes
 * every golden fixture; only asserting a field IS the shared schema INSTANCE
 * (`toBe`, not `toEqual`) can see that, and that assertion is only available for
 * the representations that are zod schemas inside this package. For the rest —
 * TypeScript interfaces in `apps/*` — no runtime instrument exists at all, which
 * is why {@link RetainedRepresentation.composition} is DECLARED DATA with a named
 * owner for anything still outstanding, and why `scripts/rearch-audit.ts` counts
 * registration and forbidden key classes over the tree rather than claiming to
 * grade composition. A ledger claiming "composed" on the strength of an
 * instrument that cannot measure composition is claiming something it does not
 * know (POD-367 §1a).
 *
 * It is **not authorization**, for the same reason `aggregates/registry.ts` is
 * not: nothing here decides whether a principal may see a row. That is
 * visibility, then owner, then grants, then role (ADR 9 D2 rule 2), resolved
 * LIVE at apply time by ADR 3 D8, and it is Phase 3's (POD-290).
 */

import type { z } from 'zod'
import { findCapabilitySnapshotKeys } from '../annotations/capability-snapshot'
import {
  MATRIX_INDEX_HOLDER,
  type MatrixRow,
  type MatrixRowId,
  type VisibilityClass,
  visibilityClassOf,
} from '../annotations/ownership'
import { PER_USER_STATE_KEYS } from '../aggregates/registry'

/**
 * ADR 4 D2's six roles. A representation declares EXACTLY ONE — that is the
 * predicate POD-364 counted by, and the reason storage, live state, wire and the
 * narrow ports each keep their own entry here instead of being folded together.
 */
export type RepresentationRole =
  /** The canonical durable aggregate. Registered in `aggregates/registry.ts`, not here. */
  | 'R1'
  /** Live in-process state: PTY/controller ownership, volatile fields. */
  | 'R2'
  /** Storage: physical DDL, or its typed row mirror. */
  | 'R3'
  /** A wire or read projection published to more than one consumer. */
  | 'R4'
  /** A narrow structural port: the fields ONE call site reads. */
  | 'R5'
  /** A portable export: a bundle that leaves this instance. */
  | 'R6'
  /** A command input (`Partial<Pick<…>>` and friends). Not an R1–R6 role, and
   *  named rather than forced into one — inventory §3 counts these separately. */
  | 'command-input'

/**
 * How this representation stands against the composition rule (ADR 4 D3.2:
 * compose, never copy a key list).
 *
 * Three arms, and the difference between the second and the third is the whole
 * value of the field: *"not yet composed"* and *"composing here would be wrong"*
 * have OPPOSITE correct actions, and an audit that counts them together tells
 * whoever reads it to go and break a validation gate (POD-367 §2 on
 * `IssueAutoArchiveObservation`).
 */
export type CompositionState =
  /** Composes the shared field schemas. `from` names what it picks FROM. */
  | { readonly state: 'composed'; readonly from: string }
  /**
   * Restates keys ON PURPOSE, with a reason that is not tidiness, and coverage
   * that would fail if someone "fixed" it. `enforcedBy` must name that coverage:
   * an exemption whose only defence is prose is indistinguishable from someone
   * silencing a detector.
   */
  | {
      readonly state: 'declared-legitimate-restatement'
      readonly reason: string
      readonly enforcedBy: string
    }
  /**
   * Still hand-restated, with a NAMED owner and a NAMED blocker. This is debt,
   * it is counted as debt by `scripts/rearch-audit.ts` under `owner`'s phase, and
   * it is deliberately not laundered into POD-302's zero.
   */
  | { readonly state: 'pending'; readonly owner: string; readonly blocker: string }

/**
 * One retained representation, completely documented and completely classified.
 *
 * Every field is REQUIRED, for the reason `MatrixRow` gives for its own columns:
 * optionality is how a column silently stops being filled in, and a totality
 * check only has teeth if the type has no hole for it to miss. The one optional
 * member is {@link schema}, whose absence is meaningful — it means the
 * representation is not a zod schema inside this L0 package, so the schema-level
 * audits below cannot reach it and the tree-level detector in
 * `scripts/rearch-audit.ts` is what covers it.
 */
export interface RetainedRepresentation {
  /** The declared symbol, exactly as the source spells it. */
  readonly symbol: string
  /** Which entity's vocabulary it draws on. */
  readonly entity: 'session' | 'issue'
  /** Repo-relative path of the DECLARATION. Checked against the tree by the
   *  audit script: an entry pointing at a site that no longer exists is a
   *  violation, so the registry cannot rot into a list of retired names. */
  readonly site: string
  readonly role: RepresentationRole

  /** What it is FOR — the job no other representation does. */
  readonly purpose: string
  /**
   * WHY ITS SEMANTICS GENUINELY DIFFER from the canonical aggregate. Not "it is
   * the wire shape" — what fact it carries that R1 does not, or what fact it
   * must drop. A representation that cannot answer this is a drifted duplicate
   * and belongs deleted, not documented (this issue's convention).
   */
  readonly distinctSemantics: string
  /** What it picks from the shared field schemas, and its composition standing. */
  readonly composition: CompositionState

  /** The ADR 1 matrix row that declares its class. A typed edge, never a string
   *  that can point at nothing. */
  readonly matrixRow: MatrixRowId
  /** ADR 9 D3's declared class. Checked against the matrix, never trusted alone. */
  readonly visibility: VisibilityClass

  /** Present only for zod schemas defined in this package. */
  readonly schema?: z.ZodTypeAny
}

/** A registry failure, with enough detail to fix it without re-deriving. */
export interface RepresentationViolation {
  readonly representation: string
  readonly kind:
    | 'no-matrix-row'
    | 'declaration-disagrees-with-matrix'
    | 'undocumented'
    | 'per-user-state-member'
    | 'capability-snapshot'
    | 'instance-partition'
  readonly detail: string
}

/**
 * Key names that reintroduce a deployment/tenant partition. ADR 1 D5 stands as
 * written and ADR 1 Amendment 2 fences it at length: the dimension multi-user
 * adds is OWNER, not tenant, and multi-user lives INSIDE one instance.
 *
 * `instanceId` is legitimate on exactly one row (`ROW.instanceId`, deployment
 * substrate) and on the frames that carry it; it is never a member of a session
 * or issue representation, which is the only thing this check looks at.
 */
const INSTANCE_PARTITION_KEY = /^(instance_?id|tenant_?id)$/i

/** Documentation that says nothing is worse than none: it reports as complete. */
const MIN_JUSTIFICATION = 24

/**
 * THE TOTALITY CHECK. An empty result means every retained representation is
 * classified, documented, free of per-user singletons on the members this
 * package can see, free of a serialized capability, and free of an instance
 * partition.
 *
 * Takes the registry and the matrix index as PARAMETERS so the test can run it
 * over a fixture set containing a BAD representation and observe it fail. A check
 * that could only ever run over the real, correct registry would be a check
 * nobody has seen fail — mechanism presence, not coverage.
 */
export function representationViolations(
  representations: readonly RetainedRepresentation[],
  index: ReadonlyMap<string, MatrixRow> = MATRIX_INDEX_HOLDER.index,
): RepresentationViolation[] {
  const out: RepresentationViolation[] = []
  for (const rep of representations) {
    const at = `${rep.symbol} (${rep.site})`

    // (a) The row must EXIST. A representation pointing at nothing is
    //     unclassified, however confidently its own `visibility` is filled in.
    if (!index.has(rep.matrixRow)) {
      out.push({
        representation: at,
        kind: 'no-matrix-row',
        detail:
          `declares visibility '${rep.visibility}' against matrix row '${rep.matrixRow}', ` +
          'which is not in the ownership matrix. ADR 9 D4 resolves an undeclared class to ' +
          'personal/private — but a MISSING declaration must still fail the build (ADR 1 ' +
          'Amendment 1 D9). Add the row in annotations/matrix.ts.',
      })
    }

    // (b) The declaration must AGREE with the matrix. `visibilityClassOf` is
    //     default-closed, so an unknown row resolves to `personal` here and any
    //     LOUDER declaration is caught as a disagreement — the exposure case.
    const resolved = visibilityClassOf(rep.matrixRow, index)
    if (resolved !== rep.visibility) {
      out.push({
        representation: at,
        kind: 'declaration-disagrees-with-matrix',
        detail:
          `declares '${rep.visibility}' but ADR 1's matrix resolves row '${rep.matrixRow}' ` +
          `to '${resolved}'. The matrix is the normative column set (ADR 9 D2 rule 1); ` +
          'change the row, not the representation.',
      })
    }

    // (c) It must justify itself in the documented form, or be deleted.
    for (const [field, text] of [
      ['purpose', rep.purpose],
      ['distinctSemantics', rep.distinctSemantics],
    ] as const) {
      if (text.trim().length < MIN_JUSTIFICATION) {
        out.push({
          representation: at,
          kind: 'undocumented',
          detail:
            `has no usable '${field}'. Every retained representation is documented with its ` +
            'purpose, why its semantics genuinely differ from the canonical aggregate, and what ' +
            'it composes. A representation that cannot justify itself in that form is a drifted ' +
            'duplicate and must be DELETED, not registered.',
        })
      }
    }
    if (rep.composition.state === 'declared-legitimate-restatement') {
      const { reason, enforcedBy } = rep.composition
      if (reason.trim().length < MIN_JUSTIFICATION || enforcedBy.trim().length < MIN_JUSTIFICATION) {
        out.push({
          representation: at,
          kind: 'undocumented',
          detail:
            'claims a legitimate restatement without both a reason and the coverage that ' +
            'enforces it. An exemption defended only by prose is indistinguishable from ' +
            'someone silencing a detector (POD-367 §2).',
        })
      }
    }

    // (d)-(f) run over the SCHEMA, so they only apply where one is available in
    //     this L0 package. Everything else is covered over the tree by
    //     `scripts/rearch-audit.ts`, which is stated in the README rather than
    //     silently skipped here.
    if (!rep.schema) continue

    const shape = topLevelKeys(rep.schema)
    for (const key of PER_USER_STATE_KEYS) {
      if (shape.includes(key)) {
        out.push({
          representation: at,
          kind: 'per-user-state-member',
          detail:
            `carries '${key}' as a SINGLETON. Per-user state is POD-1076's (userId, entityId) ` +
            'family over the one PerUserKey fragment (ADR 4 Amendment 1 D10, inventory §7.1). ' +
            'A singleton left here is later a table migration PLUS a wire change PLUS a replica ' +
            'migration.',
        })
      }
    }

    const authority = findCapabilitySnapshotKeys(rep.schema)
    if (authority.length > 0) {
      out.push({
        representation: at,
        kind: 'capability-snapshot',
        detail:
          `carries serialized authority at ${authority.join(', ')}. ADR 9 D5 A1: effective ` +
          "rights are an agent's own scope intersected with its human's CURRENT rights, " +
          'resolved live at every apply (ADR 3 D8). A snapshot survives the revocation of the ' +
          'person it was derived from, with no reaper to trigger.',
      })
    }

    for (const key of shape) {
      if (INSTANCE_PARTITION_KEY.test(key)) {
        out.push({
          representation: at,
          kind: 'instance-partition',
          detail:
            `carries '${key}'. ADR 1 D5 stands (Amendment 2 fences it): multi-user lives ` +
            'INSIDE one instance and the dimension it adds is OWNER, not tenant. Multi-user is ' +
            'not multi-tenancy.',
        })
      }
    }
  }
  return out
}

/** Top-level key names of a zod object, seen through the wrappers that do not
 *  change the key set. Returns `[]` for anything that is not an object — a
 *  representation this cannot read is reported as such by the caller, never as
 *  clean. */
function topLevelKeys(schema: z.ZodTypeAny): string[] {
  let cur: z.ZodTypeAny = schema
  for (let i = 0; i < 8; i++) {
    const def = cur._def as { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny }
    if (def.typeName === 'ZodObject') return Object.keys((cur as unknown as z.AnyZodObject).shape)
    const next = def.innerType ?? def.schema
    if (!next) return []
    cur = next
  }
  return []
}

/** The declared class of a retained representation BY SYMBOL, resolved
 *  default-closed: a representation nobody registered is `personal`, exactly as
 *  an unknown matrix row is (ADR 9 D4). A total function with no "unclassified"
 *  outcome a caller could mishandle and no throw a caller could treat as
 *  permissive. */
export function representationVisibilityOf(
  symbol: string,
  representations: readonly RetainedRepresentation[],
): VisibilityClass {
  return representations.find((r) => r.symbol === symbol)?.visibility ?? 'personal'
}
