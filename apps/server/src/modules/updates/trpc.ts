import type { ConvergenceState } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { type Context, t } from '../../trpc'
import { familyState } from '../derived-family'
import type { UpdatesService } from './service'

const IN_FLIGHT: ReadonlySet<ConvergenceState> = new Set(['granted', 'downloading', 'restarting'])
const FAILED: ReadonlySet<ConvergenceState> = new Set(['rejected', 'stuck'])

export interface UpdateFleetMachine {
  id: string
  version: string
  state: ConvergenceState
  online: boolean
  busy: boolean
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
  const machines = updates.fleet().map((machine) => ({ ...machine }))
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

/** The fleet read model used by the dialog and Settings. */
export function updateFleet(ctx: Context): UpdateFleetSnapshot {
  return fleetSnapshot(familyState(ctx).modules.updates)
}

/**
 * Human-authorized entry point for the server's own target. The wave service
 * remains the authority for what gets granted; this procedure only moves that
 * authority from the dialog into the already-landed convergence tick.
 */
export function convergeThisServer(
  updates: UpdatesService,
  currentVersion = process.env.PODIUM_APP_VERSION ?? 'dev',
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
  if (currentVersion === target.version) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The server is already at this version.',
    })
  }

  const grantedMachineIds = updates.tick()
  const fleet = fleetSnapshot(updates)
  // The server is the human-authorized place and is behind by definition here.
  // Attached machines are the remaining places in the automatic wave.
  return {
    state: 'in-progress',
    version: target.version,
    done: 0,
    total: Math.max(1, 1 + fleet.behind),
    fleet,
    grantedMachineIds,
  }
}

export function updateProcedures() {
  return {
    fleet: t.procedure.query(({ ctx }) => updateFleet(ctx)),
    converge: t.procedure.mutation(({ ctx }) => convergeThisServer(familyState(ctx).modules.updates)),
  }
}
