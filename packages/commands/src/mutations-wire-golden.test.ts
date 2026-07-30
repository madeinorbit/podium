/**
 * THE MUTATION ENVELOPE'S WIRE, PINNED — the golden that travelled with the module.
 *
 * `MutationEnvelope` / `MutationResult` used to live in `@podium/protocol` and were
 * covered by that package's reflective golden harness (`wire-golden.test.ts`, POD-360).
 * POD-311 absorbed the module into `@podium/commands`, and the fixture came with it
 * rather than being deleted: a move that drops a schema out of every golden corpus
 * would make the wire unpinned at exactly the moment it changed packages, which is
 * the moment it is least observed.
 *
 * WHAT IS PORTED AND WHAT IS NOT. The protocol harness reflects over a module
 * registry to discover schemas and prove its own coverage; that machinery belongs to
 * the package that has forty families to enumerate. What matters for two schemas is
 * the GUARANTEE, and the guarantee is asserted directly here: for every committed
 * case, parsing the recorded `wire` produces exactly the recorded parse deltas, and
 * re-encoding produces the recorded BYTES. The corpus is the same JSON, unmodified,
 * so `git log --follow` on it shows the bytes were never touched by the move.
 *
 * The cases are generated. If one legitimately changes, regenerate it in
 * `@podium/protocol` before the module moved — which is impossible now — so a change
 * here is a hand edit that has to argue for itself in review. That is deliberate:
 * these two schemas are the client→authority write envelope, and P1 is additive-only.
 */

import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import golden from './__fixtures__/mutations-wire-golden.json' with { type: 'json' }
import { MutationEnvelope, MutationResult } from './mutations'

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  MutationEnvelope,
  MutationResult,
}

interface GoldenCase {
  schema: string
  variant: string
  wire: unknown
  parseAdded: Record<string, unknown>
  parseChanged: Record<string, unknown>
  parseDropped: Record<string, unknown>
  encoded: string
}

const cases = golden.cases as unknown as GoldenCase[]

describe('mutations wire golden (moved from @podium/protocol by POD-311)', () => {
  /**
   * NON-VACUITY FIRST. A `for` loop over an empty corpus passes every assertion it
   * contains, and a renamed JSON key would empty it silently — so the corpus is
   * asserted to be populated and to cover BOTH schemas by name before anything is
   * read from it. This is the check that makes the loop below mean something.
   */
  it('the corpus is populated and covers both schemas', () => {
    expect(cases.length).toBe(8)
    expect(new Set(cases.map((c) => c.schema))).toEqual(
      new Set(['MutationEnvelope', 'MutationResult']),
    )
    for (const name of Object.keys(SCHEMAS)) {
      expect(cases.some((c) => c.schema === name), name).toBe(true)
    }
  })

  it('every committed case parses to its recorded value and re-encodes to its recorded bytes', () => {
    for (const c of cases) {
      const schema = SCHEMAS[c.schema]
      expect(schema, `${c.schema}: no such schema in this module`).toBeDefined()
      const parsed = schema?.parse(c.wire)
      // `parseChanged` empty is the harness's value-transparency claim: parsing may
      // ADD a default but must never rewrite a value the peer sent.
      expect(c.parseChanged, `${c.schema}/${c.variant}`).toEqual({})
      expect(JSON.stringify(parsed), `${c.schema}/${c.variant}`).toBe(c.encoded)
    }
  })

  /**
   * The instrument proving the loop above can say NO. Without it, a corpus whose
   * `encoded` happened to match anything — or a `parse` that silently succeeded on
   * everything — would read as a pin.
   */
  it('a perturbed case fails the same comparison', () => {
    const c = cases[0] as GoldenCase
    const schema = SCHEMAS[c.schema] as z.ZodTypeAny
    expect(JSON.stringify(schema.parse(c.wire))).not.toBe(`${c.encoded} `)
    expect(() => MutationEnvelope.parse({ ...(c.wire as object), mutationId: '' })).toThrow()
  })
})
