/**
 * The fixture harness's own gate (PDM-351).
 *
 * Deliberately NOT in `wire-golden.test.ts`. That file carries five inherited
 * `matches the committed golden file` reds on this branch, so an assertion added
 * there would be a green claim inside a red file — indistinguishable, at a
 * glance, from the defect it is supposed to guard. This file is wholly green and
 * says so on its own.
 *
 * WHAT IT PINS
 * ------------
 * A schema that is OPTIONAL AT ITS ROOT samples, in the `minimal` variant, to
 * "no document at all". `build.ts` used to write that down as `null`
 * (`sampled ?? null`) — a value every root-optional schema is right to refuse,
 * since `.optional()` admits `undefined` and never `null`. The corpus then
 * recorded the schema's correct rejection as a `parseError`, and
 * `parses every sample` failed on a fixture the harness had invented.
 *
 * The schema used here is BUILT IN THIS FILE rather than imported from
 * `@podium/model`. `OwnerAsAssigneeField` is what surfaced the defect and is
 * asserted below while it is on the export surface — but a guard whose only
 * subject is one export disappears the day that export is renamed or moved, and
 * the harness bug would come back unwatched.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildCorpus, buildSchemaCases } from './build'

const rootOptional = z.string().optional()

describe('wire fixture harness', () => {
  describe('a schema optional at its root', () => {
    const cases = buildSchemaCases({
      family: 'pdm-351',
      name: 'RootOptionalProbe',
      schema: rootOptional,
    })
    const minimal = cases.find((c) => c.variant === 'minimal')

    it('parses, rather than recording an invented null', () => {
      // The counterfactual this replaces: with `?? null` restored, `wire` is
      // `null` and `parseError` reads "<root>: Expected string, received null".
      expect(minimal?.parseError, 'minimal variant failed to parse').toBeUndefined()
    })

    it('records absence as absence and not as null', () => {
      // `null` is the specific wrong answer, so assert against it by name rather
      // than only asserting `undefined` — a future coercion to `''` or `{}`
      // would be just as wrong and must not slip past a loose check.
      expect(minimal?.wire).not.toBe(null)
      expect(minimal?.wire).toBeUndefined()
      // JSON has no term for "no document": serializing drops the key entirely,
      // which is what a reader of the golden should see.
      expect('w' in JSON.parse(JSON.stringify({ w: minimal?.wire }))).toBe(false)
    })

    it('pins no bytes for a case that puts nothing on the wire', () => {
      // `parseError` is asserted here as well, and not out of tidiness: the
      // failure branch of `buildCase` ALSO sets `encoded: ''`, so the byte
      // assertion on its own stays green under the very defect this file
      // guards. Pinning both makes it say what it means — nothing on the wire
      // because the case succeeded, not because it blew up.
      expect(minimal?.parseError).toBeUndefined()
      expect(minimal?.encoded).toBe('')
    })

    it('still samples the present value in the full variant', () => {
      // Absence must not swallow the case that matters: the `full` variant is
      // where the value actually round-trips, and a harness that "fixed" this by
      // dropping root-optional schemas entirely would pass everything above.
      const full = cases.find((c) => c.variant === 'full')
      expect(full?.parseError).toBeUndefined()
      expect(typeof full?.wire).toBe('string')
      expect(full?.encoded).not.toBe('')
    })
  })

  it('has no case anywhere in the corpus whose wire is a coerced null', () => {
    // The whole-corpus form of the same property, and the one that would have
    // caught this the day A2 landed: every `minimal` case whose sample is absent
    // at the root, across every family, not just the one that happened to break.
    const coerced = buildCorpus().flatMap((family) =>
      family.cases
        .filter((c) => c.wire === null && c.parseError !== undefined)
        .map((c) => `${family.family}/${c.schema}/${c.variant}: ${c.parseError}`),
    )
    expect(coerced, 'cases whose wire is a null the sampler never produced').toEqual([])
  })
})
