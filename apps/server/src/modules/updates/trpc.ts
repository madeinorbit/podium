import type { ConvergenceState } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { type Context, t } from '../../trpc'
import { serverBuildVersion } from '../../build-version'
import { familyState } from '../derived-family'
import type { UpdatesService } from './service'

const IN_FLIGHT: ReadonlySet<ConvergenceState> = new Set(['granted', 'downloading', 'restarting'])
const FAILED: ReadonlySet<ConvergenceState> = new Set(['rejected', 'stuck'])
const COORDINATOR_RESTART_POLL_MS = 250
/**
 * Backstop only. The wait normally ends when the grants it is waiting on stop
 * being in flight — the same inactivity deadline the service applies — so this
 * is deliberately generous and must never be the thing that ends a healthy,
 * slowly-progressing update.
 */
const COORDINATOR_RESTART_DEADLINE_MS = 60 * 60_000
const COORDINATOR_WAIT_ABANDONED_DETAIL =
  'The machine stopped reporting progress while updating, so the server stopped waiting for it.'

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
  /**
   * Every registered machine, whatever its channel. `machines` above is the
   * dev-authority wave the global dialog accounts for; Settings needs one row
   * per machine so an edge/stable row can show its own convergence.
   */
  allMachines: UpdateFleetMachine[]
}

function fleetSnapshot(updates: UpdatesService): UpdateFleetSnapshot {
  const targetVersion = updates.targetVersion()
  // The global dialog is the coordinating source server's dev-authority wave.
  // Edge/stable machines have their own explicit per-row targets and actions;
  // comparing them with the dev target invents behind places this mutation
  // cannot and must not grant.
  const allMachines = updates.fleet().map((machine) => ({ ...machine }))
  const machines = allMachines.filter((machine) => isDevelopmentMachine(machine))
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
    allMachines,
  }
}

/**
 * Wait for the development fleet to boot at the target, then restart the
 * coordinator.
 *
 * The wait is BOUNDED, and bounded by the SAME rule as the grants it waits on:
 * it continues while at least one outstanding machine is still in flight, and
 * stops as soon as none is. A daemon that never comes back used to leave this
 * polling every 250ms forever, holding the coordinator on the old build with
 * nothing in the UI ever failing; now the service's inactivity deadline turns
 * that machine into a visible `stuck` and this wait ends with it.
 *
 * It gives up WITHOUT restarting. Restarting under an unknown fleet state is
 * the outcome the handshake gate exists to prevent.
 */
export function restartCoordinatorAfterDevelopmentFleet(
  updates: UpdatesService,
  targetVersion: string,
  affectedMachineIds: readonly string[],
  requestCoordinatorRestart: () => void,
  pollMs = COORDINATOR_RESTART_POLL_MS,
  deadlineMs = COORDINATOR_RESTART_DEADLINE_MS,
  now: () => number = Date.now,
): void {
  const startedAt = now()
  const check = (): void => {
    // Reading the fleet is what ages a silent grant, so this poll and the
    // service share ONE notion of failure.
    const fleet = new Map(updates.fleet().map((machine) => [machine.id, machine]))
    const outstanding = affectedMachineIds.filter(
      (machineId) => !updates.machineBootedAtTarget(machineId, targetVersion),
    )
    if (outstanding.length === 0) {
      requestCoordinatorRestart()
      return
    }

    // Keep waiting exactly as long as the grants themselves are alive. A
    // machine reporting `restarting` at minute nine is progress, not a reason
    // to give up; the service's silence deadline decides when it stops being
    // progress, and this stops when it does. An absolute clock here would have
    // abandoned a working update the service was still happy with.
    const stillWorking = outstanding.some((machineId) => {
      const state = fleet.get(machineId)?.state
      return state !== undefined && IN_FLIGHT.has(state)
    })
    if (!stillWorking) return

    // Backstop only: never leave a timer running forever if a machine somehow
    // stays in flight without the service ever aging it out.
    if (now() - startedAt >= deadlineMs) {
      updates.abandonWait(outstanding, COORDINATOR_WAIT_ABANDONED_DETAIL)
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
    const affectedMachineIds = initialFleet.machines
      .filter((machine) => machine.online && machine.version !== target.version)
      .map((machine) => machine.id)
    restartCoordinatorAfterDevelopmentFleet(
      updates,
      target.version,
      affectedMachineIds,
      requestCoordinatorRestart,
    )
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
