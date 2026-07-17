import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Issue } from './aggregate'
import {
  type IssuePanel,
  issueDurableShape,
  issueNeedsHumanFields,
  issueSyncFields,
} from './fields'
import { IssueStorageRow, issueStorageOverrides } from './storage'
import { IssueProjection, issueDerivedWireFields } from './wire'

/**
 * COMPOSITION CHECKS [ADR 4 §7: "New entity fields land once in `packages/model`
 * field schemas"; "Every representation that needs the field composes it (or
 * deliberately omits it)"; "No new hand-restated session/issue field lists"].
 *
 * The compile-level half of these is the `satisfies`/type-assignment blocks: they
 * fail `tsgo --noEmit` — not this test run — if a representation stops deriving
 * from the vocabulary. The runtime half checks the properties types cannot state:
 * that the key SETS actually line up, so nobody can quietly `.extend()` a fresh
 * field onto a representation instead of adding it to a group.
 */

// ---- Compile-level: the representations derive from the shared shape ----
//
// Each of these is a type error the moment a representation is hand-written
// instead of composed. They are values only so the file typechecks; the assertion
// is the annotation.

/** Mutual assignability — `A` and `B` must be the SAME type, not merely compatible. */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

/** R1 IS the durable shape — not a lookalike of it. */
const _r1DerivesFromVocabulary: z.ZodObject<typeof issueDurableShape> = Issue

/** Every needs-human key reaches R1 with its group's exact schema (D3.1/D3.3). */
const _needsHumanGroupReachesR1: {
  [K in keyof typeof issueNeedsHumanFields]: (typeof issueDurableShape)[K]
} = issueNeedsHumanFields

/** The revision token reaches R1 as a durable field (ADR 2 D3). */
const _revisionIsDurable: (typeof issueDurableShape)['revision'] = issueSyncFields.revision

/** R4's non-derived half is R1's field set with nulls turned to absences — so a
 *  field added to a group cannot fail to reach the wire. */
type WireDurableKeys = Exclude<keyof IssueProjection, keyof typeof issueDerivedWireFields>
const _r4CoversR1: Record<keyof Issue, true> = {} as Record<WireDurableKeys, true>
const _r1CoversR4: Record<WireDurableKeys, true> = {} as Record<keyof Issue, true>

/** R3 is R1 plus the declared overrides — nothing else. */
type StorageKeys = keyof IssueStorageRow
const _r3CoversR1: Record<keyof Issue, true> = {} as Record<StorageKeys, true>
const _r1CoversR3: Record<StorageKeys, true> = {} as Record<keyof Issue, true>

/**
 * The panel is a structured value in R1 and JSON TEXT in R3 — the one JSON split.
 *
 * Stated through INFERRED types, and reached through `issueDurableShape` /
 * `issueStorageOverrides` (both of which this file also uses at runtime) rather
 * than through a `typeof` on an otherwise-unused import. That is not fussiness:
 * biome's `useImportType` counts a `typeof`-only usage as type-only and rewrites
 * the import to `import { type X }`, at which point `typeof X` no longer has a
 * value to refer to and the package stops compiling. Keeping every `typeof` here
 * anchored to a binding with a real runtime use makes `biome check --write` a
 * no-op on this file instead of a breakage.
 */
const _panelIsStructuredInR1: Exactly<
  z.infer<typeof issueDurableShape.panel>,
  IssuePanel | null
> = true
const _panelIsTextInR3: Exactly<z.infer<typeof issueStorageOverrides.panel>, string | null> = true

describe('representations compose from the vocabulary', () => {
  const durableKeys = Object.keys(issueDurableShape)

  it('R1 declares no field of its own', () => {
    expect(Object.keys(Issue.shape).sort()).toEqual([...durableKeys].sort())
  })

  it('R4 is exactly the durable field set plus the declared derived fields', () => {
    // The teeth: an `.extend()` of a fresh field onto the projection fails here,
    // which is what forces a new field to enter through a group instead.
    expect(Object.keys(IssueProjection.shape).sort()).toEqual(
      [...durableKeys, ...Object.keys(issueDerivedWireFields)].sort(),
    )
  })

  it('R3 is exactly the durable field set — overrides re-encode, never add', () => {
    expect(Object.keys(IssueStorageRow.shape).sort()).toEqual([...durableKeys].sort())
    // ...and every override names a field that actually exists in the vocabulary.
    for (const key of Object.keys(issueStorageOverrides)) expect(durableKeys).toContain(key)
  })

  it('carries the whole needs-human group, together, into every representation', () => {
    // ADR 4 D3.1's worked example: these five keys are one unit and must not drift
    // apart one representation at a time.
    for (const key of Object.keys(issueNeedsHumanFields)) {
      expect(Issue.shape).toHaveProperty(key)
      expect(IssueProjection.shape).toHaveProperty(key)
      expect(IssueStorageRow.shape).toHaveProperty(key)
    }
  })

  it('brands every cross-entity reference rather than typing it as a bare string', () => {
    // D3.5: "Raw `z.string()` entity ids in model/projection schemas are audit
    // failures after the flip." Proven by behaviour: a branded id rejects '' via
    // its `.min(1)`, which a bare `z.string()` would accept.
    for (const idKey of ['id', 'parentId', 'repoId', 'machineId', 'humanQuestionAskedBy']) {
      const field = issueDurableShape[idKey as keyof typeof issueDurableShape]
      expect(field.safeParse('').success, `${idKey} accepts an empty string`).toBe(false)
    }
  })
})

describe('the wire nullability rule is applied mechanically', () => {
  const wireField = (key: string) =>
    IssueProjection.shape[key as keyof typeof IssueProjection.shape]
  /** The two fields deliberately wrapped in `.catch()` — see `wire.ts`. */
  const isTolerant = (key: string) => wireField(key) instanceof z.ZodCatch

  it('turns exactly the nullable durable fields into optional wire fields', () => {
    for (const [key, field] of Object.entries(issueDurableShape)) {
      expect
        .soft(wireField(key).isOptional(), `${key}: wire optionality must follow R1 nullability`)
        .toBe(field.isNullable())
    }
  })

  it('lets no untolerated field be null on the wire, so unset has ONE spelling', () => {
    // If `null` and absent were both legal spellings of unset, the round-trip would
    // stop being a bijection: two wire values would map to one aggregate value.
    for (const [key, field] of Object.entries(issueDurableShape)) {
      if (!field.isNullable() || isTolerant(key)) continue
      expect.soft(wireField(key).isNullable(), `${key} is null-able on wire`).toBe(false)
    }
  })

  it('normalizes a null on a TOLERANT field to absent rather than carrying it', () => {
    // The exception, stated exactly rather than papered over: `.catch()` accepts
    // ANY input by construction — that is what makes it tolerant — so a tolerant
    // field cannot also reject `null`. What preserves the bijection is not that
    // null is rejected but that it can never survive as a VALUE: `toWire` never
    // emits one (it drops nulls), and an inbound null normalizes to absent, which
    // `fromWire` restores to null. Both wire spellings land on the same aggregate.
    const tolerant = Object.keys(issueDurableShape).filter(isTolerant)
    expect(tolerant).toEqual(['color', 'humanQuestionOptions'])
    for (const key of tolerant) {
      expect.soft(wireField(key).parse(null), `${key} normalizes null to absent`).toBeUndefined()
    }
  })
})
