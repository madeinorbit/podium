/**
 * Single-unit topology migration [POD-2506].
 *
 * Spec §4 + §8 disposition 24: every install converges to one `podium.service`
 * (systemd), a detached parent with no units, or a foreground
 * `machine-cannot-restart` refusal. The health gate that retires legacy units
 * depends only on the NEW parent proving healthy — never on the old topology
 * being able to restart itself. A legacy 3-unit host honestly cannot restart
 * (POD-2505); that is the expected pre-migration state, not an error.
 *
 * Crash-kill at any step leaves the legacy topology fully armed OR the new
 * topology fully active — never neither. Runtime masks on legacy units do not
 * persist across reboot, so a kill mid-handover always reboots into an armed
 * set.
 *
 * Pure decision helpers live here so the choreography is testable without
 * systemd. The CLI binds them in `apps/cli/src/topology-reconcile.ts`.
 */
import { DEFAULT_INSTANCE_ID, instanceServiceName, instanceTimerName } from './instance'
import type { RunRole } from './run-registry'
import type { SupervisedChild } from './parent-supervisor'

/** How this box is (or is not) supervised. Unmanaged = foreground in-process. */
export type PersistenceShape = 'systemd' | 'detached' | 'unmanaged'

/**
 * Which topology would come back after a kill + reboot.
 *
 * `both` is the safe overlap during handover: parent enabled AND legacy still
 * enabled. Runtime masks do not count against legacy — they vanish on reboot.
 * `neither` is the forbidden outcome the tests police; the planner never
 * produces an observation that classifies as it.
 */
export type ArmedTopology = 'legacy' | 'new' | 'both' | 'neither'

export type MigrationAction =
  | { type: 'noop' }
  | { type: 'write-parent' }
  | { type: 'enable-parent' }
  | { type: 'mask-legacy' }
  | { type: 'start-parent' }
  | { type: 'await-healthy' }
  | { type: 'retire-legacy' }
  | { type: 'abort-keep-legacy'; reason: string }
  | { type: 'spawn-detached-parent' }
  | { type: 'reclaim-stale-roles' }
  | { type: 'refuse-foreground' }

export interface TopologyObservation {
  persistence: PersistenceShape
  mode: 'all-in-one' | 'server' | 'daemon' | 'client' | undefined
  instanceId: string
  /** Parent unit file exists in the user unit dir. */
  parentUnitPresent: boolean
  parentUnitEnabled: boolean
  parentUnitActive: boolean
  parentProcessLive: boolean
  /**
   * Disposition 24: children up, server serving the NEW version, local daemon
   * connected. Daemon-only: the daemon child is running. Never bare /health.
   */
  parentHealthy: boolean
  /**
   * Honest incapacity from POD-2505: no supervising parent is registered.
   * Expected on a legacy 3-unit host. NOT an error and NOT a reason to abort.
   */
  cannotRestart: boolean
  /** Unit files present (names only). */
  installedUnits: readonly string[]
  enabledUnits: readonly string[]
  activeUnits: readonly string[]
  /** Runtime-masked units. Gone on reboot — do not treat as disarmed. */
  maskedUnits: readonly string[]
  liveRoles: readonly RunRole[]
  /** Health wait expired without parentHealthy. */
  healthTimedOut?: boolean
}

/** Canonical parent unit: `podium.service` / `podium-<id>.service`. */
export function desiredParentUnit(instanceId: string = DEFAULT_INSTANCE_ID): string {
  return instanceServiceName('parent', instanceId)
}

/**
 * Intermediate name from POD-2505 (`podium-parent.service`). Treated as legacy
 * so a host that already wrote it still converges to `podium.service`.
 */
export function leftoverParentUnit(instanceId: string = DEFAULT_INSTANCE_ID): string {
  const id = instanceId || DEFAULT_INSTANCE_ID
  return id === DEFAULT_INSTANCE_ID ? 'podium-parent.service' : `podium-${id}-parent.service`
}

/**
 * Every unit (and the health timer) a host might still have from the 3-unit VPS
 * or 8-definition dev topology. Includes the POD-2505 leftover parent name.
 * Order is stable so tests and `systemctl` argv are deterministic.
 */
export function legacyUnitNames(instanceId: string = DEFAULT_INSTANCE_ID): string[] {
  const id = instanceId || DEFAULT_INSTANCE_ID
  const scoped = (role: string): string =>
    id === DEFAULT_INSTANCE_ID ? `podium-${role}.service` : `podium-${id}-${role}.service`
  const backend =
    id === DEFAULT_INSTANCE_ID ? 'podium-backend.service' : `podium-${id}-backend.service`
  const systemDaemon =
    id === DEFAULT_INSTANCE_ID
      ? 'podium-daemon-system.service'
      : `podium-${id}-daemon-system.service`
  return [
    leftoverParentUnit(id),
    scoped('server'),
    scoped('janitor'),
    scoped('daemon'),
    scoped('redeploy'),
    scoped('health'),
    instanceTimerName('health', id),
    backend,
    systemDaemon,
  ]
}

/** The 8 definitions a dev host sheds (no leftover parent name). */
export function devLegacyDefinitions(instanceId: string = DEFAULT_INSTANCE_ID): string[] {
  return legacyUnitNames(instanceId).filter((name) => name !== leftoverParentUnit(instanceId))
}

export function presentLegacyUnits(
  installed: readonly string[],
  instanceId: string = DEFAULT_INSTANCE_ID,
): string[] {
  const set = new Set(legacyUnitNames(instanceId))
  return installed.filter((name) => set.has(name))
}

export function enabledLegacyUnits(
  enabled: readonly string[],
  instanceId: string = DEFAULT_INSTANCE_ID,
): string[] {
  const set = new Set(legacyUnitNames(instanceId))
  return enabled.filter((name) => set.has(name))
}

/** OS children the parent spawns for this deployment mode. */
export function parentChildrenForMode(
  mode: TopologyObservation['mode'],
): readonly SupervisedChild[] {
  if (mode === 'daemon') return ['daemon']
  if (mode === 'server') return ['server']
  return ['server', 'daemon']
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)]
}

function withName(names: readonly string[], name: string): string[] {
  return unique([...names, name])
}

function withoutNames(names: readonly string[], drop: readonly string[]): string[] {
  const set = new Set(drop)
  return names.filter((name) => !set.has(name))
}

/**
 * Classify what a reboot would start, given the CURRENT observation.
 *
 * Runtime masks are ignored: they do not survive reboot, so a masked-but-still-
 * enabled legacy unit is armed. Parent file-present-but-not-enabled is inert.
 */
export function armedIfKilled(obs: TopologyObservation): ArmedTopology {
  if (obs.persistence === 'unmanaged') return 'legacy'
  if (obs.persistence === 'detached') {
    if (obs.parentProcessLive || obs.liveRoles.includes('parent')) return 'new'
    const leftover = obs.liveRoles.some(
      (role) => role === 'server' || role === 'daemon' || role === 'janitor',
    )
    return leftover ? 'legacy' : 'new'
  }
  const parent = obs.parentUnitEnabled
  const legacy = enabledLegacyUnits(obs.enabledUnits, obs.instanceId).length > 0
  if (parent && legacy) return 'both'
  if (parent) return 'new'
  if (legacy) return 'legacy'
  return 'neither'
}

/**
 * One step of the handover. Idempotent: a converged observation yields `noop`.
 *
 * Sequencing (systemd):
 *   write-parent → enable-parent → mask-legacy → start-parent → await-healthy
 *   → retire-legacy  (or abort-keep-legacy if the health wait expires)
 *
 * Mask-before-takeover is what stops `Restart=always` on the legacy server unit
 * from fighting the parent's `--takeover` bind. The mask is `--runtime`, so a
 * kill here still reboots into both topologies armed.
 *
 * `cannotRestart === true` is expected until the parent process is live; it
 * never triggers abort.
 */
export function planMigration(obs: TopologyObservation): MigrationAction {
  if (obs.persistence === 'unmanaged') return { type: 'refuse-foreground' }
  if (obs.mode === 'client') return { type: 'noop' }

  if (obs.persistence === 'detached') return planDetached(obs)
  return planSystemd(obs)
}

function planDetached(obs: TopologyObservation): MigrationAction {
  if (obs.parentProcessLive) {
    const stale = obs.liveRoles.filter((role) => role === 'janitor')
    if (stale.length > 0) return { type: 'reclaim-stale-roles' }
    return { type: 'noop' }
  }
  return { type: 'spawn-detached-parent' }
}

function planSystemd(obs: TopologyObservation): MigrationAction {
  const legacyInstalled = presentLegacyUnits(obs.installedUnits, obs.instanceId)
  const legacyEnabled = enabledLegacyUnits(obs.enabledUnits, obs.instanceId)
  const unmaskedEnabled = legacyEnabled.filter((name) => !obs.maskedUnits.includes(name))

  if (obs.parentHealthy && legacyInstalled.length === 0 && obs.parentUnitEnabled) {
    return { type: 'noop' }
  }

  if (obs.healthTimedOut && !obs.parentHealthy) {
    return {
      type: 'abort-keep-legacy',
      reason:
        'new parent did not become healthy (children up, new version serving, daemon connected) — leaving the legacy topology fully armed',
    }
  }

  if (obs.parentHealthy && (legacyInstalled.length > 0 || legacyEnabled.length > 0)) {
    return { type: 'retire-legacy' }
  }

  if (!obs.parentUnitPresent) return { type: 'write-parent' }
  if (!obs.parentUnitEnabled) return { type: 'enable-parent' }

  // Mask enabled legacy units before the parent takeovers, so systemd does not
  // resurrect the process the parent just reclaimed. Skip units already masked.
  if (unmaskedEnabled.length > 0 && !obs.parentHealthy) return { type: 'mask-legacy' }

  if (!obs.parentUnitActive && !obs.parentProcessLive) return { type: 'start-parent' }

  if (!obs.parentHealthy) return { type: 'await-healthy' }

  if (legacyInstalled.length > 0 || legacyEnabled.length > 0) return { type: 'retire-legacy' }
  return { type: 'noop' }
}

/**
 * Pure semantics of each action, used by tests to walk the machine and pull
 * the plug after every step. The CLI adapter's side-effects must match this.
 */
export function applyAction(obs: TopologyObservation, action: MigrationAction): TopologyObservation {
  const desired = desiredParentUnit(obs.instanceId)
  switch (action.type) {
    case 'noop':
    case 'refuse-foreground':
    case 'await-healthy':
      return obs
    case 'write-parent':
      return {
        ...obs,
        parentUnitPresent: true,
        installedUnits: withName(obs.installedUnits, desired),
      }
    case 'enable-parent':
      return {
        ...obs,
        parentUnitPresent: true,
        parentUnitEnabled: true,
        installedUnits: withName(obs.installedUnits, desired),
        enabledUnits: withName(obs.enabledUnits, desired),
      }
    case 'mask-legacy':
      return {
        ...obs,
        maskedUnits: unique([...obs.maskedUnits, ...enabledLegacyUnits(obs.enabledUnits, obs.instanceId)]),
      }
    case 'start-parent':
      return {
        ...obs,
        parentUnitActive: true,
        parentProcessLive: true,
        cannotRestart: false,
        liveRoles: unique([...obs.liveRoles, 'parent']) as RunRole[],
      }
    case 'retire-legacy':
      return {
        ...obs,
        installedUnits: withoutNames(obs.installedUnits, legacyUnitNames(obs.instanceId)),
        enabledUnits: withoutNames(obs.enabledUnits, legacyUnitNames(obs.instanceId)),
        activeUnits: withoutNames(obs.activeUnits, legacyUnitNames(obs.instanceId)),
        maskedUnits: [],
        liveRoles: obs.liveRoles.filter((role) => role === 'parent' || role === 'all-in-one'),
      }
    case 'abort-keep-legacy':
      return {
        ...obs,
        parentUnitEnabled: false,
        parentUnitActive: false,
        parentProcessLive: false,
        parentHealthy: false,
        cannotRestart: true,
        healthTimedOut: false,
        maskedUnits: [],
        enabledUnits: withoutNames(obs.enabledUnits, [desired]),
        liveRoles: obs.liveRoles.filter((role) => role !== 'parent'),
      }
    case 'spawn-detached-parent':
      return {
        ...obs,
        parentProcessLive: true,
        parentHealthy: true,
        cannotRestart: false,
        liveRoles: unique(
          [...obs.liveRoles.filter((role) => role !== 'janitor'), 'parent'],
        ) as RunRole[],
      }
    case 'reclaim-stale-roles':
      return {
        ...obs,
        liveRoles: obs.liveRoles.filter((role) => role !== 'janitor'),
      }
  }
}

/** Simulate a reboot: runtime masks vanish; inactive-but-enabled units come back. */
export function reboot(obs: TopologyObservation): TopologyObservation {
  const enabled = obs.enabledUnits
  return {
    ...obs,
    maskedUnits: [],
    parentUnitActive: obs.parentUnitEnabled,
    parentProcessLive: obs.parentUnitEnabled,
    // Health is not proven across a reboot — the new parent must pass the gate again.
    parentHealthy: false,
    cannotRestart: !obs.parentUnitEnabled,
    healthTimedOut: false,
    activeUnits: enabled,
    liveRoles: [
      ...(obs.parentUnitEnabled ? (['parent'] as const) : []),
      ...(enabledLegacyUnits(enabled, obs.instanceId).some((name) => name.includes('server'))
        ? (['server'] as const)
        : []),
      ...(enabledLegacyUnits(enabled, obs.instanceId).some((name) => name.includes('daemon'))
        ? (['daemon'] as const)
        : []),
    ],
  }
}

/** Starting observation for a 3-unit VPS (the §4 migration origin). */
export function legacyVpsObservation(
  instanceId: string = DEFAULT_INSTANCE_ID,
): TopologyObservation {
  const units =
    instanceId === DEFAULT_INSTANCE_ID
      ? ['podium-server.service', 'podium-janitor.service', 'podium-daemon.service']
      : [
          `podium-${instanceId}-server.service`,
          `podium-${instanceId}-janitor.service`,
          `podium-${instanceId}-daemon.service`,
        ]
  return {
    persistence: 'systemd',
    mode: 'all-in-one',
    instanceId,
    parentUnitPresent: false,
    parentUnitEnabled: false,
    parentUnitActive: false,
    parentProcessLive: false,
    parentHealthy: false,
    cannotRestart: true,
    installedUnits: units,
    enabledUnits: units,
    activeUnits: units,
    maskedUnits: [],
    liveRoles: ['server', 'janitor', 'daemon'],
  }
}

/** Starting observation for a source-checkout dev host (8 definitions). */
export function legacyDevObservation(
  instanceId: string = DEFAULT_INSTANCE_ID,
): TopologyObservation {
  const units = devLegacyDefinitions(instanceId)
  return {
    ...legacyVpsObservation(instanceId),
    installedUnits: units,
    enabledUnits: units.filter((name) => !name.endsWith('-system.service') && !name.includes('backend')),
    activeUnits: units.filter(
      (name) =>
        name.includes('server') || name.includes('janitor') || name.includes('daemon.service'),
    ),
  }
}

export function convergedObservation(
  instanceId: string = DEFAULT_INSTANCE_ID,
): TopologyObservation {
  const desired = desiredParentUnit(instanceId)
  return {
    persistence: 'systemd',
    mode: 'all-in-one',
    instanceId,
    parentUnitPresent: true,
    parentUnitEnabled: true,
    parentUnitActive: true,
    parentProcessLive: true,
    parentHealthy: true,
    cannotRestart: false,
    installedUnits: [desired],
    enabledUnits: [desired],
    activeUnits: [desired],
    maskedUnits: [],
    liveRoles: ['parent', 'server', 'daemon'],
  }
}
