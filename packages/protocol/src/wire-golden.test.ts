/**
 * Golden wire fixtures — the characterization suite for POD-301's branded-id
 * chain (POD-360), and the additive-change evidence for the multi-user model
 * additions (POD-1075 user accounts / identity, POD-1076 per-user state).
 *
 * THE CONTRACT THIS PINS
 * ----------------------
 * Branding is a COMPILE-TIME construct. `SessionId` is `string & {brand}`; it
 * serializes as the same string, parses from the same string, and occupies the
 * same bytes. So POD-361 (branded model schemas), POD-362 (server + daemon
 * adoption) and POD-363 (client + CLI adoption) may change types freely and must
 * change the wire not at all. These fixtures are what turns "and it still
 * compiles" into "and the bytes are identical".
 *
 * The same fixtures are the acceptance evidence for POD-1075 and POD-1076, whose
 * required property is that their column and field additions are ADDITIVE at the
 * wire. A field added to a schema shows up in a `full` case's `wire` as a new
 * line and, if it is defaulted, in `parseAdded`. A field whose SHAPE changed
 * shows up as a modified line in place. That distinction is the deliverable, not
 * a side effect — see docs/rearch-id-inventory.md §1.
 *
 * Regenerate after an intended protocol change:
 *     bun run fixtures:wire:update
 * and read the diff. An unexplained line in it is the finding.
 */

import { describe, expect, it } from 'vitest'
import { buildCorpus, type WireFamily } from './__fixtures__/build'
import { buildFeatureStateGolden, type FeatureStateGolden } from './__fixtures__/feature-state'
import { GOLDEN } from './__fixtures__/golden/index'
import { AGGREGATE_UNIONS, coveredSchemas } from './__fixtures__/registry'

/** The committed corpus, read through the generated static-import index rather
 *  than node:fs — `packages/protocol` is a leaf package with `types: []`, so the
 *  suite must not depend on node typings to typecheck. */
const readGolden = <T>(name: string): T => {
  const golden = GOLDEN[name]
  if (golden === undefined) {
    throw new Error(
      `no committed golden for family "${name}" — run \`bun run fixtures:wire:update\``,
    )
  }
  return golden as T
}

const corpus = buildCorpus()

/** Every wire `type` literal that appears anywhere in the corpus. Arms are
 *  matched by this rather than by schema name: the two differ often enough
 *  (`SessionOpenUrlMessage` vs `sessionOpenUrl`) that name matching would
 *  quietly pass while covering nothing. */
const coveredWireTypes = new Set(
  corpus.flatMap((family) =>
    family.cases
      .map((wireCase) => (wireCase.wire as { type?: unknown } | null)?.type)
      .filter((value): value is string => typeof value === 'string'),
  ),
)

const armTypeLiterals = (union: unknown): string[] =>
  (union as { _def: { options: unknown[] } })._def.options.map((option) => {
    const shape = (
      option as { _def: { shape: () => Record<string, { _def: { value?: string } }> } }
    )._def.shape()
    return shape.type?._def.value ?? '<arm carries no `type` literal>'
  })

describe('golden wire fixtures', () => {
  it('covers every zod schema the protocol package exports', () => {
    // Not an assertion about a count — a count would just get updated.
    //
    // Precise about what this does and does not check, because an earlier comment
    // here claimed "the corpus and the export surface are the SAME set" and the
    // body only checks one direction: every exported schema has a fixture. The
    // reverse (a fixture for a schema no longer exported) is impossible by
    // construction, since `buildCorpus` derives its cases FROM the registry — so
    // asserting it would be a check that cannot fail, which is the thing this
    // suite is supposed to be the opposite of.
    const covered = new Set(corpus.flatMap((f) => f.cases.map((c) => c.schema)))
    const missing = coveredSchemas()
      .map((entry) => entry.name)
      .filter((name) => !covered.has(name))
    expect(missing, 'exported schemas with no fixture').toEqual([])
  })

  describe.each(
    AGGREGATE_UNIONS.map(([name, schema]) => ({ name, schema })),
  )('aggregate union $name', ({ name, schema }) => {
    it('has a fixture for every arm', () => {
      // The aggregate transport unions are not sampled arm-by-arm (that would
      // duplicate 40+ large payloads to reach 8 of them). Instead every arm
      // must be covered as a schema in its own right — a stronger claim, and
      // one that fails the moment a message type lands without a fixture.
      const missing = armTypeLiterals(schema).filter((type) => !coveredWireTypes.has(type))
      expect(missing, `${name} arms with no fixture`).toEqual([])
    })
  })

  describe.each(corpus.map((family) => ({ family })))('$family.family', ({ family }) => {
    it('matches the committed golden file', () => {
      // Deep equality against the committed corpus. This is the byte pin: it
      // fails on a changed value, a reordered field, a new default, and on any
      // serialization change at all.
      expect(family).toEqual(readGolden<WireFamily>(family.family))
    })

    it('parses every sample', () => {
      const failures = family.cases
        .filter((c) => c.parseError !== undefined)
        .map((c) => `${c.schema}/${c.variant}: ${c.parseError}`)
      expect(failures).toEqual([])
    })

    it('never rewrites a value it was given (wire transparency)', () => {
      // The load-bearing assertion for POD-361/362/363. A branded schema that
      // transformed, normalized, or re-typed its input would land here, not in
      // a reviewer's judgement about whether the flip "looked mechanical".
      const rewritten = family.cases
        .filter((c) => Object.keys(c.parseChanged).length > 0)
        .map((c) => `${c.schema}/${c.variant}: ${Object.keys(c.parseChanged).join(', ')}`)
      expect(rewritten, 'parse rewrote a wire value').toEqual([])
    })
  })

  describe('feature-state', () => {
    // The one family the schema walker cannot reach: FeatureState is a TS
    // interface plus a pure resolver, not a zod schema.
    const built = buildFeatureStateGolden()

    it('matches the committed golden file', () => {
      expect(built).toEqual(readGolden<FeatureStateGolden>('feature-state'))
    })

    it('covers every flag across the whole resolver input matrix', () => {
      // ASSERTS THE MATRIX, NOT ITS CARDINALITY. The previous version checked
      // `cases.length === ids.size * 36`, which a mutation the name should have
      // caught passed straight through: dropping the `edge` channel and emitting
      // `stable` twice keeps the count at 36 per flag, so the corpus lost half the
      // matrix while this test — the one whose name promises the matrix — stayed
      // green. Only the byte-pin caught it, and that pin moves the moment someone
      // regenerates, which the documented workflow tells them to do.
      //
      // Two assertions, and deliberately NOT a copy of the generator's literals —
      // restating `['unset', true, false]` here would be one more copy to drift
      // (the same mistake as reading an enum off a doc comment). Instead: derive
      // each axis from the corpus, assert its ARITY, then assert the full cross
      // product of the observed values is present for every flag. A dropped
      // channel collapses that axis to arity 1 and fails the first check; a hole
      // inside a full axis fails the second.
      const axis = (pick: (input: FeatureStateGolden['cases'][number]['input']) => unknown) =>
        new Set(built.cases.map((c) => JSON.stringify(pick(c.input))))
      const axes = {
        configValue: axis((i) => i.configValue),
        userValue: axis((i) => i.userValue),
        channel: axis((i) => i.channel),
        devMode: axis((i) => i.devMode),
      }
      const arity = Object.fromEntries(Object.entries(axes).map(([k, v]) => [k, v.size]))
      expect(arity, 'resolver input axes are 3 × 3 × 2 × 2').toEqual({
        configValue: 3,
        userValue: 3,
        channel: 2,
        devMode: 2,
      })

      const expected = new Set<string>()
      for (const configValue of axes.configValue) {
        for (const userValue of axes.userValue) {
          for (const channel of axes.channel) {
            for (const devMode of axes.devMode) {
              expected.add([configValue, userValue, channel, devMode].join('|'))
            }
          }
        }
      }
      expect(expected.size, 'the matrix itself is 3 × 3 × 2 × 2').toBe(36)

      const byFlag = new Map<string, Set<string>>()
      for (const wireCase of built.cases) {
        const i = wireCase.input
        const combos = byFlag.get(i.id) ?? new Set<string>()
        combos.add(
          [i.configValue, i.userValue, i.channel, i.devMode]
            .map((value) => JSON.stringify(value))
            .join('|'),
        )
        byFlag.set(i.id, combos)
      }

      // Per flag: every combination present, none missing. A duplicate collapses
      // in the Set, so a hole cannot be masked by emitting something else twice.
      const holes = [...byFlag].flatMap(([id, combos]) =>
        [...expected].filter((combo) => !combos.has(combo)).map((combo) => `${id}: ${combo}`),
      )
      expect(holes, 'flag/input combinations missing from the corpus').toEqual([])
    })
  })
})
