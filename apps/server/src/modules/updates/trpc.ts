import type { ConvergenceState } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { type Context, t } from '../../trpc'
import { serverBuildVersion } from '../../build-version'
import { familyState } from '../derived-family'
import type { UpdatesService } from './service'

const IN_FLIGHT: ReadonlySet<ConvergenceState> = new Set(['granted', 'downloading', 'restarting'])
const FAILED: ReadonlySet<ConvergenceState> = new Set(['rejected', 'stuck'])
const COORDINATOR_RESTART_POLL_MS = 250

function isDevelopmentMachine(machine: { channel?: string }): boolean {
  return (machine.channel ?? 'dev') === 'dev'
}

export interface UpdateFleetMachine {
  id: string
  version: string
  state: ConvergenceState
  online: boolean
  busy: boolean
  detail?: string
}

export interface UpdateFleetSnapshot {
  targetVersion: string | null
  total: number
  behind: number
  converging: number
  failed: number
  machines: UpdateFleetMachine[]
}

function fleetSnapshot(updates: UpdatesService): UpdateFleetSnapshot {
  const targetVersion = updates.targetVersion()
  // The global dialog is the coordinating source server's dev-authority wave.
  // Edge/stable machines have their own explicit per-row targets and actions;
  // comparing them with the dev target invents behind places this mutation
  // cannot and must not grant.
  const machines = updates
    .fleet()
    .filter((machine) => isDevelopmentMachine(machine))
    .map((machine) => ({ ...machine }))
  const behind = targetVersion
    ? machines.filter((machine) => machine.version !== targetVersion).length
    : 0

  return {
    targetVersion: targetVersion ?? null,
    total: machines.length,
    behind,
    converging: machines.filter((machine) => IN_FLIGHT.has(machine.state)).length,
    failed: machines.filter((machine) => FAILED.has(machine.state)).length,
    machines,
  }
}

export function restartCoordinatorAfterDevelopmentFleet(
  updates: UpdatesService,
  targetVersion: string,
  requestCoordinatorRestart: () => void,
  pollMs = COORDINATOR_RESTART_POLL_MS,
): void {
  const check = (): void => {
    const developmentStillApplying = updates
      .fleet()
      .some(
        (machine) =>
          isDevelopmentMachine(machine) &&
          machine.online &&
          machine.version !== targetVersion,
      )
    if (!developmentStillApplying) {
      requestCoordinatorRestart()
      return
    }
    const timer = setTimeout(check, pollMs)
    timer.unref?.()
  }
  check()
}

/** The fleet read model used by the dialog and Settings. */
export function updateFleet(ctx: Context): UpdateFleetSnapshot {
  return fleetSnapshot(familyState(ctx).modules.updates)
}

/**
 * Human-authorized entry point for every place behind the server's target. The
 * wave service remains the authority for what gets granted; this procedure
 * records the operator's one decision and starts its planner-controlled wave.
 */
export function startUpdate(
  updates: UpdatesService,
  currentVersion = serverBuildVersion(),
  requestCoordinatorRestart?: () => void,
): {
  state: 'in-progress'
  version: string
  done: number
  total: number
  fleet: UpdateFleetSnapshot
  grantedMachineIds: string[]
} {
  const target = updates.target()
  if (!target) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'No update target is configured.',
    })
  }
  const initialFleet = fleetSnapshot(updates)
  const serverBehind = currentVersion !== target.version
  if (!serverBehind && initialFleet.behind === 0 && initialFleet.converging === 0) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Podium is already at this version everywhere.',
    })
  }

  const grantedMachineIds = updates.authorize()
  const fleet = fleetSnapshot(updates)
  if (serverBehind && requestCoordinatorRestart) {
    restartCoordinatorAfterDevelopmentFleet(updates, target.version, requestCoordinatorRestart)
  }
  return {
    state: 'in-progress',
    version: target.version,
    done: 0,
    total: Math.max(
      1,
      (serverBehind ? 1 : 0) + Math.max(initialFleet.behind, initialFleet.converging),
    ),
    fleet,
    grantedMachineIds,
  }
}

export function updateProcedures() {
  return {
    fleet: t.procedure.query(({ ctx }) => updateFleet(ctx)),
    converge: t.procedure.mutation(({ ctx }) =>
      startUpdate(
        familyState(ctx).modules.updates,
        serverBuildVersion(),
        ctx.requestCoordinatorRestart,
      ),
    ),
  }
}
