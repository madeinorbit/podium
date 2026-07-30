/**
 * SETTINGS — THE TOTAL CLASSIFICATION (POD-418, 3.7a).
 *
 * Every leaf of the settings blob belongs to exactly one of three tiers, and
 * each tier is one ADR 1 matrix row. This module answers, for any settings path:
 * which row, which ADR 9 D3 visibility class, which ADR 1 D6 secret class, may
 * it replicate, and may the outbox enqueue a write to it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TABLE IS DERIVED AND NOT WRITTEN DOWN
 * ---------------------------------------------------------------------------
 *
 * {@link SETTINGS_CLASSIFICATION} is computed by WALKING the split shapes in
 * `./preferences.ts` and `./secrets.ts`. It is not a hand-maintained list of
 * path strings, because a hand list has the failure mode this whole run keeps
 * paying for: a field added to a shape is simply absent from the list, the
 * default-closed backstop answers for it, and "deliberately private" and "never
 * classified" become the same green.
 *
 * So totality is enforced by three instruments that fail in different ways, and
 * every one of them has a planted-fixture case proving it can say NO:
 *
 *   1. **Derivation** (here). A leaf that is in no split shape is in no
 *      classification. That alone proves nothing — an empty walker classifies
 *      nothing and every "no secret leaked" claim then passes vacuously — so
 *      `classification.test.ts` pins known deep paths (`roles.coding.model`) and
 *      a negative control, per the POD-363 rule that an instrument whose job is
 *      to FIND things must first be shown to find something.
 *   2. **Reconciliation** (`packages/runtime/src/settings.classification.test.ts`).
 *      The leaves of the LIVE `PodiumSettings` blob and the classified paths must
 *      be the same set, in BOTH directions. This is the instrument that can see a
 *      field added to the blob and to no tier — the failure that a derivation
 *      inside the model cannot see, because the model cannot import the blob.
 *   3. **Backstop** ({@link settingsPathMayReplicate} /
 *      {@link settingsPathMayEnqueue}). The SEMANTIC half, which holds even if
 *      every test were deleted. It is deliberately NOT the same mechanism as the
 *      totality check, per ADR 9 D4 point 2 and the `visibilityClassOf` shape.
 *
 * ---------------------------------------------------------------------------
 * WHICH WAY "DEFAULT-CLOSED" POINTS HERE
 * ---------------------------------------------------------------------------
 *
 * For VISIBILITY, default-closed means an unclassified class is `personal`
 * (ADR 9 D4) — the least exposure.
 *
 * For this module the same instinct points somewhere else, and the difference
 * matters. An unknown settings path might be a secret nobody classified, so the
 * safe answer to "may this replicate?" and "may the outbox hold it?" is **no**.
 * That is what {@link settingsPathMayReplicate} and {@link settingsPathMayEnqueue}
 * return for a path they have never heard of. It is the shape ADR 1 D6 requires:
 * refusing to replicate an unclassified preference is an inconvenience; happily
 * replicating an unclassified secret is a leak.
 *
 * And the trap the coordinator named tonight is avoided by construction:
 * {@link classifySettingsPath} returns `undefined` for an unknown path rather
 * than a default tier, so "unclassified" is DISTINGUISHABLE from "deliberately
 * personal". The safe answer lives in the backstop functions; the honest
 * "I don't know" lives in the lookup. Collapsing them is precisely how an
 * unclassified entity class went unnoticed.
 */

import type { z } from 'zod'
import { OWNERSHIP_MATRIX_INDEX, ROW } from '../annotations/matrix'
import type { MatrixRow, MatrixRowId, OfflineClass, SecretClass, VisibilityClass } from '../annotations/ownership'
import { InstancePreferences, PersonalPreferences } from './preferences'
import { LEGACY_IN_BLOB_SECRET_GROUPS } from './secrets'

// ---------------------------------------------------------------------------
// The tiers, and their matrix rows
// ---------------------------------------------------------------------------

/**
 * The three tiers of the split. A `const` array so the type and every totality
 * check derive from one list.
 *
 * There is no fourth and no "unset": a leaf that fits none of these is a
 * question for the ADR pack, not a value to invent here. {@link
 * classifySettingsPath} answers `undefined` for one, which is what makes it
 * findable.
 */
export const SETTINGS_TIERS = ['personal-preference', 'instance-preference', 'server-secret'] as const
export type SettingsTier = (typeof SETTINGS_TIERS)[number]

/**
 * Tier → the ADR 1 matrix row that DECIDES it. Every column below is read off
 * the shipped row rather than restated here, so the classification cannot drift
 * from the matrix: change the matrix and this module changes with it, which is
 * the POD-305 "bind to the SHIPPED matrix" shape.
 */
export const SETTINGS_TIER_ROW: Readonly<Record<SettingsTier, MatrixRowId>> = {
  'personal-preference': ROW.preferencesPersonal,
  'instance-preference': ROW.preferencesInstance,
  'server-secret': ROW.serverSecrets,
}

/** The shipped matrix row for a tier. Throws rather than returning a default:
 *  a tier whose row is missing is a broken build, not a classification. */
export function settingsTierRow(tier: SettingsTier): MatrixRow {
  const row = OWNERSHIP_MATRIX_INDEX.get(SETTINGS_TIER_ROW[tier])
  if (!row) throw new Error(`settings tier '${tier}' names matrix row '${SETTINGS_TIER_ROW[tier]}', which does not exist`)
  return row
}

// ---------------------------------------------------------------------------
// The classification record
// ---------------------------------------------------------------------------

/** One settings leaf, fully classified. Every field but `path` and `tier` is
 *  READ OFF the matrix row — see {@link settingsTierRow}. */
export interface SettingsClassification {
  /** The dotted path the leaf occupies in the settings blob. */
  readonly path: string
  readonly tier: SettingsTier
  readonly matrixRow: MatrixRowId
  readonly visibility: VisibilityClass
  readonly secret: SecretClass
  readonly offline: OfflineClass
  /** May the value reach a replica at all? `false` for `secret-value`. */
  readonly replicates: boolean
  /** May an offline client's outbox hold a write to this leaf? `false` for
   *  `never-enqueue` — POD-352's rule, which is why the outbox must refuse the
   *  CLASS rather than inspect a payload. */
  readonly mayEnqueue: boolean
}

// ---------------------------------------------------------------------------
// Leaf enumeration
// ---------------------------------------------------------------------------

type ZodDef = {
  typeName?: string
  innerType?: z.ZodTypeAny
  schema?: z.ZodTypeAny
}

const defOf = (schema: z.ZodTypeAny): ZodDef => schema._def as ZodDef

/** Peel the wrappers that do not change the key set. Same peel as
 *  `annotations/capability-snapshot.ts` — and deliberately a SEPARATE walk,
 *  because that one reports the paths that MATCH a name pattern while this one
 *  reports every LEAF. A walker that stopped early would silently under-report
 *  here, where under-reporting means "unclassified". */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = defOf(schema)
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
      return def.innerType ? unwrap(def.innerType) : schema
    case 'ZodEffects':
      return def.schema ? unwrap(def.schema) : schema
    default:
      return schema
  }
}

/**
 * Leaves that are OPEN CONTAINERS: an object whose keys are data rather than
 * vocabulary. `experimental` is a `z.record` of feature ids, so its members
 * cannot be enumerated and must not be — a build may meet a blob written by
 * another build.
 *
 * Recorded as a named list rather than handled silently, because "this leaf is
 * classified as a whole" and "this leaf's members are unclassified" look
 * identical from the outside otherwise. The classification of an open record is
 * a claim about EVERY key it can ever hold, which is only sound because the tier
 * it sits in (`instance-preference`) is the same for all of them.
 */
export const SETTINGS_OPEN_RECORD_LEAVES = ['experimental'] as const

/**
 * Every leaf path of a schema, dotted. An object stops the recursion only when
 * it has no members; a record, an array and a scalar are all leaves.
 *
 * `skip` drops key names that are structural rather than content — the `userId`
 * of {@link PersonalPreferences} is the ROW KEY, not a preference, and
 * classifying it as one would make the reconciliation against the live blob
 * fail for a key the blob correctly does not have.
 */
export function settingsLeafPaths(
  schema: z.ZodTypeAny,
  prefix = '',
  skip: readonly string[] = [],
): string[] {
  const inner = unwrap(schema)
  const def = defOf(inner)
  if (def.typeName !== 'ZodObject') return prefix ? [prefix] : []

  const shape = (inner as unknown as z.AnyZodObject).shape
  const out: string[] = []
  for (const [key, child] of Object.entries(shape)) {
    if (!prefix && skip.includes(key)) continue
    const path = prefix ? `${prefix}.${key}` : key
    out.push(...settingsLeafPaths(child as z.ZodTypeAny, path))
  }
  return out
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

function classify(tier: SettingsTier, path: string): SettingsClassification {
  const row = settingsTierRow(tier)
  return {
    path,
    tier,
    matrixRow: row.id,
    visibility: row.visibility,
    secret: row.secret,
    offline: row.offline,
    // Read off the row, never asserted here: `replication: 'none'` IS the
    // never-replicated property, and `offline: 'never-enqueue'` IS the
    // never-queued one. A matrix edit that weakened either would change these
    // answers, which is why `classification.test.ts` pins both on the secret row.
    replicates: row.replication !== 'none',
    mayEnqueue: row.offline !== 'never-enqueue' && row.offline !== 'online-only',
  }
}

/**
 * THE TABLE — every settings leaf, classified, derived from the split shapes.
 *
 * Order is personal, then instance, then secret; within a tier it is the shapes'
 * own declaration order. Nothing reads the order, but a stable one makes the
 * diff of an added field legible.
 */
export const SETTINGS_CLASSIFICATION: readonly SettingsClassification[] = [
  ...settingsLeafPaths(PersonalPreferences, '', ['userId']).map((p) =>
    classify('personal-preference', p),
  ),
  ...settingsLeafPaths(InstancePreferences).map((p) => classify('instance-preference', p)),
  ...LEGACY_IN_BLOB_SECRET_GROUPS.flatMap((g) =>
    settingsLeafPaths(g.schema, g.prefix).map((p) => classify('server-secret', p)),
  ),
]

/** Index by path. Built from the table, so a duplicate path would collapse here
 *  — `classification.test.ts` asserts the sizes match rather than trusting it. */
export const SETTINGS_CLASSIFICATION_INDEX: ReadonlyMap<string, SettingsClassification> = new Map(
  SETTINGS_CLASSIFICATION.map((c) => [c.path, c]),
)

/**
 * The classification of a settings path, or `undefined` when there is none.
 *
 * `undefined` IS the point. A default here would make an unclassified leaf
 * indistinguishable from a deliberately-personal one, which is the exact shape
 * that let an entity class go unclassified without any gate noticing. The safe
 * ANSWER for an unknown path lives in {@link settingsPathMayReplicate} and
 * {@link settingsPathMayEnqueue}; the honest "I have never heard of this" lives
 * here.
 */
export function classifySettingsPath(path: string): SettingsClassification | undefined {
  return SETTINGS_CLASSIFICATION_INDEX.get(path)
}

/**
 * May this settings leaf's VALUE reach a replica?
 *
 * FAILS CLOSED: an unknown path answers `false`, because an unknown path may be
 * a secret nobody classified. Refusing to replicate an unclassified preference
 * costs a round trip; replicating an unclassified secret is ADR 1 D6 violated.
 */
export function settingsPathMayReplicate(path: string): boolean {
  return classifySettingsPath(path)?.replicates ?? false
}

/**
 * May an offline client's outbox hold a write to this settings leaf?
 *
 * FAILS CLOSED, same reasoning. POD-352 is the case: a generic offline
 * `settings.set` would persist secrets into browser and mobile replica storage
 * AND into the outbox. The refusal must be by CLASS — a payload inspection that
 * looked for secret-shaped keys would be a detector, and a detector that misses
 * one key fails open.
 */
export function settingsPathMayEnqueue(path: string): boolean {
  return classifySettingsPath(path)?.mayEnqueue ?? false
}

/** Every path in one tier. For POD-419's scrub (which needs the secret set) and
 *  POD-420's contracts (which need the per-tier command surface). */
export function settingsPathsInTier(tier: SettingsTier): string[] {
  return SETTINGS_CLASSIFICATION.filter((c) => c.tier === tier).map((c) => c.path)
}
