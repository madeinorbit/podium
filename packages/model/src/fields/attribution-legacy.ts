/**
 * THE LEGACY-ATTRIBUTION SWEEP — every device-level or role-level attribution
 * field in the system, with its decided shape (POD-1075).
 *
 * `docs/multi-user-readiness.md` §3.2 names the problem in one sentence: *"every
 * attribution field in the system is currently device-level or role-level —
 * `humanQuestionAskedBy`, `deletion_source`, `nameSource: 'user'`, close/unblock
 * actor. Under multi-user these must name a person."* ADR 4 Amendment 1 D9.3
 * supplies the shape (a PAIR, two differently branded fields) and
 * `fields/attribution.ts` supplies the schema. POD-365 then landed a decided
 * shape at each of the four sites.
 *
 * What did not exist is the thing that makes "the sweep is complete" checkable
 * rather than believable: a list of the sites, each naming the group that
 * carries its pair, with a totality test. This file is that list.
 *
 * ---------------------------------------------------------------------------
 * WHY A LIST AND NOT A GREP
 * ---------------------------------------------------------------------------
 *
 * A grep for attribution-shaped names finds the fields that ARE attribution. It
 * cannot find the ones that were supposed to be and are not, which is the whole
 * failure class here — `deletionSource` is a code-PATH label that reads like an
 * actor, `nameSource` is a ROLE CLASS that reads like a person, and inventory §9
 * warns that taking either at face value leaves the site with **no actor at
 * all**. A detector keyed on names would pass on exactly the two fields that
 * motivated the sweep.
 *
 * So the sites are enumerated, and the test checks the property that matters:
 * each declared group carries the ONE shared {@link Attribution} schema INSTANCE
 * (asserted with `toBe`, not `toEqual` — a restatement is byte-identical and
 * invisible to a golden fixture), and every entry declares a `decided` shape
 * with no "undecided" arm to park one in.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT CLAIMED
 * ---------------------------------------------------------------------------
 *
 * CLAIMED: each site has a decided model shape, and that shape composes the
 * shared pair rather than a look-alike.
 *
 * NOT CLAIMED: that the pair is STAMPED at every write today. It is not, and the
 * matrix says so on the record (`ROW.issueCore`'s `interimDefect`): attribution
 * is recorded conditionally on the event payload, so an operator-originated
 * close records nothing. Stamping it from the transport principal at every write
 * is the command layer's, and lands with Phase 3 (POD-311 / POD-315). Conflating
 * "the field exists" with "the field is filled in" is the mechanism-presence
 * failure this run has hit repeatedly; the {@link LegacyAttributionSite.stamped}
 * column exists so the two are separately readable and neither can be inferred
 * from the other.
 */

import type { z } from 'zod'
import { Attribution } from './attribution'
import { IssueLifecycle } from './issue'
import { NeedsHuman } from './issue'
import { SessionNaming, SessionTombstone } from './session'

/**
 * One legacy attribution field and what it became.
 *
 * Every member is REQUIRED, for the reason `MatrixRow` gives for its own
 * columns: optionality is how a column silently stops being filled in, and a
 * totality check only has teeth if the type has no hole for it to miss.
 */
export interface LegacyAttributionSite {
  /** The field as it exists today, spelled as the code spells it. */
  readonly legacyField: string
  /** WHY it is not attribution, even though it reads like it. This is the
   *  sentence that stops the next reader concluding the site is already done. */
  readonly whyNotAPerson: string
  /** The field group that now carries the pair. */
  readonly carriedBy: string
  /** That group's schema, so the test can assert composition by INSTANCE. */
  readonly schema: z.ZodObject<z.ZodRawShape>
  /** The key on that group under which the pair sits. Nested paths are spelled
   *  with dots; the pair being NESTED is itself the decision at three of the
   *  four sites — see `decided`. */
  readonly pairAt: string
  /** The decided shape, in one sentence. There is deliberately no `undecided`
   *  arm: a site with no decision is not registrable, so the list cannot become
   *  a place to park one. */
  readonly decided: string
  /**
   * Is the pair STAMPED at every write today, or only representable?
   *
   * `representable-only` is the honest answer at all four sites and is NOT a
   * defect this issue leaves lying: `docs/multi-user-readiness.md` §5 assigns
   * *"per-user attribution stamped from the principal"* to Phase 3 (POD-290),
   * and ADR 3 D7 already forbids taking it from payload, so the stamping site is
   * the command layer's principal resolution and not a model field.
   */
  readonly stamped: 'at-every-write' | 'representable-only'
  /** Who stamps it, for the `representable-only` case. */
  readonly stampingOwner: string
}

/**
 * The four sites `docs/multi-user-readiness.md` §3.2 names, and nothing else.
 *
 * The list is CLOSED on purpose: it is the readiness document's own enumeration,
 * so a fifth entry means either the document grew one or somebody is using this
 * list as a general attribution registry — which it is not. The general
 * obligation ("every attributed write carries the pair") lives on ADR 1's matrix
 * as a per-row `AttributionRule` column with its own totality test.
 */
export const LEGACY_ATTRIBUTION_SITES: readonly LegacyAttributionSite[] = [
  {
    legacyField: 'humanQuestionAskedBy',
    whyNotAPerson:
      'Holds the asking SESSION id and is used as the delivery address, so it names a session, ' +
      'not a person. It is server-authoritative precisely so "did a person or an agent ask ' +
      'this?" stays answerable — which it cannot be while the only recorded half is a session.',
    carriedBy: 'NeedsHuman (fields/issue.ts)',
    schema: NeedsHuman,
    pairAt: 'asked.attribution',
    decided:
      'The ACTOR half keeps its meaning and its server-authoritative rule — `asked.by` is still ' +
      'the asking SESSION, because that is also the delivery address the registry routes the ' +
      'answer to — and the pair is added beside it at `asked.attribution`. Both live in ONE ' +
      'nested object that is required as a whole, so a shape recording WHEN a question was asked ' +
      'while recording nothing about WHO does not typecheck (the live defect POD-367 pinned at ' +
      'commit a349bf4e).',
    stamped: 'representable-only',
    stampingOwner: 'POD-311 / POD-315 (command layer, from the transport principal per ADR 3 D7)',
  },
  {
    legacyField: 'deletion_source / deletionSource',
    whyNotAPerson:
      'A code-PATH label — WHICH deletion path ran (issue cascade vs standalone). Inventory §9 is ' +
      'emphatic that it is not an attribution field: reading "typed label, so attribution is ' +
      'handled" at face value would leave session deletion with NO ACTOR AT ALL.',
    carriedBy: 'SessionTombstone (fields/session.ts)',
    schema: SessionTombstone,
    pairAt: 'deleted.by',
    decided:
      'The label STAYS, as a reason rather than a principal, and the pair sits beside it inside ' +
      'the same nested `deleted` object as `at` — so a tombstone cannot record when it happened ' +
      'while recording nothing about who did it.',
    stamped: 'representable-only',
    stampingOwner: 'POD-311 / POD-315 (command layer)',
  },
  {
    legacyField: "nameSource: 'user' | 'agent'",
    whyNotAPerson:
      'A ROLE CLASS, not a person — it is the input to the human-outranks-agent naming rule ' +
      '([spec:SP-eb60]) and answers "what kind of writer set this", never "which one".',
    carriedBy: 'SessionNaming (fields/session.ts)',
    schema: SessionNaming,
    pairAt: 'namedBy',
    decided:
      'The enum is KEPT AS IT IS so the wire is byte-identical and the outranking rule keeps its ' +
      'input, and the pair is added beside it as an all-or-nothing nested value. Replacing the ' +
      'enum with the pair was rejected: the rule needs the role class, and deriving it back from ' +
      'an actor kind would be a second encoding of a decision that already has one.',
    stamped: 'representable-only',
    stampingOwner: 'POD-311 / POD-315 (command layer)',
  },
  {
    legacyField: 'close / unblock actor (causedBySessionId on the event payload)',
    whyNotAPerson:
      'Recorded only on the EVENT payload and never on the row, and spread CONDITIONALLY on a ' +
      'ternary — so an operator-originated close records no attribution at all, making "no actor ' +
      'recorded" and "a human did it" indistinguishable.',
    carriedBy: 'IssueLifecycle (fields/issue.ts)',
    schema: IssueLifecycle,
    pairAt: 'lastLifecycleActor',
    decided:
      'The ROW gains a home for the pair, which is what makes the two cases distinguishable. It ' +
      'is optional at the field level only because history has no value to backfill — not ' +
      'because a new write may omit it; unconditional stamping is the command layer’s obligation ' +
      'and is tracked as the `interimDefect` on ADR 1’s matrix rather than silently accepted.',
    stamped: 'representable-only',
    stampingOwner: 'POD-311 / POD-315 (command layer)',
  },
]

/** A sweep failure, with enough detail to fix it without re-deriving. */
export interface LegacyAttributionViolation {
  readonly site: string
  readonly kind: 'pair-not-composed' | 'pair-absent' | 'undocumented'
  readonly detail: string
}

/** Documentation that says nothing is worse than none: it reports as complete. */
const MIN_JUSTIFICATION = 24

/**
 * THE TOTALITY CHECK. Empty result = every legacy attribution site names a group
 * that composes the ONE shared {@link Attribution} schema, at a declared key,
 * with a documented decision.
 *
 * Takes the site list as a PARAMETER so the test can run it over a fixture
 * containing a site whose group carries a look-alike instead of the shared
 * instance, and observe it fail. A check that could only ever run over the real,
 * correct list would be a check nobody has seen fail.
 */
export function legacyAttributionViolations(
  sites: readonly LegacyAttributionSite[] = LEGACY_ATTRIBUTION_SITES,
): LegacyAttributionViolation[] {
  const out: LegacyAttributionViolation[] = []
  for (const site of sites) {
    for (const [field, text] of [
      ['whyNotAPerson', site.whyNotAPerson],
      ['decided', site.decided],
    ] as const) {
      if (text.trim().length < MIN_JUSTIFICATION) {
        out.push({
          site: site.legacyField,
          kind: 'undocumented',
          detail:
            `has no usable '${field}'. A site that cannot say why its legacy field is not a ` +
            'person, and what it became, is a site nobody decided — and the point of this list ' +
            'is that there is no undecided arm to park one in.',
        })
      }
    }

    const found = resolvePairSchema(site.schema, site.pairAt)
    if (found === undefined) {
      out.push({
        site: site.legacyField,
        kind: 'pair-absent',
        detail:
          `declares its pair at '${site.pairAt}' on ${site.carriedBy}, and there is no such key. ` +
          'Under multi-user this field must name a PERSON (readiness §3.2); a site whose pair has ' +
          'gone missing has silently reverted to device-level or role-level attribution.',
      })
      continue
    }
    // `toBe`-grade: the shared INSTANCE, not a shape that happens to match.
    // A restatement is byte-identical on the wire and invisible to a golden
    // fixture, so identity is the only instrument that can see it.
    if (found !== Attribution) {
      out.push({
        site: site.legacyField,
        kind: 'pair-not-composed',
        detail:
          `carries a look-alike at '${site.pairAt}' instead of the shared Attribution schema ` +
          '(ADR 4 Amendment 1 D9.3, fields/README.md rule 1). A restated pair is byte-identical ' +
          'and drifts silently: the two halves are differently branded for a reason, and a copy ' +
          'is where one of them quietly becomes a nullable string again.',
      })
    }
  }
  return out
}

/**
 * The schema at `path` on `schema`, unwrapped through the wrappers that do not
 * change identity of the thing underneath — `.optional()` and `.nullable()`.
 *
 * Nested paths matter because the nesting IS the decision at three of the four
 * sites: `deleted.by` sits inside the object that also holds `at` precisely so
 * a half-recorded tombstone is unrepresentable. A resolver that only looked at
 * top-level keys would report `pair-absent` for exactly the sites that got the
 * strongest treatment.
 *
 * Returns `undefined` — never a default — for a path it cannot walk. The caller
 * turns that into a finding rather than a pass.
 */
function resolvePairSchema(
  schema: z.ZodTypeAny,
  path: string,
): z.ZodTypeAny | undefined {
  let cur: z.ZodTypeAny | undefined = schema
  for (const part of path.split('.')) {
    if (cur === undefined) return undefined
    const obj = unwrapSchema(cur)
    const shape = (obj as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape
    if (shape === undefined) return undefined
    cur = shape[part]
  }
  return cur === undefined ? undefined : unwrapSchema(cur)
}

/** Peel `.optional()` / `.nullable()` / `.default()`, which wrap a schema
 *  without replacing it. Bounded, so a pathological nesting cannot spin. */
function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur = schema
  for (let i = 0; i < 8; i++) {
    const def = cur._def as { typeName?: string; innerType?: z.ZodTypeAny }
    if (
      def.typeName === 'ZodOptional' ||
      def.typeName === 'ZodNullable' ||
      def.typeName === 'ZodDefault' ||
      def.typeName === 'ZodReadonly'
    ) {
      if (!def.innerType) return cur
      cur = def.innerType
      continue
    }
    return cur
  }
  return cur
}
