/**
 * Force an experimental flag for one test file, the way an operator does it:
 * through `config.json` in the instance state dir.
 *
 * Server-side flag reads resolve against the real config file (`loadConfig()`),
 * and a config value beats every other source. Tests get their own throwaway
 * state dir per file (test-hermetic-env.ts), so writing it here is hermetic —
 * and it is the only lever that lands BEFORE a `SessionStore` is constructed,
 * which matters for boot-time gates like the search index (PDM-25).
 */
import type { FeatureId } from '@podium/protocol'
import { loadConfig, saveConfig } from '@podium/runtime/config'

export function forceFeature(id: FeatureId, enabled: boolean): void {
  const config = loadConfig()
  saveConfig({ ...config, features: { ...(config.features ?? {}), [id]: enabled } })
}
