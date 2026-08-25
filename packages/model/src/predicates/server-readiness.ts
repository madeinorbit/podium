/**
 * The public, non-secret lifecycle projection every human client reads before it
 * opens an operator transport.  The server is the only authority that derives
 * this value; clients render it and never infer readiness from a configured mode.
 *
 * TWO PLANES, AND THE SPLIT IS THE POINT (POD-2766).
 *
 * The CONTROL plane is talking ABOUT the instance — logging in, reading this
 * value, pressing restart. The DATA plane is the instance DOING WORK — agents,
 * sessions, repos. `activation_pending` means this process is running stale
 * config, so refusing WORK is correct and stays correct. Refusing LOGIN was
 * collateral: it locked out the only person who could restart the process, and
 * put the remedy on the far side of the failure. One bit could not say that, so
 * there are now two.
 */
export type ServerReadinessState = 'unconfigured' | 'activation_pending' | 'ready' | 'degraded'

export type ServerReadinessReason =
  | 'setup_required'
  | 'restart_required'
  | 'agent_unavailable'
  | 'configuration_invalid'
  | null

/**
 * Which `config.json` fields are BOOT-RELEVANT: changing one makes the running
 * process stale, because the process shape was decided from it at start-up.
 *
 * The list is short and closed on purpose. `mode` and `persistence` describe what
 * this process IS and how it is supervised; a password, a public URL and a
 * telemetry answer describe what it knows, and a running process adopts those
 * without being replaced. POD-2766 happened because a credential write reached a
 * field on this list by accident, so the list is now named rather than inlined in
 * the comparison.
 */
export const BOOT_RELEVANT_CONFIG_FIELDS = ['mode', 'persistence'] as const
export type BootRelevantConfigField = (typeof BOOT_RELEVANT_CONFIG_FIELDS)[number]

export interface ServerReadiness {
  readonly state: ServerReadinessState
  /** The instance DOING WORK: agents, sessions, repos, the operator transport. */
  readonly dataPlane: 'blocked' | 'available'
  /**
   * Talking ABOUT the instance: login, this value, the restart that clears
   * `activation_pending`. Optional ON READ so a server that predates the split
   * (which genuinely had no control plane while pending) is read as blocked
   * rather than rejected — {@link controlPlaneAvailable} is the one reader.
   */
  readonly controlPlane?: 'blocked' | 'available'
  readonly reason: ServerReadinessReason
  /**
   * WHICH boot-relevant fields differ between the running process and the file,
   * for the screen that has to tell an operator what is stale. Names only, never
   * values: this rides an unauthenticated route.
   */
  readonly stale?: readonly BootRelevantConfigField[]
}

/** Fail-closed reader for the optional field. An absent `controlPlane` is a
 *  server that predates the split, and on those the control plane really is shut
 *  while blocked — so absence must read as `false`, not as "probably fine". */
export function controlPlaneAvailable(readiness: ServerReadiness): boolean {
  return readiness.controlPlane === 'available'
}

/** The control plane each state is entitled to. `unconfigured` keeps it shut:
 *  there is no account to log into yet, and the host-local setup bootstrap is
 *  that state's door. Every other state can be talked to about itself. */
export function controlPlaneFor(state: ServerReadinessState): 'blocked' | 'available' {
  return state === 'unconfigured' ? 'blocked' : 'available'
}

function isStaleList(value: unknown): value is readonly BootRelevantConfigField[] {
  return (
    Array.isArray(value) &&
    value.every((entry) =>
      (BOOT_RELEVANT_CONFIG_FIELDS as readonly string[]).includes(entry as string),
    )
  )
}

/** Runtime guard for the public response. It validates the combinations too:
 * a contradictory `ready + blocked` response must fail closed in a client. */
export function isServerReadiness(value: unknown): value is ServerReadiness {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ServerReadiness>
  if (candidate.stale !== undefined && !isStaleList(candidate.stale)) return false
  // Stale boot fields are what activation_pending MEANS. Any other state naming
  // them is contradicting itself, and a client must not render the contradiction.
  if (candidate.state !== 'activation_pending' && (candidate.stale?.length ?? 0) > 0) return false
  // Absent is the old contract and allowed; present must agree with the state,
  // so a server cannot advertise a control plane its state does not have.
  if (
    candidate.controlPlane !== undefined &&
    (typeof candidate.state !== 'string' ||
      candidate.controlPlane !== controlPlaneFor(candidate.state as ServerReadinessState))
  ) {
    return false
  }
  switch (candidate.state) {
    case 'unconfigured':
      return candidate.reason === 'setup_required' && candidate.dataPlane === 'blocked'
    case 'activation_pending':
      return candidate.reason === 'restart_required' && candidate.dataPlane === 'blocked'
    case 'ready':
      return candidate.reason === null && candidate.dataPlane === 'available'
    case 'degraded':
      return (
        (candidate.reason === 'agent_unavailable' ||
          candidate.reason === 'configuration_invalid') &&
        candidate.dataPlane === 'available'
      )
    default:
      return false
  }
}
