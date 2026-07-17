import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { minimalIssue, populatedIssue } from './__fixtures__/issues'
import { issueDurableShape } from './fields'
import { fromStorage, fromWire, toStorage, toWire } from './mapping'
import { IssueProjection } from './wire'

const cases = [
  ['populated', populatedIssue],
  ['all-nulls', minimalIssue],
] as const

describe('the Issue mapping pair round-trips', () => {
  it.each(cases)('fromWire(toWire(%s)) is the identity', (_name, issue) => {
    expect(fromWire(toWire(issue))).toEqual(issue)
  })

  it.each(cases)('fromStorage(toStorage(%s)) is the identity', (_name, issue) => {
    expect(fromStorage(toStorage(issue))).toEqual(issue)
  })
})

describe('the R1→R4 nullability convention', () => {
  it('omits every null field rather than emitting an explicit null', () => {
    const wire = toWire(minimalIssue)
    const nulls = Object.entries(wire).filter(([, v]) => v === null)
    expect(nulls).toEqual([])
    // ...and they are genuinely ABSENT, not present-and-undefined, so they never
    // reach the payload at all.
    expect(Object.hasOwn(wire, 'deletedAt')).toBe(false)
    expect(Object.hasOwn(wire, 'panel')).toBe(false)
  })

  it('restores a null for each absent field on the way back', () => {
    expect(fromWire(toWire(minimalIssue)).deletedAt).toBeNull()
  })

  it("preserves an empty string, which today's truthiness-based serializer drops", () => {
    // `...(row.linearIdentifier ? {...} : {})` would omit this, and `''` would read
    // back as null. The regression this pins is a real behavioural divergence the
    // POD-796 cutover had to dispose of, not a hypothetical.
    //
    // DISPOSED [POD-796]: accepted — this behaviour ships. Measured against the
    // live DB (793 issues) rather than argued: the entire divergence surface is
    // `assignee = ''` on 2 rows, where '' and absent render identically under a
    // truthiness check. (`description = ''` on 146 rows is NOT affected — today's
    // serializer passes description through unconditionally.) Making `null` the one
    // spelling for absent is right, but it is a write-path data migration across
    // every nullable text field — POD-820, deliberately outside a reversible
    // flag-gated cutover.
    expect(populatedIssue.linearIdentifier).toBe('')
    const wire = toWire(populatedIssue)
    expect(wire.linearIdentifier).toBe('')
    expect(fromWire(wire).linearIdentifier).toBe('')
  })
})

describe('the R1↔R3 JSON-column split', () => {
  it('encodes the structured panel to a JSON text column and back', () => {
    const row = toStorage(populatedIssue)
    expect(typeof row.panel).toBe('string')
    expect(JSON.parse(row.panel as string)).toEqual(populatedIssue.panel)
    expect(fromStorage(row).panel).toEqual(populatedIssue.panel)
  })

  it('keeps a null panel as a NULL column, not the string "null"', () => {
    expect(toStorage(minimalIssue).panel).toBeNull()
  })

  it('refuses a corrupt panel column instead of degrading it to an empty panel', () => {
    // Today's reader swallows this into `{todos:[],artifacts:[],deferred:[]}`, which
    // makes a corrupt panel indistinguishable from an empty one at every call site.
    const row = { ...toStorage(populatedIssue), panel: '{ not json' }
    expect(() => fromStorage(row)).toThrow(/not valid JSON/)
  })
})

describe('the R3 enum widening', () => {
  it('narrows the widened TEXT columns back to their enums', () => {
    const row = toStorage(populatedIssue)
    // Widened at the row boundary — sqlite hands back a string...
    expect(row.stage).toBe('in_progress')
    // ...and narrowed by the parse on the way in, not by a blind cast.
    expect(fromStorage(row).stage).toBe('in_progress')
  })

  it('refuses an unrecognised stored stage rather than casting it onto the wire', () => {
    // The behaviour `row.stage as IssueWire['stage']` cannot have: today an unknown
    // stored stage flows onto the wire mislabelled as a valid one.
    expect(() => fromStorage({ ...toStorage(populatedIssue), stage: 'shipped' })).toThrow()
  })
})

describe('IssueProjection is normalized [ADR 4 D7.1]', () => {
  it('references no session at all — not even by id [POD-796]', () => {
    const wire = toWire(populatedIssue)
    // `sessions` is the field IssueWire carries, and the reason a one-field
    // session change rebuilt every issue's payload at O(world).
    expect(Object.hasOwn(wire, 'sessions')).toBe(false)
    // `memberSessionIds` was the id-only intermediate — normalized, O(1) per
    // change, and still deleted at the cutover: membership is stored on the
    // SESSION side, so an issue-side copy is a second source of truth that can
    // only ever disagree with the replica's own index over `sessions.issueId`.
    expect(Object.hasOwn(wire, 'memberSessionIds')).toBe(false)
  })

  it('takes no input beyond the issue, so no session change can dirty it [ADR 4 D7.2]', () => {
    // The strongest form of the property, and the reason the cutover deletes the
    // parameter rather than passing it an empty array: a dependency you cannot
    // express is one the publish path cannot acquire later. If `toWire` ever
    // grows a second parameter again, this stops compiling.
    const _signature: (issue: typeof populatedIssue) => IssueProjection = toWire
    expect(toWire.length).toBe(1)
  })

  it('carries no field derived from another entity', () => {
    const wire = toWire(populatedIssue)
    // Each of these is a function of something other than this issue's own row, so
    // computing it here would put cross-entity work on the publish path (D7.2).
    for (const derivedKey of [
      'sessions',
      'sessionSummary',
      'unread',
      'ready',
      'blocked',
      'deferred',
      'childCount',
      'childDoneCount',
      'commentCount',
      'displayRef',
      'prefix',
      'labels',
      'deps',
      'dependents',
      'comments',
    ]) {
      expect(Object.hasOwn(wire, derivedKey)).toBe(false)
    }
  })

  it('carries no provenance flag [ADR 4 D3.8 — those belong to the envelope]', () => {
    const wire = toWire(populatedIssue)
    for (const flag of ['viaHub', 'upstreamStale', 'pendingSync']) {
      expect(Object.hasOwn(wire, flag)).toBe(false)
    }
  })

  it('drops a derived field a caller tries to smuggle in', () => {
    // zod's default `strip` is what makes the normalization hold at runtime and not
    // just in the types — a hand-built payload cannot reintroduce embedded sessions.
    const smuggled = IssueProjection.parse({
      ...toWire(populatedIssue),
      sessions: [{ sessionId: 'sess_7b3e91', title: 'nope' }],
    })
    expect(Object.hasOwn(smuggled, 'sessions')).toBe(false)
  })
})

describe('IssueProjection wire tolerance', () => {
  it('degrades an unknown colour from a newer peer to unset, not a failed parse', () => {
    const parsed = IssueProjection.parse({
      ...toWire(populatedIssue),
      color: 'amber',
    })
    expect(parsed.color).toBeUndefined()
    expect(parsed.title).toBe(populatedIssue.title)
  })

  it('degrades malformed humanQuestionOptions to unset', () => {
    const parsed = IssueProjection.parse({
      ...toWire(populatedIssue),
      humanQuestionOptions: 'not-an-array',
    })
    expect(parsed.humanQuestionOptions).toBeUndefined()
  })

  it('still refuses a payload missing a REQUIRED field', () => {
    // Tolerance is per-field and deliberate; it is not blanket permissiveness.
    const { title: _title, ...withoutTitle } = toWire(populatedIssue)
    expect(IssueProjection.safeParse(withoutTitle).success).toBe(false)
  })
})

describe('the durable aggregate refuses what it does not understand', () => {
  it('rejects an unknown stage instead of defaulting it', () => {
    expect(() => fromWire({ ...toWire(populatedIssue), stage: 'shipped' } as never)).toThrow()
  })

  it('rejects an empty id', () => {
    // The `.min(1)` on the brand is load-bearing: an empty id is not a valid key.
    expect(() => fromWire({ ...toWire(populatedIssue), id: '' } as never)).toThrow()
  })
})

describe('the fixtures cover the vocabulary', () => {
  // Derived from the SCHEMA — the artifact that decides what is nullable — rather
  // than from the fixtures' own values, which is the thing under test here.
  const nullableKeys = Object.entries(issueDurableShape)
    .filter(([, field]) => field instanceof z.ZodNullable)
    .map(([key]) => key)

  it('sets every durable field, so no field silently escapes the round-trips', () => {
    // Without this, adding a field to a group and forgetting the fixtures would
    // leave every test above green while never covering the new field at all.
    const keys = Object.keys(issueDurableShape).sort()
    expect(Object.keys(populatedIssue).sort()).toEqual(keys)
    expect(Object.keys(minimalIssue).sort()).toEqual(keys)
  })

  it('exercises every nullable field in BOTH the set and the null state', () => {
    expect(nullableKeys.length).toBeGreaterThan(20)
    for (const key of nullableKeys) {
      expect
        .soft(populatedIssue[key as keyof typeof populatedIssue], `populated.${key} is set`)
        .not.toBeNull()
      expect
        .soft(minimalIssue[key as keyof typeof minimalIssue], `minimal.${key} is null`)
        .toBeNull()
    }
  })

  it('has no nullable field in the required half of the shape', () => {
    // The inverse guard: a field that is NOT `.nullable()` must be set in the
    // minimal fixture too, which is what makes "minimal" a valid aggregate rather
    // than a half-built one.
    for (const [key, value] of Object.entries(minimalIssue)) {
      if (!nullableKeys.includes(key)) expect.soft(value, `minimal.${key}`).not.toBeNull()
    }
  })
})
