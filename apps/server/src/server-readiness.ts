import {
  BOOT_RELEVANT_CONFIG_FIELDS,
  type BootRelevantConfigField,
  controlPlaneFor,
  type ServerReadiness,
} from '@podium/model'
import {
  type ConfigInspection,
  inspectConfig,
  type PodiumConfig,
  type PodiumMode,
} from '@podium/runtime/config'

export interface ServerReadinessSource {
  readonly bootConfig: PodiumConfig
  readonly hasLiveAgentMachine: () => boolean
  readonly inspect?: () => ConfigInspection
  /**
   * THE MODE THE ENVIRONMENT SET (PDM-26, `PODIUM_MODE`).
   *
   * Present means this process's mode did not come from the file — so the file
   * cannot contradict it, and cannot make this process stale on `mode`. Env is
   * read once at boot and cannot change underneath a running process, which is
   * precisely the property whose ABSENCE `activation_pending` exists to detect:
   * an env-set mode is never activation-pending, and an empty config.json (the
   * container shape — nothing has ever written one) is not `unconfigured`.
   *
   * `persistence` staleness is untouched. A headless container never writes
   * that field: `applySetup` only back-fills it on first run, and first run is
   * the moment this deployment does not have. Absent stays absent, and absent
   * equals absent.
   */
  readonly envMode?: PodiumMode
}

/**
 * Which boot-relevant fields the file now disagrees with this process about.
 *
 * The comparison is driven off the DECLARED list rather than an inline chain of
 * `||`s, so "is this field boot-relevant?" has exactly one answer and the screen
 * that has to name the stale field reads the same list the guard trips on.
 */
function staleBootFields(
  bootConfig: PodiumConfig,
  liveConfig: PodiumConfig,
  exempt: ReadonlySet<BootRelevantConfigField>,
): readonly BootRelevantConfigField[] {
  // Absence is a value here, not "unknown": config v2 defines an unset persistence field as an
  // unmanaged foreground/desktop process. Establishing systemd changes the supervisor and must
  // stay activation-pending until a process has actually booted under that authority.
  return BOOT_RELEVANT_CONFIG_FIELDS.filter(
    (field) => !exempt.has(field) && bootConfig[field] !== liveConfig[field],
  )
}

/**
 * Derive readiness at request time. Persisting setup and activating it are two
 * different events: boot-relevant config written after this process started is
 * activation-pending until a new process adopts it.
 *
 * `activation_pending` blocks the DATA plane and nothing more (POD-2766). This
 * process is running stale config, so it must not serve work — but it can still
 * be talked to about itself, which is the only way the operator reaches the
 * restart that clears the state. `controlPlaneFor` is the single place that
 * mapping lives.
 */
export function createServerReadiness(source: ServerReadinessSource): () => ServerReadiness {
  const read = source.inspect ?? inspectConfig
  const withPlanes = (readiness: Omit<ServerReadiness, 'controlPlane'>): ServerReadiness => ({
    ...readiness,
    controlPlane: controlPlaneFor(readiness.state),
  })
  const envMode = source.envMode
  // `mode` is off the comparison entirely when the environment set it — see
  // {@link ServerReadinessSource.envMode}. Every other boot-relevant field is
  // compared exactly as before.
  const exempt: ReadonlySet<BootRelevantConfigField> = new Set(envMode ? ['mode'] : [])
  return () => {
    const inspected = read()
    if (inspected.state === 'corrupt') {
      return withPlanes(
        envMode || source.bootConfig.mode
          ? { state: 'degraded', reason: 'configuration_invalid', dataPlane: 'available' }
          : { state: 'unconfigured', reason: 'setup_required', dataPlane: 'blocked' },
      )
    }

    const liveConfig = inspected.state === 'ok' ? inspected.config : ({} satisfies PodiumConfig)
    if (!envMode && !liveConfig.mode) {
      return withPlanes({ state: 'unconfigured', reason: 'setup_required', dataPlane: 'blocked' })
    }

    // An unset boot mode is this process never having adopted a mode at all, which
    // is staleness of the same kind: `mode` is on the list, so the diff names it.
    // An env-set mode is the exception — this process adopted one, from a layer
    // the file cannot reach.
    const stale =
      envMode || source.bootConfig.mode
        ? staleBootFields(source.bootConfig, liveConfig, exempt)
        : (['mode'] as const)
    if (stale.length > 0) {
      return withPlanes({
        state: 'activation_pending',
        reason: 'restart_required',
        dataPlane: 'blocked',
        stale,
      })
    }

    if (!source.hasLiveAgentMachine()) {
      return withPlanes({ state: 'degraded', reason: 'agent_unavailable', dataPlane: 'available' })
    }

    return withPlanes({ state: 'ready', reason: null, dataPlane: 'available' })
  }
}
