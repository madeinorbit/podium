/**
 * Server-side experimental feature flags [spec:SP-f4b9].
 *
 * Resolves the shared protocol registry against config.json overrides,
 * user settings, update channel, and the dev-mode version sentinel.
 */
import {
  FEATURES,
  type FeatureId,
  type FeatureState,
  type FeatureVisibility,
  resolveFeatureState,
} from '@podium/protocol'
import type { PodiumSettings } from '@podium/runtime'
import {
  type EnvSource,
  loadConfig,
  type PodiumConfig,
  resolveFeatureOverrides,
  resolveUpdateChannel,
} from '@podium/runtime/config'

export interface FeatureStateWire extends FeatureState {
  id: string
  name: string
  description: string
  visibility: FeatureVisibility
}

export function getFeatureStates(
  settings: PodiumSettings,
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): {
  devMode: boolean
  channel: 'stable' | 'edge'
  flags: FeatureStateWire[]
} {
  // env.PODIUM_APP_VERSION is the unit-test override. The second term MUST stay
  // the literal `process.env.PODIUM_APP_VERSION` — build-bun --define only
  // textually rewrites that exact expression; dynamic env access is not baked
  // and would leave production builds as undefined → 'dev' forever.
  const version = env.PODIUM_APP_VERSION ?? process.env.PODIUM_APP_VERSION ?? 'dev'
  const devMode = version === 'dev'
  const channel = resolveUpdateChannel(config, env)
  const overrides = resolveFeatureOverrides(config)
  const user = settings.experimental ?? {}

  const flags: FeatureStateWire[] = FEATURES.map((def) => {
    const state = resolveFeatureState(def, {
      configValue: overrides[def.id],
      userValue: user[def.id],
      channel,
      devMode,
    })
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      visibility: def.visibility,
      ...state,
    }
  })

  return { devMode, channel, flags }
}

/** Seam for server-side gating of unfinished behavior [spec:SP-f4b9]. */
export function isFeatureEnabled(
  id: FeatureId,
  settings: PodiumSettings,
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): boolean {
  const { flags } = getFeatureStates(settings, config, env)
  return flags.find((f) => f.id === id)?.enabled ?? false
}
