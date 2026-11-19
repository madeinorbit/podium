import { SETTINGS_PATH_TIERS } from '@podium/model/browser'
import { DEFAULT_SETTINGS, type PodiumSettings } from '@podium/runtime'

const groupsOf = (tier: 'personal-preference' | 'instance-preference') =>
  new Set(
    SETTINGS_PATH_TIERS.filter((field) => field.tier === tier).map(
      (field) => field.path.split('.')[0]!,
    ),
  )

/** The personal groups: my `userPreferences` record (POD-6673). Read from the
 *  classification, so a new personal leaf (`credentialDefaults`) is not left
 *  reading its blank default. */
const PERSONAL_GROUPS = groupsOf('personal-preference')

/** The instance groups: the `instancePreferences` record (POD-6677). */
const INSTANCE_GROUPS = groupsOf('instance-preference')

/** The settings the screen edits: every group read live from its home, the
 *  personal ones from my synced record and the instance ones from the
 *  instance's. A secret-only group (`apiKeys`, `integrations`) is never on
 *  either record: it reads as the blank default, and the secret surface shows
 *  only whether a secret is set. */
export function composedSettings(
  instance: () => Readonly<Record<string, unknown>> | undefined,
  mine: () => Readonly<Record<string, unknown>> | undefined,
): PodiumSettings {
  const out: Record<string, unknown> = {}
  const blank = DEFAULT_SETTINGS as unknown as Record<string, unknown>
  for (const key of new Set(SETTINGS_PATH_TIERS.map((field) => field.path.split('.')[0]!))) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () =>
        PERSONAL_GROUPS.has(key)
          ? mine()?.[key]
          : INSTANCE_GROUPS.has(key)
            ? instance()?.[key]
            : blank[key],
    })
  }
  return out as PodiumSettings
}
