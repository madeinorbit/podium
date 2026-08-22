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
   * How far this machine's current phase has got, as its last heartbeat said
   * (POD-2101). Absent for a daemon that predates progress reporting, or for a
   * delivery whose length nothing declared — never a manufactured zero.
   */
  percent?: number
  /** The phase that percentage is about — `downloading`, and nothing else now. */
  phaseDetail?: string
  /**
   * Whether this daemon owns a packaged install that a fleet grant can replace.
   * Absent for older reports and therefore deliberately eligible: uncertainty
   * must stay visible rather than silently dropping a machine from a wave.
   */
  installKind?: string
  /**
   * How this machine can take delivery, as its daemon reported at handshake
   * (`deliveryCaps` in apps/daemon/src/build-report.ts): an INSTALLED machine
   * offers `update.delivery.feed`, and a machine running from SOURCE offers no
   * delivery at all — it has no install directory to swap. Absent for a machine
   * that has never reported a build.
   */
  deliveryCaps?: readonly string[]
  /**
   * Podium Desktop supervises this daemon process. Its external payload remains
   * fleet-managed according to deliveryCaps. Absent means no desktop supervisor.
   */
  supervised?: boolean
}

/** Explicit source checkouts are operators of their files, not package consumers. */
export function isPackagedRolloutTarget(machine: Pick<WaveMachine, 'installKind'>): boolean {
  return machine.installKind !== 'source'
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
 * Measured on the live fleet when this was written: two machines ran from
 * source (caps `[update.delivery.git]`) and one was installed (caps
 * `[feed, bundle]`). A `dev+<sha>` target with no packed tarball offered git
 * ALONE, so the installed machine could never take it — but a source machine
 * reporting `current` ticked the wave, which granted that machine the target
 * anyway. The plan already refused to wave such a machine
 * (`machineCanTakeTargetNow`); nothing enforced it where grants are issued.
 *
 * THOSE CAP SETS ARE HISTORY, and the predicate is not. `bundle` and `git` are
 * retired (spec §1, disposition 5): an installed machine reports
 * `[update.delivery.feed]` and a source machine reports no delivery at all, so
 * the fleet's shapes have changed while the question has not. A source machine
 * is now exactly the case this guard was written for — it can take nothing, and
 * granting it a feed target would send it a quarter-gigabyte download it has
 * nowhere to install.
 *
 * A packaged machine that cannot take the current delivery is simply not selected.
 * Source checkouts are excluded earlier because they are not packaged rollout
 * targets; an unknown install kind remains eligible so uncertainty stays visible.
 *
 * UNKNOWN CAPS MEAN YES. A machine that has never reported a build predates the
 * report or has not handshaken yet; refusing it would silently strand it
 * forever, which is worse than the failure this prevents.
 *
 * `supervised` is deliberately irrelevant here. Desktop payloads now live in
 * Application Support and the shell is only their crash supervisor, so their
 * reported feed capability is authoritative exactly like an installed VPS.
 *
 */
export function machineCanTakeDelivery(
  machine: Pick<WaveMachine, 'deliveryCaps'>,
  deliveries?: readonly string[],
): boolean {
  if (machine.deliveryCaps === undefined || machine.deliveryCaps.length === 0) return true
  // Omitted means the caller is not asking the caps question. An empty list is
  // the opposite: a target that offers nothing, which nobody can take.
  if (deliveries === undefined) return true
  if (deliveries.length === 0) return false
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
  const inFlight = ctx.machines.filter((machine) => IN_FLIGHT.has(machine.state)).length
  const eligible = ctx.machines.filter(
    (machine) =>
      isPackagedRolloutTarget(machine) &&
      machine.online &&
      machine.version !== ctx.targetVersion &&
      !IN_FLIGHT.has(machine.state) &&
      !TERMINAL_FAILURE.has(machine.state) &&
      // Never hand a machine an update it has already told us it cannot take,
      // applying the same predicate to canary selection and every later wave.
      machineCanTakeDelivery(machine, ctx.deliveries),
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
