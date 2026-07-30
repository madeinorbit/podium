import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { findCapabilitySnapshotKeys } from './capability-snapshot'

/**
 * The detector must FIRE on planted bad code, not merely pass on good code
 * (POD-368's convention for a default-closed audit item). Every case below
 * plants a serialized-authority field in a shape a real representation could
 * plausibly take, and asserts the audit names it.
 */
describe('findCapabilitySnapshotKeys', () => {
  it('names a planted effective-rights field', () => {
    const planted = z.object({ sessionId: z.string(), effectiveRights: z.array(z.string()) })
    expect(findCapabilitySnapshotKeys(planted)).toEqual(['effectiveRights'])
  })

  it('names a capability field nested inside an optional object', () => {
    const planted = z.object({
      sessionId: z.string(),
      delegation: z.object({ onBehalfOf: z.string(), scope: z.string() }).optional(),
    })
    expect(findCapabilitySnapshotKeys(planted)).toEqual(['delegation.scope'])
  })

  it('names a capability field inside an array element', () => {
    const planted = z.object({
      grants: z.array(z.object({ verb: z.string(), role: z.string() })),
    })
    // The `grants` key itself is authority-shaped, and so is the `role` inside it.
    expect(findCapabilitySnapshotKeys(planted)).toEqual(['grants', 'grants[].role'])
  })

  it('sees through default/catch/refinement wrappers', () => {
    const planted = z
      .object({
        sessionId: z.string(),
        permissions: z.array(z.string()).default([]),
      })
      .refine(() => true, 'always')
    expect(findCapabilitySnapshotKeys(planted)).toEqual(['permissions'])
  })

  // POD-1153. A VERSIONED FILE FORMAT is a discriminated union on its version
  // key, so this is the shape the portable representation actually took — and
  // the audit was BLIND to it: before the `ZodDiscriminatedUnion` case existed
  // this returned `[]`, which reads exactly like a clean representation. Both
  // arms are planted, and the newer arm is the one a reviewer skims, so the
  // assertion names both paths rather than "at least one".
  it('names a capability field inside a discriminated-union arm, in every arm', () => {
    const planted = z.discriminatedUnion('format', [
      z.object({ format: z.literal(1), sessionId: z.string(), scope: z.string() }),
      z.object({
        format: z.literal(2),
        sessionId: z.string(),
        effectiveRights: z.array(z.string()),
      }),
    ])
    expect(findCapabilitySnapshotKeys(planted)).toEqual(['scope', 'effectiveRights'])
  })

  // The counterfactual for the case above: a discriminated union whose arms are
  // clean must still answer `[]`, or "the audit sees unions now" would be
  // indistinguishable from "the audit fires on any union".
  it('is silent on a discriminated union whose every arm is clean', () => {
    const clean = z.discriminatedUnion('format', [
      z.object({ format: z.literal(1), sessionId: z.string(), exportedAt: z.string() }),
      z.object({
        format: z.literal(2),
        sessionId: z.string(),
        exported: z.object({ at: z.string(), by: z.object({ onBehalfOf: z.string().nullable() }) }),
        owner: z.string(),
      }),
    ])
    expect(findCapabilitySnapshotKeys(clean)).toEqual([])
  })

  it('is silent on a representation carrying only identity and provenance', () => {
    const clean = z.object({
      sessionId: z.string(),
      sourceMachineId: z.string(),
      exportedAt: z.string(),
      owner: z.string(),
      actor: z.object({ sessionId: z.string() }),
    })
    expect(findCapabilitySnapshotKeys(clean)).toEqual([])
  })
})
