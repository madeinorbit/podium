/**
 * The no-capability-snapshot audit — POD-643, implementing ADR 9 D5 A1 over the
 * schemas rather than over review comments.
 *
 * ---------------------------------------------------------------------------
 * WHY A SCHEMA-LEVEL AUDIT AND NOT A CODE-REVIEW RULE
 * ---------------------------------------------------------------------------
 *
 * An agent's effective rights are its own scope INTERSECTED with its human's
 * CURRENT rights, resolved live at every apply (ADR 9 D5 A1, ADR 3 D8). A
 * serialized snapshot of those rights leaves an unattended agent running with
 * rights its human no longer holds, and there is no cleanup trigger — nothing
 * in the system knows the copy exists.
 *
 * A PORTABLE representation is where that mistake is most tempting: a bundle
 * that moves between machines arrives somewhere that would rather not look the
 * rights up. The temptation is not hypothetical and it is not visible in a
 * diff, because "add one optional field" reads as additive and byte-safe. So
 * the rule is executable: run this over a representation and a serialized
 * authority field FAILS, whoever adds it and whatever they call it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT IN SCOPE
 * ---------------------------------------------------------------------------
 *
 * IN: any key naming a right, a scope, a role, a grant or a permission — the
 * things authorization is DECIDED from. Those must be resolved from the
 * authenticated transport principal at apply time (ADR 3 D7), never read from
 * payload.
 *
 * OUT: `owner`, `actor` and `onBehalfOf`. Those are ATTRIBUTION — who made this
 * thing — and they are durable facts that must survive export and
 * re-replication (ADR 9 D5 A3/A4, and `provenance/envelope.ts` on why they are
 * entity data). Recording who exported a bundle is not the same act as telling
 * the importer what the exporter was allowed to do, and this audit must not
 * conflate them or it would forbid the attribution the matrix requires.
 *
 * Secrets are a SEPARATE obligation (ADR 1 D6, and the `secret` cell of the
 * ownership matrix): no secret may ride a bundle either. That rule is not
 * folded in here, so that a failure names one thing.
 */

import type { z } from 'zod'

/**
 * Key names that denote a serialized authority decision. Matched
 * case-insensitively against every key at every depth, so a nested or renamed
 * spelling (`delegation.scope`, `rights`, `acl`) is caught by the same rule as
 * a top-level `capabilities`.
 */
const SERIALIZED_AUTHORITY_KEY =
  /capabilit|effectiveright|\brights?\b|permission|privileg|entitlement|grant|scope|\brole|\bacl\b/i

type ZodDef = {
  typeName?: string
  innerType?: z.ZodTypeAny
  schema?: z.ZodTypeAny
  type?: z.ZodTypeAny
  options?: readonly z.ZodTypeAny[]
}

const defOf = (schema: z.ZodTypeAny): ZodDef => schema._def as ZodDef

/** Peel the wrappers that do not change the key set: optional, nullable,
 *  default, catch, readonly, and `.refine()`/`.transform()` effects. A
 *  capability field hidden under `.optional()` is still a capability field. */
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

function walk(schema: z.ZodTypeAny, prefix: string, found: string[]): void {
  const inner = unwrap(schema)
  const def = defOf(inner)

  if (def.typeName === 'ZodObject') {
    const shape = (inner as unknown as z.AnyZodObject).shape
    for (const [key, child] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (SERIALIZED_AUTHORITY_KEY.test(key)) found.push(path)
      walk(child as z.ZodTypeAny, path, found)
    }
    return
  }

  if (def.typeName === 'ZodArray' && def.type) {
    walk(def.type, `${prefix}[]`, found)
    return
  }

  if (def.typeName === 'ZodUnion' && def.options) {
    for (const option of def.options) walk(option, prefix, found)
  }
}

/**
 * Every key path in `schema` that names a serialized authority decision.
 * Empty means the representation carries identity and provenance only, and the
 * target must resolve rights from its own principal.
 */
export function findCapabilitySnapshotKeys(schema: z.ZodTypeAny): string[] {
  const found: string[] = []
  walk(schema, '', found)
  return found
}
