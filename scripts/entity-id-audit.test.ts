/**
 * THE DETECTOR ITSELF — planted violations, one per syntax form, each required
 * to FIRE and then required to STOP firing when it is removed.
 *
 * This suite exists because of a specific, repeated failure in this run: two zod
 * walkers found NOTHING and passed everything, four hours apart. POD-363's brand
 * derivation peeled PAST the brand with `ZodBranded.unwrap()` and matched
 * nothing while every downstream assertion stayed green; POD-640's probe keyed
 * on `safeParse().success`, which succeeds because zod STRIPS unknown keys.
 * `entity-id-audit.ts` is the same shape of instrument, so the standard here is
 * POD-305's: PLANT every spelling, require each to fire, and pin a non-trivial
 * COUNT that a broken walk cannot reach.
 *
 * The three things this file will not let the detector do:
 *
 *   1. **Report a serene zero.** {@link assertBrandsLoaded} must REFUSE an empty
 *      vocabulary, and `entityIdSites` must THROW below the population floor.
 *      An unexercised guard is indistinguishable from an absent one.
 *   2. **See one spelling only.** `sessionId`, `session_id`, `targetSessionId`,
 *      a quoted key, an `interface` member, a `.extend({…})` body, a nested
 *      block and a bare `id` on a brand-named declaration are all planted.
 *   3. **Be silenced by a rename.** The vocabulary is derived from the model, so
 *      renaming the *declaration* must change nothing.
 */

import { describe, expect, it } from 'vitest'
import {
  assertBrandsLoaded,
  brandOfKey,
  brandOfSymbol,
  classifyRhs,
  entityIdSites,
  ID_BRANDS,
  MIN_ID_FIELD_SITES,
  machineIdUnbrandedFields,
  REPRESENTATION_SUFFIXES,
  rawStringEntityIds,
  unbrandedByDecisionFields,
} from './entity-id-audit'
import type { AuditContext } from './rearch-audit'
import { loadContext, stripComments } from './rearch-audit'

/** A one-file in-memory context. `raw` carries the comments, because the excuse
 *  marker lives in one. */
const ctxOf = (source: string, file = 'packages/model/src/entities/planted.ts'): AuditContext => ({
  repoRoot: '/nonexistent',
  files: [{ file, stripped: stripComments(source), raw: source, isTest: false }],
  listDir: () => [],
})

const raw = (source: string): string[] =>
  rawStringEntityIds(ctxOf(SCAFFOLD + source)).map((s) => s.text)

/**
 * Enough real, BRANDED sites to clear the population floor, so a planted file
 * can be measured on its own. Deliberately branded: the floor must be cleared
 * without contributing to any counted class.
 */
const SCAFFOLD = Array.from(
  { length: MIN_ID_FIELD_SITES + 10 },
  (_, i) => `export const Scaffold${i} = z.object({ sessionId: SessionIdField })\n`,
).join('')

// ---------------------------------------------------------------------------
// The vocabulary is the MODEL's, not this file's
// ---------------------------------------------------------------------------

describe('the brand vocabulary', () => {
  it('loads the ratified set out of packages/model', () => {
    // Not `toBeGreaterThan(0)`: a partial import that yielded one brand would
    // pass that and silently stop seeing every other entity.
    expect(ID_BRANDS.length).toBeGreaterThanOrEqual(12)
    for (const brand of [
      'Session',
      'Issue',
      'Machine',
      'Repo',
      'Conversation',
      'Mutation',
      'Thread',
      'User',
    ]) {
      expect(ID_BRANDS).toContain(brand)
    }
  })

  it('REFUSES an empty vocabulary rather than reporting zero', () => {
    expect(() => assertBrandsLoaded([])).toThrow(/loaded EMPTY/)
    expect(() => assertBrandsLoaded(['Session'])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Key → brand: the concept, not eight names
// ---------------------------------------------------------------------------

describe('brandOfKey', () => {
  it('matches the plain spelling and the snake_case one', () => {
    expect(brandOfKey('sessionId')).toBe('Session')
    expect(brandOfKey('session_id')).toBe('Session')
  })

  it('matches a QUALIFIED id — the names POD-423 grep could not enumerate', () => {
    // This is the whole reason the detector is not a name list. Each of these is
    // a real site in the tree that the eight-name grep scored as absent.
    expect(brandOfKey('targetSessionId')).toBe('Session')
    expect(brandOfKey('lastSessionId')).toBe('Session')
    expect(brandOfKey('sourceMachineId')).toBe('Machine')
    expect(brandOfKey('deletedByIssueId')).toBe('Issue')
    expect(brandOfKey('parentConversationId')).toBe('Conversation')
  })

  it('does not match a key that merely ends in Id', () => {
    expect(brandOfKey('requestId')).toBeNull()
    expect(brandOfKey('transitionId')).toBeNull()
    // POLYMORPHIC by design (POD-362): its entity is decided by `targetKind`, so
    // branding it at the declaration forces a false choice. Out of scope on
    // purpose — this assertion is what stops a later sweep "fixing" it.
    expect(brandOfKey('targetId')).toBeNull()
    expect(brandOfKey('toId')).toBeNull()
  })
})

describe('brandOfSymbol', () => {
  it('reads a representation of the entity', () => {
    expect(brandOfSymbol('Account')).toBe('Account')
    expect(brandOfSymbol('SessionMeta')).toBe('Session')
    expect(brandOfSymbol('ConversationSummaryWire')).toBe('Conversation')
  })

  it('refuses a DIFFERENT entity that merely starts with a brand name', () => {
    // `IssueComment.id` is a COMMENT's id. POD-423 named it as a defect; it is
    // not one, and `startsWith` alone would have branded it `IssueId` — the
    // well-typed lie `brands.ts` warns about at `controllerId`.
    expect(brandOfSymbol('IssueComment')).toBeNull()
    expect(brandOfSymbol('SessionObservationCheckpoint')).toBeNull()
  })

  it('takes the LONGEST brand, so a run is not scored as its parent', () => {
    expect(brandOfSymbol('AutomationRunWire')).toBe('AutomationRun')
  })

  it("pins the suffix list, which is the detector's one judgement", () => {
    expect(REPRESENTATION_SUFFIXES).toContain('')
    expect(REPRESENTATION_SUFFIXES).toContain('Wire')
    expect(REPRESENTATION_SUFFIXES).not.toContain('Comment')
  })
})

// ---------------------------------------------------------------------------
// RHS classification
// ---------------------------------------------------------------------------

describe('classifyRhs', () => {
  it('separates a raw zod string from a branded one', () => {
    expect(classifyRhs('z.string()')).toBe('zod-string')
    expect(classifyRhs('z.string().min(1).max(256).nullable().optional()')).toBe('zod-string')
    expect(classifyRhs('SessionIdField')).toBe('zod-branded')
    expect(classifyRhs('SessionIdField.optional()')).toBe('zod-branded')
    expect(classifyRhs('z.string().min(1).pipe(SessionIdField)')).toBe('zod-branded')
    expect(classifyRhs('z.string().brand<"SessionId">()')).toBe('zod-branded')
  })

  it('survives the chain being reflowed across lines', () => {
    // biome reflows a long chain the moment one more `.max()` is added. A
    // line-anchored classifier silently reclassifies the site as `other` and the
    // count DROPS — this audit's own worst failure mode.
    expect(classifyRhs('z\n  .string()\n  .min(1)\n  .optional()')).toBe('zod-string')
  })

  it("does not read a NESTED string as the field's own type", () => {
    expect(classifyRhs('z.object({ nested: z.string() })')).toBe('other')
  })

  it('reads a wrapper around a raw string as raw', () => {
    expect(classifyRhs('z.union([z.string(), z.null()])')).toBe('zod-string')
  })

  it('names the carve-out marker and the other two forms', () => {
    expect(classifyRhs('machineIdBlockedOnPOD318.optional()')).toBe('carveout-marker')
    expect(classifyRhs('text("session_id").notNull()')).toBe('db-column')
    expect(classifyRhs('string')).toBe('ts-string')
  })
})

// ---------------------------------------------------------------------------
// PLANTED SPELLINGS — every one must FIRE
// ---------------------------------------------------------------------------

describe('the planted spellings', () => {
  it('finds a plain z.object member', () => {
    expect(raw('export const A = z.object({ sessionId: z.string() })')).toHaveLength(1)
  })

  it('finds a snake_case key', () => {
    expect(raw('export const A = z.object({ session_id: z.string() })')).toHaveLength(1)
  })

  it('finds a QUALIFIED key an eight-name grep cannot see', () => {
    expect(raw('export const A = z.object({ targetSessionId: z.string() })')).toHaveLength(1)
  })

  it('finds a quoted key', () => {
    expect(raw(`export const A = z.object({ 'issueId': z.string() })`)).toHaveLength(1)
  })

  it('finds a member of a .extend({…}) body', () => {
    expect(raw('export const A = Base.extend({ repoId: z.string() })')).toHaveLength(1)
  })

  it('finds a NESTED member, scored at its own depth', () => {
    expect(
      raw('export const A = z.object({ inner: z.object({ threadId: z.string() }) })'),
    ).toHaveLength(1)
  })

  it('finds a member reflowed across lines', () => {
    expect(
      raw('export const A = z.object({\n  mutationId: z\n    .string()\n    .optional(),\n})'),
    ).toHaveLength(1)
  })

  it('finds a bare `id` on a brand-named declaration', () => {
    expect(raw('export const Account = z.object({ id: z.string() })')).toHaveLength(1)
  })

  it('is NOT silenced by renaming the declaration', () => {
    // The vocabulary is the model's, so an identifier rename changes nothing.
    // A detector keyed on declaration NAMES is zeroable by a rename; this one is
    // not, and that is the property POD-368 paid for.
    expect(raw('export const WhateverYouLike = z.object({ issueId: z.string() })')).toHaveLength(1)
  })

  it('STOPS firing when the planted site is branded — the counterfactual', () => {
    // Every assertion above is worthless without this one: a detector that fires
    // on everything is as blind as one that fires on nothing.
    expect(raw('export const A = z.object({ sessionId: SessionIdField })')).toHaveLength(0)
    expect(
      raw('export const A = z.object({ sessionId: z.string().pipe(SessionIdField) })'),
    ).toHaveLength(0)
  })

  it('STAYS SILENT on a key that names no entity', () => {
    expect(
      raw('export const A = z.object({ requestId: z.string(), title: z.string() })'),
    ).toHaveLength(0)
  })

  it('STAYS SILENT on a bare `id` under a declaration that is a different entity', () => {
    expect(raw('export const IssueComment = z.object({ id: z.string() })')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The excuse marker, and the two carve-outs
// ---------------------------------------------------------------------------

describe('the UNBRANDED excuse', () => {
  const src = (comment: string) =>
    `export const A = z.object({\n  ${comment}\n  conversationId: z.string(),\n})`

  it('excuses a field whose doc comment carries the token', () => {
    expect(raw(src('/** UNBRANDED: the harness-native id. */'))).toHaveLength(0)
    expect(
      unbrandedByDecisionFields(ctxOf(SCAFFOLD + src('/** UNBRANDED: native. */'))),
    ).toHaveLength(1)
  })

  it('does NOT excuse on lowercase prose about branding', () => {
    // Otherwise any comment mentioning brands turns off the detector.
    expect(raw(src('/** we should probably brand this unbranded id one day */'))).toHaveLength(1)
  })

  it('does NOT excuse across a blank line — the comment must be attached', () => {
    expect(
      raw('export const A = z.object({\n  /** UNBRANDED */\n\n  conversationId: z.string(),\n})'),
    ).toHaveLength(1)
  })

  it('fails CLOSED when the raw source is unavailable', () => {
    // A context without `raw` cannot see comments; the safe reading is that
    // nothing is excused, never that everything is.
    const source = SCAFFOLD + src('/** UNBRANDED: native. */')
    const noRaw: AuditContext = {
      repoRoot: '/nonexistent',
      files: [{ file: 'packages/x/src/a.ts', stripped: stripComments(source), isTest: false }],
      listDir: () => [],
    }
    expect(rawStringEntityIds(noRaw)).toHaveLength(1)
  })
})

describe('the MachineId carve-out (ADR 1 Amendment 2 D16.2)', () => {
  it('keeps machine ids OUT of POD-301 count and IN their own', () => {
    const source = SCAFFOLD + 'export const A = z.object({ machineId: z.string() })'
    expect(rawStringEntityIds(ctxOf(source))).toHaveLength(0)
    expect(machineIdUnbrandedFields(ctxOf(source))).toHaveLength(1)
  })

  it('counts the sanctioned marker too — one debt, two spellings', () => {
    // D16.2 asks for "a narrower, VISIBLE debt". A carve-out nobody counts is
    // not visible, so the marker form is debt here even though it is correct.
    const source = SCAFFOLD + 'export const A = z.object({ machineId: machineIdBlockedOnPOD318 })'
    expect(machineIdUnbrandedFields(ctxOf(source))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// THE COUNT A BROKEN WALK CANNOT REACH
// ---------------------------------------------------------------------------

describe('the population floor', () => {
  it('THROWS rather than reporting a false zero when the scan collapses', () => {
    // The failure mode this whole file exists for: a walk that stops matching
    // reports zero, the ratchet reads a win, and the debt is banked as deleted.
    expect(() => entityIdSites(ctxOf('export const A = z.object({ a: z.string() })'))).toThrow(
      /below the .* floor/,
    )
  })

  it('clears the floor against the real tree, and by a wide margin', () => {
    const sites = entityIdSites(loadContext(process.cwd()))
    expect(sites.length).toBeGreaterThan(MIN_ID_FIELD_SITES)
    // Every counted form must be non-empty on the real tree. A form that has
    // silently stopped matching is invisible in a single total.
    for (const form of ['zod-branded', 'db-column', 'ts-string'] as const) {
      expect(sites.filter((s) => s.form === form).length).toBeGreaterThan(20)
    }
  })
})
