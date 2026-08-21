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
   * How this machine can take delivery, as its daemon reported at handshake
   * (`deliveryCaps` in apps/daemon/src/build-report.ts): an INSTALLED machine
   * offers `update.delivery.feed`, and a machine running from SOURCE offers no
   * delivery at all — it has no install directory to swap. Absent for a machine
   * that has never reported a build.
   */
  deliveryCaps?: readonly string[]
  /**
   * This daemon lives inside Podium Desktop, which supervises and updates it as
   * part of its signed bundle. Absent means an ordinary fleet machine.
   */
  supervised?: boolean
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
 * A machine that cannot take it is simply not selected. It stays `behind` —
 * honest, and it converges the moment a target it CAN take is published.
 *
 * UNKNOWN CAPS MEAN YES. A machine that has never reported a build predates the
 * report or has not handshaken yet; refusing it would silently strand it
 * forever, which is worse than the failure this prevents.
 *
 * A SUPERVISED DAEMON IS NEVER YES, whatever its caps say (POD-2099). It lives
 * inside Podium Desktop, so its bytes are part of a signed application bundle:
 * on the macOS all-in-one it reports `installed` with a real feed cap, and
 * granting it would send `swapHeadlessBundle` to rename directories INSIDE the
 * .app. The shell update carries that daemon
 * atomically (spec §4, §5), which is why the exclusion is structural here
 * rather than a platform check somewhere — no surface may update someone else's
 * native app (P5). This precedes the caps question because it is not a question
 * about delivery methods: there is no method by which the fleet may deliver.
 */
export function machineCanTakeDelivery(
  machine: Pick<WaveMachine, 'deliveryCaps' | 'supervised'>,
  deliveries: readonly string[],
): boolean {
  if (machine.supervised === true) return false
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
      // Never hand a machine an update it has already told us it cannot take,
      // and never hand one to a daemon a desktop app owns. Both live in one
      // predicate, and it is applied to the ELIGIBLE set — so a supervised
      // machine cannot be picked as the canary either, which is the selection
      // that would otherwise slip past a filter placed further down.
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
