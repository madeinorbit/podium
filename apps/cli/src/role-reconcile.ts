// Real supervisor binding for the server-transfer role transition: turns the injectable
// `RoleSupervisor` seam into the actual detached-spawn / systemd-unit operations of this
// host. Source config demotion remains a separate durable coordinator mutation; this adapter
// reconciles roles only from a post-response replacement child.
// The pure policy lives in @podium/runtime/transfer-lifecycle — this module only binds it.
// Design: docs/internal/superpowers/specs/2026-08-06-server-transfer-design.md
import { loadConfig, localServerUrl, type PodiumConfig, resolvePort } from '@podium/runtime/config'
import { instanceServiceName, resolveInstanceId } from '@podium/runtime/instance'
import { liveRecord, type RunRole, reclaim } from '@podium/runtime/run-registry'
import {
  promoteTargetServer,
  type RoleSupervisor,
  type TargetServerRuntimeOutcome,
  runRoleTransition,
} from '@podium/runtime/transfer-lifecycle'
import { spawnDetached, waitForHealth } from './cli-spawn'
import {
  disableSystemdUnits,
  disarmSystemdUnits,
  enableSystemdUnits,
  hasSystemctl,
  hasUserSystemd,
  renderDaemonUnit,
  renderJanitorUnit,
  renderServerUnit,
  systemdUnitActive,
  systemdUnitManaged,
  writeUserUnit,
} from './cli-systemd'

/** Injectable hooks over the real process/supervisor calls, for tests. */
export interface ManagedSupervisorDeps {
  /** Defaults to cli-spawn's detached spawner. */
  spawnRole?: (role: RunRole, ctx: { port: number; serverUrl?: string }) => number | undefined
  /** Defaults to writeUserUnit (render + write a single role unit). */
  writeUnit?: (role: RunRole, unit: string, body: string) => string
  /** Defaults to cli-systemd's enable --now. */
  enableUnits?: (units: string[]) => void
  /** Defaults to cli-systemd's disable --now. */
  disableUnits?: (units: string[]) => void
  /** Defaults to cli-systemd's disable without --now. */
  disarmUnits?: (units: string[]) => void
  /** Defaults to a real systemctl probe. */
  systemdAvailable?: () => boolean
  /** Defaults to cli-spawn's health poll. */
  waitForServer?: (port: number) => Promise<boolean>
  /** Fixed-unit systemd status probes; injectable so tests never touch a user manager. */
  unitActive?: (unit: string) => boolean
  unitManaged?: (unit: string) => boolean
}

/** The user-unit name for a managed role. */
export function roleUnit(role: RunRole, id: string = resolveInstanceId()): string {
  if (role === 'all-in-one') throw new Error(`the all-in-one role has no unit of its own: ${role}`)
  return instanceServiceName(role, id)
}

/** The rendered unit body for one role, from the shared renderers. */
export function roleUnitBody(
  role: RunRole,
  ctx: { port: number; serverUrl?: string },
  id: string = resolveInstanceId(),
): string {
  switch (role) {
    case 'server':
      return renderServerUnit(id)
    case 'janitor':
      return renderJanitorUnit({ port: ctx.port, instanceId: id })
    case 'daemon':
      // Bare `podium daemon`: serverUrl + pair code come from config, which the cutover
      // (or promotion) has already rewritten — never pin a stale URL into the unit.
      return renderDaemonUnit({ instanceId: id })
    case 'all-in-one':
      throw new Error(`no unit exists for the all-in-one role`)
  }
}

function defaultSystemdAvailable(): boolean {
  return hasSystemctl() && hasUserSystemd()
}

/**
 * The real {@link RoleSupervisor} for this host. `persistence` selects the binding:
 * `systemd` (when a user systemd session actually exists) drives the units — a role is
 * stopped by `disable --now` (so `Restart=always` can never restore it) and started by
 * `enable --now`; anything else spawns/reclaims detached processes, mirroring how
 * `installSystemd` falls back. Every real call is routed through `deps` so tests can
 * record it without touching the system.
 */
export interface ManagedRoleSupervisor extends RoleSupervisor {
  management: 'systemd' | 'detached'
}

export function managedRoleSupervisor(
  persistence: PodiumConfig['persistence'],
  deps: ManagedSupervisorDeps = {},
): ManagedRoleSupervisor {
  const systemd = persistence === 'systemd' && (deps.systemdAvailable ?? defaultSystemdAvailable)()
  const spawnRole =
    deps.spawnRole ??
    ((role, ctx) => {
      if (role === 'daemon') return spawnDetached('daemon', {})
      if (role === 'janitor')
        // The janitor always dials the LOCAL server it keeps house for.
        return spawnDetached('janitor', {
          port: ctx.port,
          serverUrl: localServerUrl(ctx.port),
        })
      return spawnDetached('server', { port: ctx.port })
    })
  const writeUnit = deps.writeUnit ?? ((_role, _unit, body) => writeUserUnit(_unit, body))
  const enableUnits = deps.enableUnits ?? enableSystemdUnits
  const disableUnits = deps.disableUnits ?? disableSystemdUnits
  const disarmUnits = deps.disarmUnits ?? disarmSystemdUnits
  const waitForServer = deps.waitForServer ?? waitForHealth
  const unitActive = deps.unitActive ?? systemdUnitActive
  const unitManaged = deps.unitManaged ?? systemdUnitManaged

  return {
    management: systemd ? 'systemd' : 'detached',
    roleLive(role) {
      if (systemd && role !== 'all-in-one' && unitActive(roleUnit(role))) return true
      return Boolean(liveRecord(role))
    },
    roleManaged(role) {
      if (systemd && role !== 'all-in-one' && unitManaged(roleUnit(role))) return true
      return Boolean(liveRecord(role))
    },
    async stopRole(role) {
      if (systemd && role !== 'all-in-one') {
        if (unitManaged(roleUnit(role))) {
          disableUnits([roleUnit(role)])
        }
      }
      await reclaim(role)
    },
    async disarmRole(role) {
      if (systemd && role !== 'all-in-one' && unitManaged(roleUnit(role))) {
        disarmUnits([roleUnit(role)])
      }
    },
    async startRole(role, ctx) {
      // Defensive second half of the "never a second server" invariant: the plan already
      // excludes live roles, but a live holder appearing between plan and start must not
      // be double-launched either.
      if (liveRecord(role)) return
      if (systemd && role !== 'all-in-one' && unitActive(roleUnit(role))) return
      if (systemd) {
        writeUnit(role, roleUnit(role), roleUnitBody(role, ctx))
        enableUnits([roleUnit(role)])
        return
      }
      spawnRole(role, ctx)
    },
    serverUp(port) {
      return waitForServer(port)
    },
  }
}

/** Reconcile the promoted target while retaining its in-flight daemon for the RPC reply. */
export async function promoteTargetServerRole(
  input: { transferId: string },
  deps: { supervisor?: RoleSupervisor } = {},
): Promise<TargetServerRuntimeOutcome> {
  const config = loadConfig()
  if (config.mode !== 'server' || !config.publicUrl) {
    throw new Error('target server promotion requires durable mode=server and publicUrl config')
  }
  const supervisor = deps.supervisor ?? managedRoleSupervisor(config.persistence)
  const outcome = await promoteTargetServer(
    {
      transferId: input.transferId,
      publicUrl: config.publicUrl,
      ...(config.port ? { port: config.port } : {}),
    },
    supervisor,
  )
  if (!outcome.proven) throw new Error('promoted server did not become healthy')
  return outcome
}

/**
 * Stop the old target daemon only after the control layer has a positive delivery
 * acknowledgement. Promotion itself deliberately retains the daemon: elapsed time cannot prove a
 * reply was delivered, and a lost reply must remain retryable.
 */
export async function retireTargetDaemon(deps: {
  supervisor?: RoleSupervisor
  acknowledged: true
}): Promise<void> {
  const config = loadConfig()
  if (config.mode !== 'server') return
  const supervisor = deps.supervisor ?? managedRoleSupervisor(config.persistence)
  await supervisor.stopRole('daemon')
}

export interface SourceServingRetirementResult {
  owner: 'desktop' | 'systemd' | 'foreground'
  stopped: RunRole[]
  started: RunRole[]
}

/**
 * Reconcile source serving roles after the committed mutation reply is flushed. A desktop-marked
 * host exits without spawning or claiming a daemon because the native supervisor owns the
 * replacement. A real systemd deployment enables its daemon unit; detached/foreground mode lets
 * the already-spawned takeover worker become the daemon after stale roles are reclaimed.
 */
export async function retireSourceServingRoles(
  deps: {
    supervisor?: RoleSupervisor & { management?: 'systemd' | 'detached' }
    env?: Readonly<Record<string, string | undefined>>
  } = {},
): Promise<SourceServingRetirementResult> {
  const config = loadConfig()
  if (config.mode !== 'daemon') return { owner: 'foreground', stopped: [], started: [] }
  const env = deps.env ?? process.env
  if (env.PODIUM_DESKTOP_SUPERVISED === '1') {
    return { owner: 'desktop', stopped: [], started: [] }
  }
  const supervisor = deps.supervisor ?? managedRoleSupervisor(config.persistence)
  if (supervisor.management === 'systemd') {
    const transition = await runRoleTransition(
      { mode: 'daemon', port: resolvePort(config), supervisor },
      config.serverUrl,
    )
    return {
      owner: 'systemd',
      stopped: transition.stopped,
      started: transition.started,
    }
  }
  const stopped: RunRole[] = []
  for (const role of ['server', 'janitor', 'daemon'] as const) {
    if (!supervisor.roleLive(role) && !supervisor.roleManaged?.(role)) continue
    await supervisor.stopRole(role)
    stopped.push(role)
  }
  return { owner: 'foreground', stopped, started: [] }
}

/** Backward-compatible name used by the explicit daemon takeover path. */
export const prepareForegroundDaemon = retireSourceServingRoles
