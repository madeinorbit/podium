import type { UpdateChannel } from '@podium/model'
import type { ConvergenceState } from '@podium/protocol'

export interface WaveMachine {
  id: string
  name?: string
  channel?: UpdateChannel
  version: string
  state: ConvergenceState
  online: boolean
  /** Busy is only a canary preference; sessions survive the restart. */
  busy: boolean
  detail?: string
  /**
   * How this machine can take delivery, as its daemon reported at handshake
   * (`deliveryCaps` in apps/daemon/src/build-report.ts): a machine running from
   * SOURCE can only fetch git, an INSTALLED one can only take a feed or bundle.
   * Absent for a machine that has never reported a build.
   */
  deliveryCaps?: readonly string[]
}

/**
 * WHAT A TARGET CAN ACTUALLY BE DELIVERED AS.
 *
 * `headless` plus every `headlessAlternatives` entry, because the daemon's own
 * planner considers exactly that set (`planConvergence`).
 */
export function offeredDeliveries(target: {
  artifacts: {
    headless?: { delivery: string }
    headlessAlternatives?: readonly { delivery: string }[]
  }
}): string[] {
  return [
    ...(target.artifacts.headless ? [target.artifacts.headless.delivery] : []),
    ...(target.artifacts.headlessAlternatives ?? []).map((artifact) => artifact.delivery),
  ]
}

/**
 * WHETHER THIS MACHINE COULD TAKE THIS TARGET AT ALL — asked BEFORE granting.
 *
 * The daemon already answers this for itself and reports `cannot:
 * unsupported-delivery`. Asking only there means the fleet learns by FAILING:
 * the operator clicks Update, watches one machine converge, and then gets "The
 * machines do not support this update's delivery method" from the next one.
 *
 * Measured on the live fleet: two machines run from source (caps
 * `[update.delivery.git]`) and one is installed (caps `[feed, bundle]`, no git).
 * A `dev+<sha>` target with no packed tarball offers git ALONE, so the installed
 * machine could never take it — but a source machine reporting `current` ticked
 * the wave, which granted that machine the target anyway. `startUpdate` already
 * refuses to authorize such a target (`canGrantDevelopmentFleet`); nothing
 * enforced it where grants are actually issued.
 *
 * A machine that cannot take it is simply not selected. It stays `behind` —
 * honest, and it converges the moment a target it CAN take is published, which
 * for the development channel is the tarball being packed a minute later.
 *
 * UNKNOWN CAPS MEAN YES. A machine that has never reported a build predates the
 * report or has not handshaken yet; refusing it would silently strand it
 * forever, which is worse than the failure this prevents.
 */
export function machineCanTakeDelivery(
  machine: Pick<WaveMachine, 'deliveryCaps'>,
  deliveries: readonly string[],
): boolean {
  if (machine.deliveryCaps === undefined || machine.deliveryCaps.length === 0) return true
  if (deliveries.length === 0) return true
  return deliveries.some((delivery) =>
    machine.deliveryCaps?.includes(`update.delivery.${delivery}`),
  )
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
  /** How the target can be delivered; omitted means "do not filter on it". */
  deliveries?: readonly string[]
}): string[] {
  const deliveries = ctx.deliveries ?? []
  const inFlight = ctx.machines.filter((machine) => IN_FLIGHT.has(machine.state)).length
  const eligible = ctx.machines.filter(
    (machine) =>
      machine.online &&
      machine.version !== ctx.targetVersion &&
      !IN_FLIGHT.has(machine.state) &&
      !TERMINAL_FAILURE.has(machine.state) &&
      // Never hand a machine an update it has already told us it cannot take.
      machineCanTakeDelivery(machine, deliveries),
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
