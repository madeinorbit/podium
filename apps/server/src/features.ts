/**
 * Server-side experimental feature flags [spec:SP-f4b9].
 *
 * Two halves, joined by one resolver (`resolveFeatureStates`, `@podium/protocol`):
 *
 *  - THE SERVER'S FACTS ({@link serverFeatureFacts}): the build (source or
 *    development), the update channel the environment or config.json forces,
 *    and each flag with its config.json override. They ride `welcome` on every
 *    connect (POD-5798, POD-6677; detailed design 1.6), since they change only
 *    when the server is upgraded or reconfigured.
 *  - THE INSTANCE'S PREFERENCES: the operator's experimental toggles and the
 *    stored update channel, which reach the app as the synced
 *    `instancePreferences` record.
 *
 * The server's own gate ({@link getFeatureStates}, {@link isFeatureEnabled})
 * resolves through the same function, so an app and its server never disagree.
 */
import {
  FEATURES,
  type FeatureId,
  type FeatureStates,
  isDevChannelVersion,
  resolveFeatureStates,
  type ServerFeatureFacts,
} from '@podium/protocol'
import type { PodiumSettings } from '@podium/runtime'
import {
  type EnvSource,
  loadConfig,
  type PodiumConfig,
  resolveFeatureOverrides,
  resolveSetting,
} from '@podium/runtime/config'

export type { FeatureStateWire } from '@podium/protocol'

/** What this server's build and config say about its flags: the `welcome` facts. */
export function serverFeatureFacts(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): ServerFeatureFacts {
  // env.PODIUM_APP_VERSION is the unit-test override. The second term MUST stay
  // the literal `process.env.PODIUM_APP_VERSION` — build-bun --define only
  // textually rewrites that exact expression; dynamic env access is not baked
  // and would leave production builds as undefined → 'dev' forever.
  const version = env.PODIUM_APP_VERSION ?? process.env.PODIUM_APP_VERSION ?? 'dev'
  // The channel only when a layer ABOVE the instance preference sets it.
  const resolved = resolveSetting('updateChannel', config, env)
  const overrides = resolveFeatureOverrides(config)
  return {
    devMode: version === 'dev',
    developmentBuild: isDevChannelVersion(version),
    ...(resolved.source === 'env' || resolved.source === 'file' ? { channel: resolved.value } : {}),
    flags: FEATURES.map((def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      visibility: def.visibility,
      ...(overrides[def.id] !== undefined ? { config: overrides[def.id] } : {}),
    })),
  }
}

export function getFeatureStates(
  settings: PodiumSettings,
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): FeatureStates {
  return resolveFeatureStates(serverFeatureFacts(config, env), {
    experimental: settings.experimental,
    updateChannel: settings.deployment.updateChannel,
  })
}

/** Seam for server-side gating of unfinished behavior [spec:SP-f4b9]. */
export function isFeatureEnabled(
  id: FeatureId,
  settings: PodiumSettings,
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
  defaultWhenUnset = false,
): boolean {
  const { flags } = getFeatureStates(settings, config, env)
  const flag = flags.find((f) => f.id === id)
  return flag?.source === 'default' ? defaultWhenUnset : (flag?.enabled ?? defaultWhenUnset)
}
