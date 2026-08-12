import type { ServerReadiness } from '@podium/model'
import { type ConfigInspection, inspectConfig, type PodiumConfig } from '@podium/runtime/config'

export interface ServerReadinessSource {
  readonly bootConfig: PodiumConfig
  readonly hasLiveAgentMachine: () => boolean
  readonly inspect?: () => ConfigInspection
}

/**
 * Derive readiness at request time. Persisting setup and activating it are two
 * different events: boot-relevant config written after this process started is
 * activation-pending until a new process adopts it.
 */
export function createServerReadiness(source: ServerReadinessSource): () => ServerReadiness {
  const read = source.inspect ?? inspectConfig
  return () => {
    const inspected = read()
    if (inspected.state === 'corrupt') {
      return source.bootConfig.mode
        ? { state: 'degraded', reason: 'configuration_invalid', dataPlane: 'available' }
        : { state: 'unconfigured', reason: 'setup_required', dataPlane: 'blocked' }
    }

    const liveConfig = inspected.state === 'ok' ? inspected.config : ({} satisfies PodiumConfig)
    if (!liveConfig.mode) {
      return { state: 'unconfigured', reason: 'setup_required', dataPlane: 'blocked' }
    }

    if (
      !source.bootConfig.mode ||
      source.bootConfig.mode !== liveConfig.mode ||
      source.bootConfig.persistence !== liveConfig.persistence
    ) {
      return { state: 'activation_pending', reason: 'restart_required', dataPlane: 'blocked' }
    }

    if (!source.hasLiveAgentMachine()) {
      return { state: 'degraded', reason: 'agent_unavailable', dataPlane: 'available' }
    }

    return { state: 'ready', reason: null, dataPlane: 'available' }
  }
}
