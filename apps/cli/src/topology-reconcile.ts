/**
 * Bind the topology-migration state machine to this host's systemd / run-registry.
 *
 * Runs at every boot (and after the parent health gate) so version-skipping
 * installs and dev hosts converge identically. Does not spawn OS children —
 * it only writes/enables/starts the parent unit (or a detached parent) and,
 * once THAT parent reports healthy, retires leftover units. Signal handlers
 * stay the parent's job, installed before it spawns anything (POD-2505).
 */
import { readdirSync } from 'node:fs'
import { loadConfig, type PodiumConfig, resolvePort } from '@podium/runtime/config'
import { resolveInstanceId } from '@podium/runtime/instance'
import { liveRecord, listLive, reclaim } from '@podium/runtime/run-registry'
import {
  armedIfKilled,
  desiredParentUnit,
  enabledLegacyUnits,
  leftoverParentUnit,
  legacyUnitNames,
  planMigration,
  presentLegacyUnits,
  type PersistenceShape,
  type TopologyObservation,
} from '@podium/runtime/topology-migration'
import { spawnDetached } from './cli-spawn'
import {
  disarmSystemdUnits,
  enableSystemdUnits,
  maskSystemdUnitsRuntime,
  removeUserUnits,
  renderParentUnit,
  startSystemdUnits,
  systemdUnitActive,
  systemdUnitManaged,
  unmaskSystemdUnits,
  userUnitDir,
  writeUserUnit,
} from './cli-systemd'

export interface TopologyReconcileDeps {
  config?: PodiumConfig
  instanceId?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  unitDir?: () => string
  listUnitFiles?: (dir: string) => string[]
  unitActive?: (unit: string) => boolean
  unitEnabled?: (unit: string) => boolean
  unitMasked?: (unit: string) => boolean
  writeUnit?: (unit: string, body: string) => string
  enableUnits?: (units: string[]) => void
  startUnits?: (units: string[]) => void
  disarmUnits?: (units: string[]) => void
  maskUnits?: (units: string[]) => void
  unmaskUnits?: (units: string[]) => void
  removeUnits?: (units: string[]) => void | Promise<void>
  spawnParent?: (port: number) => number | undefined
  reclaimRole?: (role: 'janitor') => Promise<void>
  parentHealthy?: () => boolean | Promise<boolean>
  /** How long await-healthy may sit before abort-keep-legacy. Default 90s. */
  healthTimeoutMs?: number
  /** Test seam: stop after this many actions. */
  maxSteps?: number
  /** Fault-injection seam used by the isolated live kill matrix. */
  checkpoint?: (checkpoint: TopologyMigrationCheckpoint) => void | Promise<void>
}

export type TopologyMigrationCheckpoint =
  | { phase: 'before-parent-write' }
  | { phase: 'after-parent-write' }
  | { phase: 'after-parent-enable' }
  | { phase: 'after-legacy-runtime-mask' }
  | { phase: 'after-parent-start' }
  | { phase: 'during-parent-health-wait' }
  | { phase: 'after-parent-healthy-before-retire' }
  | { phase: 'after-stop-legacy-unit'; unit: string; remaining: number }
  | { phase: 'after-all-legacy-stopped-before-remove' }

function persistenceShape(
  persistence: PodiumConfig['persistence'],
  env: NodeJS.ProcessEnv,
): PersistenceShape {
  if (env.PODIUM_DESKTOP_SUPERVISED === '1') return 'unmanaged'
  if (persistence === 'systemd') return 'systemd'
  if (persistence === 'detached') return 'detached'
  return 'unmanaged'
}

function parentIsRegistered(env: NodeJS.ProcessEnv): boolean {
  if (env.PODIUM_UNDER_PARENT === '1') return true
  try {
    return liveRecord('parent') !== undefined
  } catch {
    return false
  }
}

function defaultListUnitFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => /\.(service|timer)$/.test(name))
  } catch {
    return []
  }
}

export function observeTopology(deps: TopologyReconcileDeps = {}): TopologyObservation {
  const env = deps.env ?? process.env
  const config = deps.config ?? loadConfig()
  const instanceId = deps.instanceId ?? resolveInstanceId()
  const dir = (deps.unitDir ?? userUnitDir)()
  const installed = (deps.listUnitFiles ?? defaultListUnitFiles)(dir)
  const unitActive = deps.unitActive ?? systemdUnitActive
  const unitEnabled = deps.unitEnabled ?? systemdUnitManaged
  const desired = desiredParentUnit(instanceId)
  const enabled = installed.filter((name) => {
    try {
      return unitEnabled(name)
    } catch {
      return false
    }
  })
  const active = installed.filter((name) => {
    try {
      return unitActive(name)
    } catch {
      return false
    }
  })
  const masked = (deps.unitMasked ? installed.filter((name) => deps.unitMasked!(name)) : []).filter(
    Boolean,
  )
  const live = listLive()
  const parentLive = Boolean(liveRecord('parent'))
  return {
    persistence: persistenceShape(config.persistence, env),
    mode: config.mode,
    instanceId,
    parentUnitPresent: installed.includes(desired),
    parentUnitEnabled: enabled.includes(desired),
    parentUnitActive: active.includes(desired) || parentLive,
    parentProcessLive: parentLive,
    parentHealthy: false,
    cannotRestart: !parentIsRegistered(env),
    installedUnits: installed,
    enabledUnits: enabled,
    activeUnits: active,
    maskedUnits: masked,
    liveRoles: live.map((r) => r.role),
  }
}

export interface ReconcileResult {
  actions: string[]
  armed: ReturnType<typeof armedIfKilled>
  observation: TopologyObservation
}

/**
 * Apply the state machine until it idles, refuses, or is waiting on the parent
 * health gate. Callers that ARE the parent pass `parentHealthy` after the boot
 * gate; callers that are the legacy server start the parent and return so they
 * can keep serving until takeover.
 */
export async function reconcileSupervision(deps: TopologyReconcileDeps = {}): Promise<ReconcileResult> {
  const env = deps.env ?? process.env
  const config = deps.config ?? loadConfig()
  const instanceId = deps.instanceId ?? resolveInstanceId()
  const port = resolvePort(config)
  const maxSteps = deps.maxSteps ?? 12
  const actions: string[] = []
  let obs = observeTopology(deps)
  const startedAt = (deps.now ?? Date.now)()
  const healthTimeoutMs = deps.healthTimeoutMs ?? 90_000
  let healthyCheckpointPassed = false

  for (let i = 0; i < maxSteps; i++) {
    if (
      obs.persistence === 'systemd' &&
      (obs.parentProcessLive || obs.parentUnitActive) &&
      !obs.parentHealthy &&
      deps.parentHealthy
    ) {
      obs = { ...obs, parentHealthy: await deps.parentHealthy() }
      if (obs.parentHealthy && !healthyCheckpointPassed) {
        await deps.checkpoint?.({ phase: 'after-parent-healthy-before-retire' })
        healthyCheckpointPassed = true
      }
    }
    if (
      !obs.parentHealthy &&
      (obs.parentProcessLive || obs.parentUnitActive) &&
      (deps.now ?? Date.now)() - startedAt >= healthTimeoutMs
    ) {
      obs = { ...obs, healthTimedOut: true }
    }
    const action = planMigration(obs)
    actions.push(action.type)
    if (action.type === 'noop' || action.type === 'refuse-foreground') {
      return { actions, armed: armedIfKilled(obs), observation: obs }
    }
    if (action.type === 'await-healthy') {
      await deps.checkpoint?.({ phase: 'during-parent-health-wait' })
      // The parent owns the health wait. A legacy server that only started the
      // parent returns here so it can keep serving until takeover; the parent
      // re-enters with parentHealthy=true after its boot gate.
      if (!deps.parentHealthy) {
        return { actions, armed: armedIfKilled(obs), observation: obs }
      }
      continue
    }
    switch (action.type) {
      case 'write-parent': {
        await deps.checkpoint?.({ phase: 'before-parent-write' })
        const write = deps.writeUnit ?? writeUserUnit
        write(desiredParentUnit(instanceId), renderParentUnit({ instanceId, port }))
        obs = {
          ...obs,
          parentUnitPresent: true,
          installedUnits: [...new Set([...obs.installedUnits, desiredParentUnit(instanceId)])],
        }
        await deps.checkpoint?.({ phase: 'after-parent-write' })
        break
      }
      case 'enable-parent': {
        const enable = deps.enableUnits ?? enableSystemdUnits
        enable([desiredParentUnit(instanceId)])
        obs = {
          ...obs,
          parentUnitEnabled: true,
          enabledUnits: [...new Set([...obs.enabledUnits, desiredParentUnit(instanceId)])],
        }
        await deps.checkpoint?.({ phase: 'after-parent-enable' })
        break
      }
      case 'mask-legacy': {
        const units = enabledLegacyUnits(obs.enabledUnits, instanceId)
        const mask = deps.maskUnits ?? maskSystemdUnitsRuntime
        mask(units)
        obs = { ...obs, maskedUnits: [...new Set([...obs.maskedUnits, ...units])] }
        await deps.checkpoint?.({ phase: 'after-legacy-runtime-mask' })
        break
      }
      case 'start-parent': {
        const start = deps.startUnits ?? startSystemdUnits
        start([desiredParentUnit(instanceId)])
        obs = {
          ...obs,
          parentUnitActive: true,
          parentProcessLive: true,
          cannotRestart: false,
        }
        await deps.checkpoint?.({ phase: 'after-parent-start' })
        break
      }
      case 'retire-legacy': {
        const units = presentLegacyUnits(obs.installedUnits, instanceId)
        const remove =
          deps.removeUnits ??
          ((names: string[]) =>
            removeUserUnits(names, {
              afterStop: (unit, remaining) =>
                deps.checkpoint?.({ phase: 'after-stop-legacy-unit', unit, remaining }),
              beforeRemove: () =>
                deps.checkpoint?.({ phase: 'after-all-legacy-stopped-before-remove' }),
            }))
        await remove(units)
        obs = {
          ...obs,
          installedUnits: obs.installedUnits.filter((name) => !units.includes(name)),
          enabledUnits: obs.enabledUnits.filter((name) => !units.includes(name)),
          activeUnits: obs.activeUnits.filter((name) => !units.includes(name)),
          maskedUnits: [],
        }
        break
      }
      case 'abort-keep-legacy': {
        const legacy = enabledLegacyUnits(obs.enabledUnits, instanceId)
        const unmask = deps.unmaskUnits ?? unmaskSystemdUnits
        const start = deps.startUnits ?? startSystemdUnits
        const disarm = deps.disarmUnits ?? disarmSystemdUnits
        unmask(legacy)
        start(legacy)
        disarm([desiredParentUnit(instanceId)])
        console.error(`podium: ${action.reason}`)
        obs = {
          ...obs,
          parentUnitEnabled: false,
          parentUnitActive: false,
          parentProcessLive: false,
          parentHealthy: false,
          cannotRestart: true,
          maskedUnits: [],
          enabledUnits: obs.enabledUnits.filter((name) => name !== desiredParentUnit(instanceId)),
        }
        return { actions, armed: armedIfKilled(obs), observation: obs }
      }
      case 'spawn-detached-parent': {
        const spawn = deps.spawnParent ?? ((p: number) => spawnDetached('parent', { port: p }))
        spawn(port)
        obs = {
          ...obs,
          parentProcessLive: true,
          cannotRestart: false,
          liveRoles: [...obs.liveRoles.filter((r) => r !== 'janitor'), 'parent'],
        }
        break
      }
      case 'reclaim-stale-roles': {
        const reclaimRole = deps.reclaimRole ?? ((role: 'janitor') => reclaim(role).then(() => {}))
        await reclaimRole('janitor')
        obs = { ...obs, liveRoles: obs.liveRoles.filter((r) => r !== 'janitor') }
        break
      }
    }
  }
  return { actions, armed: armedIfKilled(obs), observation: obs }
}

/** True when this process should kick off migration (legacy role, not already a child). */
export function shouldKickoffMigration(
  env: NodeJS.ProcessEnv = process.env,
  config: PodiumConfig = loadConfig(),
): boolean {
  if (env.PODIUM_UNDER_PARENT === '1') return false
  if (env.PODIUM_PARENT_SUCCESSOR === '1') return false
  const shape = persistenceShape(config.persistence, env)
  return shape === 'systemd' || shape === 'detached'
}

export { desiredParentUnit, leftoverParentUnit, legacyUnitNames }
