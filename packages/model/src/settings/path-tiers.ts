/** Settings path-to-tier lookup without ownership/audit policy data. */

import type { z } from 'zod'
import { InstancePreferences, PersonalPreferences } from './preferences'
import { LEGACY_IN_BLOB_SECRET_GROUPS } from './secrets'

export const SETTINGS_TIERS = [
  'personal-preference',
  'instance-preference',
  'server-secret',
] as const
export type SettingsTier = (typeof SETTINGS_TIERS)[number]

type ZodDef = {
  typeName?: string
  innerType?: z.ZodTypeAny
  schema?: z.ZodTypeAny
}

const defOf = (schema: z.ZodTypeAny): ZodDef => schema._def as ZodDef

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

export const SETTINGS_OPEN_RECORD_LEAVES = ['experimental'] as const

export function settingsLeafPaths(
  schema: z.ZodTypeAny,
  prefix = '',
  skip: readonly string[] = [],
): string[] {
  const inner = unwrap(schema)
  const def = defOf(inner)
  if (def.typeName !== 'ZodObject') return prefix ? [prefix] : []

  const shape = (inner as unknown as z.AnyZodObject).shape
  const out: string[] = []
  for (const [key, child] of Object.entries(shape)) {
    if (!prefix && skip.includes(key)) continue
    const path = prefix ? `${prefix}.${key}` : key
    out.push(...settingsLeafPaths(child as z.ZodTypeAny, path))
  }
  return out
}

export interface SettingsPathTier {
  readonly path: string
  readonly tier: SettingsTier
}

export const SETTINGS_PATH_TIERS: readonly SettingsPathTier[] = [
  ...settingsLeafPaths(PersonalPreferences, '', ['userId']).map((path) => ({
    path,
    tier: 'personal-preference' as const,
  })),
  ...settingsLeafPaths(InstancePreferences).map((path) => ({
    path,
    tier: 'instance-preference' as const,
  })),
  ...LEGACY_IN_BLOB_SECRET_GROUPS.flatMap((group) =>
    settingsLeafPaths(group.schema, group.prefix).map((path) => ({
      path,
      tier: 'server-secret' as const,
    })),
  ),
]

const SETTINGS_PATH_TIER_INDEX: ReadonlyMap<string, SettingsTier> = new Map(
  SETTINGS_PATH_TIERS.map(({ path, tier }) => [path, tier]),
)

/** `undefined` keeps an unclassified path distinct from a personal one. */
export function settingsTierForPath(path: string): SettingsTier | undefined {
  return SETTINGS_PATH_TIER_INDEX.get(path)
}

export function pathsInSettingsTier(tier: SettingsTier): string[] {
  return SETTINGS_PATH_TIERS.filter((entry) => entry.tier === tier).map((entry) => entry.path)
}
