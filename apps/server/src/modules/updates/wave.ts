import type { UpdateChannel } from '@podium/model'
import type { ConvergenceState } from '@podium/protocol'

export interface WaveMachine {
  id: string
  channel?: UpdateChannel
  version: string
  state: ConvergenceState
  online: boolean
  /** Busy is only a canary preference; sessions survive the restart. */
  busy: boolean
  detail?: string
}

/** A grant has been issued and the machine has not yet reported a verdict. */
export const IN_FLIGHT_STATES: ReadonlySet<ConvergenceState> = new Set([
  'granted',
  'downloading',
  'restarting',
])
/** The machine reported (or was aged into) a verdict only a human can clear. */
export const TERMINAL_STATES: ReadonlySet<ConvergenceState> = new Set(['rejected', 'stuck'])

const IN_FLIGHT = IN_FLIGHT_STATES
const TERMINAL_FAILURE = TERMINAL_STATES

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
