import type { ConvergenceState } from '@podium/protocol'

export interface WaveMachine {
  id: string
  version: string
  state: ConvergenceState
  online: boolean
  /** Busy is only a canary preference; sessions survive the restart. */
  busy: boolean
  detail?: string
}

const IN_FLIGHT: ReadonlySet<ConvergenceState> = new Set(['granted', 'downloading', 'restarting'])
const TERMINAL_FAILURE: ReadonlySet<ConvergenceState> = new Set(['rejected', 'stuck'])

export function planWave(ctx: {
  machines: readonly WaveMachine[]
  targetVersion: string
  concurrency: number
  canaryHealthy: boolean
}): string[] {
  const inFlight = ctx.machines.filter((machine) => IN_FLIGHT.has(machine.state)).length
  const eligible = ctx.machines.filter(
    (machine) =>
      machine.online &&
      machine.version !== ctx.targetVersion &&
      !IN_FLIGHT.has(machine.state) &&
      !TERMINAL_FAILURE.has(machine.state),
  )

  if (eligible.length === 0) return []

  if (!ctx.canaryHealthy) {
    if (inFlight > 0) return []
    const idle = eligible.filter((machine) => !machine.busy)
    const pool = idle.length > 0 ? idle : eligible
    const canary = [...pool].sort((a, b) => a.id.localeCompare(b.id))[0]
    return canary ? [canary.id] : []
  }

  const room = Math.max(0, ctx.concurrency - inFlight)
  return [...eligible]
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, room)
    .map((machine) => machine.id)
}
