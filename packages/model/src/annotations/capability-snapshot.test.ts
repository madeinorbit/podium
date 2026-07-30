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
