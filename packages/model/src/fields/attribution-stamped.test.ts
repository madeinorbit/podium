/**
 * THE STAMPED PAIR — one shape, and a census that can see a fourth site
 * (POD-1156).
 *
 * `{at, by: Attribution}` was hand-written at each site that needed it. The
 * principal half could never fork — every site names the ONE `Attribution`
 * instance and `legacyAttributionViolations` already checks that by identity —
 * but the PAIRING had no definition at all, and nothing in this repo could see a
 * fourth site name the timestamp `stampedAt`, make it `.optional()`, or nest it
 * the other way round:
 *
 *   - the golden corpora pin the ENCODING OF VALUES someone chose to write, so a
 *     restatement of the same two keys is byte-identical to them;
 *   - `legacyAttributionViolations` resolves each pair at a per-site DECLARED
 *     path (`asked.attribution`, `deleted.by`), so a site is checked against its
 *     own spelling and can never disagree with it;
 *   - typecheck is blind by construction — two `z.object`s with the same members
 *     are the same type.
 *
 * So this file does two things that need each other. The first half asserts
 * composition by REFERENCE IDENTITY (`toBe`, never `toEqual`) at the sites that
 * compose it, and locks their key ORDER, because both sites are persisted and
 * replicated and a reorder is exactly the change that moves bytes while moving
 * no types. The second half is a CENSUS: it walks every schema the model
 * exports, finds every NESTED object carrying the shared `Attribution`, and
 * requires each one to be either the shared pair or a deviation declared here by
 * schema identity. A fourth site is a new entry or a failure — never silence.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HandoffManifestV2 } from '../entities/handoff'
import * as model from '../index'
import { Attribution, StampedAttribution } from './attribution'
import { NeedsHuman } from './issue'
import { SessionTombstone } from './session'

// ---------------------------------------------------------------------------
// The shape itself
// ---------------------------------------------------------------------------

describe('StampedAttribution', () => {
  it('carries the ONE shared Attribution instance, not a look-alike', () => {
    // `toBe`, not `toEqual`: branding is compile-time and a restated pair is
    // byte-identical, so identity is the only instrument that can see a copy.
    expect(StampedAttribution.shape.by).toBe(Attribution)
  })

  it('is `{at, by}` in that order, and nothing else', () => {
    expect(Object.keys(StampedAttribution.shape)).toEqual(['at', 'by'])
  })

  it('cannot record WHEN without WHO', () => {
    // The whole mechanism (ADR 9 D5 A3, POD-365): the timestamp lives INSIDE the
    // object carrying the principal, and neither half is optional.
    expect(StampedAttribution.safeParse({ at: '2026-01-01T00:00:00.000Z' }).success).toBe(false)
    expect(
      StampedAttribution.safeParse({
        at: '2026-01-01T00:00:00.000Z',
        by: { actor: { kind: 'system', job: 'steward' }, onBehalfOf: null },
      }).success,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The sites that compose it
// ---------------------------------------------------------------------------

describe('the sites compose the shared pair', () => {
  it('HandoffManifestV2.exported IS the shared instance', () => {
    expect(HandoffManifestV2.shape.exported).toBe(StampedAttribution)
  })

  it('SessionTombstone.deleted names both members by identity', () => {
    const deleted = SessionTombstone.shape.deleted.unwrap()
    expect(deleted.shape.at).toBe(StampedAttribution.shape.at)
    expect(deleted.shape.by).toBe(StampedAttribution.shape.by)
  })

  // WIRE ORDER. Both sites are persisted and replicated, and `.extend()` appends
  // — so extending the pair with the tombstone's own keys would re-emit this
  // object as `{at, by, source, byIssueId}`: no type changes, no golden fixture
  // that pins a written value changes, and the encoded bytes move. This is the
  // instrument that refuses that, and it is why the members are named
  // positionally rather than extended.
  it('SessionTombstone.deleted keeps its wire order, pair members interleaved', () => {
    expect(Object.keys(SessionTombstone.shape.deleted.unwrap().shape)).toEqual([
      'at',
      'source',
      'by',
      'byIssueId',
    ])
  })

  it('HandoffManifestV2.exported keeps its wire order', () => {
    expect(Object.keys(HandoffManifestV2.shape.exported.shape)).toEqual(['at', 'by'])
  })
})

// ---------------------------------------------------------------------------
// The one site that deliberately does NOT compose it
// ---------------------------------------------------------------------------

/**
 * `NeedsHuman.asked` pairs when-and-who inseparably, in POD-365's own nesting,
 * but not in this shape: its `by` is the asking SESSION — kept that way because
 * it is also the DELIVERY ADDRESS the registry routes the answer to — and the
 * principal pair sits beside it at `attribution`. Composing `StampedAttribution`
 * here would mean RENAMING two keys on a persisted shape to remove one
 * duplicated `z.string()`, which is strictly the worse trade.
 *
 * Declared by SCHEMA IDENTITY rather than by path, so the exemption follows the
 * one object it was granted for and cannot be inherited by a look-alike.
 */
const ASKED = NeedsHuman.shape.asked.unwrap()

const DECLARED_DEVIATIONS: ReadonlyMap<z.ZodTypeAny, string> = new Map([
  [
    ASKED as z.ZodTypeAny,
    "`asked.by` is the asking SESSION and the answer's delivery address (POD-365); the " +
      'principal pair sits at `asked.attribution`. Renaming two keys on a persisted shape to ' +
      'compose the stamped pair costs more than the duplicated `z.string()` it removes.',
  ],
])

describe('NeedsHuman.asked, the declared deviation', () => {
  // Pinned so the deviation stays a DECISION. Without this, "tidying" the site
  // into the shared pair reads as an improvement right up until a replica that
  // still speaks `asked.attribution` fails to parse.
  it('keeps its own spelling, and still names the ONE Attribution instance', () => {
    expect(Object.keys(ASKED.shape)).toEqual(['question', 'options', 'at', 'by', 'attribution'])
    expect(ASKED.shape.attribution).toBe(Attribution)
    expect(ASKED.shape.at).not.toBe(StampedAttribution.shape.at)
  })
})

// ---------------------------------------------------------------------------
// The census — what makes a FOURTH site visible
// ---------------------------------------------------------------------------

export interface StampedSiteViolation {
  readonly path: string
  readonly kind: 'not-composed'
  readonly detail: string
}

/** Peel the wrappers that do not change the identity of the thing underneath. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
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

/** The schemas reachable from one member, through the containers that can hold
 *  an object without being one. Bounded; a schema graph with a cycle would
 *  otherwise spin, and `seen` alone does not help across arms. */
function children(schema: z.ZodTypeAny): z.ZodTypeAny[] {
  const def = schema._def as {
    typeName?: string
    type?: z.ZodTypeAny
    valueType?: z.ZodTypeAny
    options?: z.ZodTypeAny[]
    left?: z.ZodTypeAny
    right?: z.ZodTypeAny
  }
  switch (def.typeName) {
    case 'ZodArray':
      return def.type ? [def.type] : []
    case 'ZodRecord':
      return def.valueType ? [def.valueType] : []
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return def.options ? [...def.options] : []
    case 'ZodIntersection':
      return [def.left, def.right].filter((s): s is z.ZodTypeAny => s !== undefined)
    default:
      return []
  }
}

/** Does this object carry the shared pair as one of its own members? */
function carriesAttribution(obj: z.ZodObject<z.ZodRawShape>): boolean {
  return Object.values(obj.shape).some((member) => unwrap(member) === Attribution)
}

/**
 * Every NESTED object that carries the shared `Attribution`, reached from the
 * given roots.
 *
 * NESTED is the whole selector, and it is what keeps the census honest rather
 * than noisy. A top-level field group or aggregate carrying `Attribution` beside
 * its own `createdAt` (`IssueLifecycle`, `SessionAggregate`) is not a stamped
 * pair — nothing claims those two keys are one fact, and POD-365 deliberately
 * did not nest them. The stamped idiom is by construction a small object that
 * exists to hold when-and-who together, and such an object is always a MEMBER of
 * something else. So the roots themselves are never sites; their members are.
 */
function stampedSites(roots: readonly (readonly [string, z.ZodTypeAny])[]): {
  path: string
  schema: z.ZodObject<z.ZodRawShape>
}[] {
  const out: { path: string; schema: z.ZodObject<z.ZodRawShape> }[] = []
  const seen = new Set<z.ZodTypeAny>()

  const visit = (schema: z.ZodTypeAny, path: string, depth: number): void => {
    if (depth > 8) return
    const inner = unwrap(schema)
    if (seen.has(inner)) return
    seen.add(inner)
    for (const child of children(inner)) visit(child, path, depth + 1)
    if (!(inner instanceof z.ZodObject)) return
    for (const [key, member] of Object.entries(inner.shape as z.ZodRawShape)) {
      const memberInner = unwrap(member)
      if (memberInner instanceof z.ZodObject && carriesAttribution(memberInner)) {
        out.push({ path: `${path}.${key}`, schema: memberInner })
      }
      visit(member, `${path}.${key}`, depth + 1)
    }
  }

  for (const [name, schema] of roots) visit(schema, name, 0)
  return out
}

/**
 * THE CHECK. Empty result = every nested site carrying the pair is either the
 * shared {@link StampedAttribution} — by instance, or by naming its two members
 * positionally where it must interleave its own keys — or a deviation declared
 * above with a reason.
 *
 * Takes its roots as a PARAMETER so the test below can run it over a fixture
 * carrying a look-alike and watch it fail. A check that could only ever run over
 * the real, correct exports would be a check nobody has seen say no.
 */
export function stampedAttributionViolations(
  roots: readonly (readonly [string, z.ZodTypeAny])[],
): StampedSiteViolation[] {
  const out: StampedSiteViolation[] = []
  for (const site of stampedSites(roots)) {
    if (site.schema === StampedAttribution) continue
    if (DECLARED_DEVIATIONS.has(site.schema)) continue
    const composes =
      site.schema.shape.at === StampedAttribution.shape.at &&
      site.schema.shape.by === StampedAttribution.shape.by
    if (composes) continue
    out.push({
      path: site.path,
      kind: 'not-composed',
      detail:
        `nests the shared Attribution in \`{${Object.keys(site.schema.shape).join(', ')}}\` ` +
        'without composing StampedAttribution (POD-1156). The pairing — the timestamp named ' +
        '`at`, required, INSIDE the object naming the principal — is the part no golden fixture ' +
        'and no typecheck can see: a restatement is byte-identical. Compose the shared members ' +
        '(positionally, if this object interleaves its own keys — `.extend()` appends and would ' +
        'reorder the wire), or declare the deviation with its reason in DECLARED_DEVIATIONS.',
    })
  }
  return out
}

/** Every zod object the model exports, as census roots. */
const MODEL_ROOTS: readonly (readonly [string, z.ZodTypeAny])[] = Object.entries(
  model as Record<string, unknown>,
)
  .filter((entry): entry is [string, z.ZodTypeAny] => entry[1] instanceof z.ZodType)
  .map(([name, schema]) => [name, schema] as const)

describe('the stamped-attribution census', () => {
  it('reaches the sites it exists to check', () => {
    // A census that found nothing would pass vacuously — the Phase 6 gate's
    // first probe deleted from an empty collection and reported the guard sound.
    const paths = stampedSites(MODEL_ROOTS).map((s) => s.path)
    expect(paths.some((p) => p.endsWith('.deleted'))).toBe(true)
    expect(paths.some((p) => p.endsWith('.exported'))).toBe(true)
    expect(paths.some((p) => p.endsWith('.asked'))).toBe(true)
  })

  it('finds no undeclared stamped site in the whole model vocabulary', () => {
    expect(stampedAttributionViolations(MODEL_ROOTS)).toEqual([])
  })

  // The three ways a fourth site drifts, each run through the real check. The
  // second is the one that matters most: it is byte-identical to the shared
  // pair, so every other instrument in this repo passes it.
  it.each([
    [
      'renames the timestamp',
      z.object({ site: z.object({ stampedAt: z.string(), by: Attribution }) }),
    ],
    [
      'restates the same two keys',
      z.object({ site: z.object({ at: z.string(), by: Attribution }) }),
    ],
    [
      'makes the timestamp optional',
      z.object({ site: z.object({ at: z.string().optional(), by: Attribution }) }),
    ],
  ])('says no to a fourth site that %s', (_label, fixture) => {
    const found = stampedAttributionViolations([['fixture', fixture]])
    expect(found.map((v) => v.path)).toEqual(['fixture.site'])
    expect(found[0]?.kind).toBe('not-composed')
  })

  it('says yes to a fourth site that composes the shared pair', () => {
    const composed = z.object({ site: StampedAttribution })
    expect(stampedAttributionViolations([['fixture', composed]])).toEqual([])
  })

  it('says yes to an interleaving site that names the members positionally', () => {
    // The tombstone's own pattern, as a fixture: this is what "the extension
    // must stay expressible" has to keep meaning.
    const interleaved = z.object({
      site: z.object({
        at: StampedAttribution.shape.at,
        source: z.enum(['issue', 'standalone']),
        by: StampedAttribution.shape.by,
      }),
    })
    expect(stampedAttributionViolations([['fixture', interleaved]])).toEqual([])
  })
})
