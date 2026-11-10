/**
 * THE INSTANCE PREFERENCES AS ONE SYNCED RECORD (POD-6677, ADR 12 D1; design
 * POD-5620 §1.5).
 *
 * The instance tier of the settings (`InstancePreferences`: hibernation, the git
 * workflow, the issue assistant, the steward, the experimental toggles, worktree
 * clean-up, transcripts and the deployment choices) used to reach a client only
 * by a `settings.get` request, so an app started offline knew none of it and an
 * admin's change reached nobody until they asked again. It is now ONE record for
 * the whole instance, on the feed:
 *
 *  - VISIBILITY: the matrix row `preferences-instance`, `deployment-substrate`:
 *    every member of the instance reads it. No per-setting list is needed: the
 *    classification already puts every leaf in a tier, and its test keeps it
 *    total.
 *  - WRITERS: admins (`operator`), by generic edits; the server for its own
 *    deployment facts (the telemetry install id).
 *  - FIELDS: the tier's leaf PATHS, flat (`hibernation.memoryPct`,
 *    `gitWorkflow.defaultParentBranch`), so field-level last-writer-wins is per leaf, the
 *    rule the matrix row keeps for this tier. `experimental` is ONE leaf: it is an
 *    open record of flag ids (`SETTINGS_OPEN_RECORD_LEAVES`), classified whole.
 *  - VALUES: what the instance resolves to, defaults spelled out, since the
 *    stored blob is normalised. An optional leaf the deployment never chose (an
 *    update channel nobody picked) is absent, so "never chosen" stays
 *    distinguishable from the default.
 *  - NEVER IN IT: a server secret. Secrets are their own tier (`replicates:
 *    false`); the app sees only whether one is set (`settings.secretPresence`).
 */

import { z } from 'zod'
import { InstancePreferences } from './preferences'

type ZodDef = { typeName?: string; innerType?: z.ZodTypeAny }
const defOf = (schema: z.ZodTypeAny): ZodDef => schema._def as ZodDef

/** A leaf's value schema without its default or optional wrapper. */
function bare(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = defOf(schema)
  if (def.typeName === 'ZodDefault' || def.typeName === 'ZodOptional') {
    return def.innerType ? bare(def.innerType) : schema
  }
  return schema
}

function leafSchemas(schema: z.ZodTypeAny, prefix: string, out: Map<string, z.ZodTypeAny>): void {
  const inner = bare(schema)
  if (defOf(inner).typeName !== 'ZodObject') {
    out.set(prefix, inner)
    return
  }
  for (const [key, child] of Object.entries((inner as z.AnyZodObject).shape)) {
    leafSchemas(child as z.ZodTypeAny, prefix ? `${prefix}.${key}` : key, out)
  }
}

/**
 * Every instance-preference leaf path with its value schema, walked from
 * {@link InstancePreferences}: the walk that classifies the tier
 * (`settings/path-tiers.ts`), so the record's fields and the tier are one list.
 */
export const INSTANCE_PREFERENCE_LEAVES: ReadonlyMap<string, z.ZodTypeAny> = (() => {
  const out = new Map<string, z.ZodTypeAny>()
  leafSchemas(InstancePreferences, '', out)
  return out
})()

/** The record: each instance leaf path, flat. */
export const InstancePreferencesWire = z
  .object(
    Object.fromEntries(
      [...INSTANCE_PREFERENCE_LEAVES].map(([path, schema]) => [path, schema.optional()]),
    ),
  )
  .strict()
export type InstancePreferencesWire = Readonly<Record<string, unknown>>

/** One record per instance: its feed id is this constant. */
export const INSTANCE_PREFERENCES_ROW_ID = 'instance'

/** Inverse of the singleton id: throws on any other id. */
export function parseInstancePreferencesRowId(id: string): { readonly id: 'instance' } {
  if (id !== INSTANCE_PREFERENCES_ROW_ID) {
    throw new Error(`malformed instance preferences row id: ${JSON.stringify(id)}`)
  }
  return { id: INSTANCE_PREFERENCES_ROW_ID }
}

/** The value at a dotted path of a nested object, or undefined. */
function leafOf(blob: unknown, path: string): unknown {
  let at: unknown = blob
  for (const part of path.split('.')) {
    if (at === null || typeof at !== 'object') return undefined
    at = (at as Record<string, unknown>)[part]
  }
  return at
}

/** The record of an instance's settings: every instance leaf it holds, flat. */
export function instancePreferencesRecordOf(settings: unknown): InstancePreferencesWire {
  const out: Record<string, unknown> = {}
  for (const path of INSTANCE_PREFERENCE_LEAVES.keys()) {
    const value = leafOf(settings, path)
    if (value !== undefined) out[path] = value
  }
  return out
}

/** Fold a record's leaves back into the nested shape, defaults for the rest. */
export function resolveInstancePreferences(
  wire: Readonly<Record<string, unknown>> | undefined,
): InstancePreferences {
  const nested: Record<string, unknown> = {}
  for (const path of INSTANCE_PREFERENCE_LEAVES.keys()) {
    const value = wire?.[path]
    if (value === undefined) continue
    const parts = path.split('.')
    const leaf = parts.pop()
    if (leaf === undefined) continue
    let at = nested
    for (const part of parts) {
      const next = at[part]
      if (next === null || typeof next !== 'object') at[part] = {}
      at = at[part] as Record<string, unknown>
    }
    at[leaf] = value
  }
  const parsed = InstancePreferences.safeParse(nested)
  return parsed.success ? parsed.data : InstancePreferences.parse({})
}
