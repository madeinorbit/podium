import type { UpdateChannel } from '@podium/model'
import type { ConvergenceState, UpdateTrustRoot } from '@podium/protocol'

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
  /**
   * WHICH BYTES THIS MACHINE COULD EVEN RUN (POD-2783), in the release
   * manifest's own vocabulary — `darwin-aarch64`, `linux-x86_64` — derived from
   * the os/arch its daemon reported at handshake through `platformTargetFor`,
   * which is the same function the mint keys the manifest by.
   *
   * Absent for a machine that has never reported an inventory, and absent means
   * ELIGIBLE for the reason absent `deliveryCaps` does: a machine that has not
   * said what it is must stay visible rather than be silently stranded.
   */
  platform?: string
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

/**
 * WHETHER THIS DAEMON CAN HONOUR THE TARGET'S TRUST ROOT (POD-2932).
 *
 * `update.delivery.bundle` and delivery-keyed trust were retired together. A
 * daemon that still advertises that retired capability chooses its verifier by
 * delivery kind, so a feed artifact on the development channel is inevitably
 * checked against the baked release key instead of its pinned instance key.
 * Downloading it can only waste bytes and end in a false tampering alarm.
 *
 * This is deliberately a separate predicate from {@link machineCanTakeDelivery}:
 * the affected daemon really can receive a feed; it cannot honour `trust:
 * instance` for one. Unknown capabilities remain eligible, and release-trusted
 * targets remain compatible with every build. A new positive capability would
 * be cleaner for future builds but cannot be advertised retroactively by the
 * already-deployed, trust-capable builds between this retirement and today.
 */
export function machineCanUseTargetTrust(
  machine: Pick<WaveMachine, 'deliveryCaps'>,
  trust?: UpdateTrustRoot,
): boolean {
  if (trust !== 'instance') return true
  return !machine.deliveryCaps?.includes('update.delivery.bundle')
}

/**
 * WHETHER THIS RELEASE CONTAINS ANYTHING THIS MACHINE COULD RUN (POD-2783).
 *
 * The sibling of {@link machineCanTakeDelivery}, asked for the same reason and
 * at the same moment: BEFORE granting, so the fleet does not learn by failing.
 *
 * THE CASE IT EXISTS FOR IS PERMANENT, WHICH IS WHAT MAKES IT DIFFERENT. A
 * release's platform list is fixed when it is minted, from the machines that
 * were registered at that instant plus the publishing host
 * (`fleetHeadlessPlatforms`). A machine that enrols AFTERWARDS is not in that
 * list and never will be — the release is immutable. So this is not a transient
 * state that a retry, a reconnect, or an operator clears: the machine simply
 * has to wait for the next release, and being offered this one in the meantime
 * is an action that cannot succeed. A human found it by connecting a Mac to a
 * Linux-only fleet on their first try.
 *
 * The daemon's planner refuses exactly this and reports `unsupported-platform`,
 * so asking only there is the same defect POD-2004 fixed for delivery kinds one
 * axis over — and the answers cannot drift, because both sides read the target's
 * platform keys through `targetPlatforms` in `@podium/protocol`.
 *
 * UNKNOWN PLATFORM MEANS YES, matching the caps rule above. Omitting
 * `platforms` means the caller is not asking the platform question at all; an
 * EMPTY list is the opposite — a release with no bytes for anybody, which no
 * machine that has named itself can take.
 */
export function machineCanTakeTargetPlatform(
  machine: Pick<WaveMachine, 'platform'>,
  platforms?: readonly string[],
): boolean {
  if (machine.platform === undefined) return true
  if (platforms === undefined) return true
  return platforms.includes(machine.platform)
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

/**
 * WHY A MACHINE IS NOT IN THIS ROUND — the closed set (POD-2754).
 *
 * Every filter {@link decideWave} applies has exactly one of these names, so a
 * machine left out of a round is left out for a reason a reader can classify
 * rather than for no recorded reason at all. `canary-gated` is the one that
 * carries this rollout's whole safety promise: the machine was eligible, and the
 * only thing keeping it back was that nothing had yet proved this bundle.
 */
export type WaveExclusion =
  | 'source-checkout'
  | 'offline'
  | 'already-current'
  | 'in-flight'
  | 'terminal-verdict'
  | 'unsupported-delivery'
  /** The daemon chooses trust by delivery kind and cannot use its instance pin for a feed. */
  | 'legacy-instance-trust'
  /** The release carries no bytes for this machine's platform, and never will. */
  | 'unsupported-platform'
  | 'canary-gated'
  | 'wave-full'

/** One machine this round did not grant, and the single reason it did not. */
export interface WaveHold {
  id: string
  name?: string
  reason: WaveExclusion
}

/**
 * WHAT ONE PASS OF THE PLANNER DECIDED, INCLUDING ABOUT THE MACHINES IT PASSED
 * OVER (POD-2754).
 *
 * `planWave` answered with the selection alone, which is enough to ACT on and
 * not enough to be held to afterwards: "one machine was granted" and "one
 * machine was granted while two others were deliberately held for want of a
 * proved canary" are the same list. The second is the fact the rollout gate is
 * about, and it is only a fact if the holds are stated alongside the grants.
 *
 * `gate` says which of the planner's two modes produced this: `canary` while
 * nothing has proved the bundle, `widen` once something has.
 */
export interface WaveDecision {
  gate: 'canary' | 'widen'
  selected: string[]
  held: WaveHold[]
}

/**
 * ONE ROUND OF GRANTS, WRITTEN DOWN WHEN IT HAPPENS (POD-2754).
 *
 * A wave's shape is a sequence of transient states, and the gate that checks it
 * used to try to CATCH one — sampling the fleet every hundred milliseconds and
 * hoping a sample landed inside the window where exactly one machine was in
 * flight. On a fast update that window closes before the first sample, so a
 * correct rollout read as one that never gated at all. A sampling observer
 * cannot prove a transient fact; only a record can.
 *
 * So this is the record: every round that actually handed a machine an update,
 * what it granted, and every machine it held back with the reason. The canary
 * stage is then a fact anyone can read afterwards — the first round of an
 * operation's wave granted one machine and held the others `canary-gated` —
 * rather than a moment somebody had to be looking at.
 */
export interface WaveRound {
  /** Server clock at the instant the grants went out. */
  at: number
  gate: 'canary' | 'widen'
  /** The version this round was granting; a round is only about one target. */
  targetVersion: string
  granted: { id: string; name?: string }[]
  held: WaveHold[]
}

const hold = (machine: WaveMachine, reason: WaveExclusion): WaveHold => ({
  id: machine.id,
  ...(machine.name ? { name: machine.name } : {}),
  reason,
})

/**
 * Why this machine can take no grant at all right now — independent of the
 * canary gate and of how full the round is, which are the two reasons a
 * PERFECTLY ELIGIBLE machine still waits.
 */
function ineligibility(
  machine: WaveMachine,
  ctx: {
    targetVersion: string
    deliveries?: readonly string[]
    platforms?: readonly string[]
    trust?: UpdateTrustRoot
  },
): WaveExclusion | undefined {
  if (!isPackagedRolloutTarget(machine)) return 'source-checkout'
  if (machine.version === ctx.targetVersion) return 'already-current'
  if (IN_FLIGHT.has(machine.state)) return 'in-flight'
  if (TERMINAL_FAILURE.has(machine.state)) return 'terminal-verdict'
  if (!machine.online) return 'offline'
  // Never hand a machine an update it has already told us it cannot take,
  // applying the same predicate to canary selection and every later wave.
  if (!machineCanTakeDelivery(machine, ctx.deliveries)) return 'unsupported-delivery'
  if (!machineCanUseTargetTrust(machine, ctx.trust)) return 'legacy-instance-trust'
  // …and never one built before this machine existed. Delivery first because it
  // is the coarser fact: a machine that can take no delivery at all is not made
  // any more eligible by the release happening to carry its platform.
  if (!machineCanTakeTargetPlatform(machine, ctx.platforms)) return 'unsupported-platform'
  return undefined
}

export function decideWave(ctx: {
  machines: readonly WaveMachine[]
  targetVersion: string
  concurrency: number
  canaryHealthy: boolean
  /** How the target can be delivered; omitted means "do not filter on it". */
  deliveries?: readonly string[]
  /** Which platforms the target carries bytes for; omitted means "do not filter". */
  platforms?: readonly string[]
  /** Which key the target requires; absent means the baked release key. */
  trust?: UpdateTrustRoot
}): WaveDecision {
  const gate = ctx.canaryHealthy ? 'widen' : 'canary'
  const inFlight = ctx.machines.filter((machine) => IN_FLIGHT.has(machine.state)).length
  const held: WaveHold[] = []
  const eligible: WaveMachine[] = []
  for (const machine of ctx.machines) {
    const reason = ineligibility(machine, ctx)
    if (reason) held.push(hold(machine, reason))
    else eligible.push(machine)
  }

  if (eligible.length === 0) return { gate, selected: [], held }

  if (!ctx.canaryHealthy) {
    // A canary is already in flight: everything eligible waits on its verdict,
    // which is the same reason as below and deliberately named the same.
    const idle = eligible.filter((machine) => !machine.busy)
    const pool = idle.length > 0 ? idle : eligible
    const canary = inFlight > 0 ? undefined : [...pool].sort((a, b) => a.id.localeCompare(b.id))[0]
    for (const machine of eligible) {
      if (machine.id !== canary?.id) held.push(hold(machine, 'canary-gated'))
    }
    return { gate, selected: canary ? [canary.id] : [], held }
  }

  const room = Math.max(0, ctx.concurrency - inFlight)
  const ordered = [...eligible].sort((a, b) => a.id.localeCompare(b.id))
  for (const machine of ordered.slice(room)) held.push(hold(machine, 'wave-full'))
  return { gate, selected: ordered.slice(0, room).map((machine) => machine.id), held }
}

/** The selection alone, for every caller that acts on it rather than records it. */
export function planWave(ctx: {
  machines: readonly WaveMachine[]
  targetVersion: string
  concurrency: number
  canaryHealthy: boolean
  deliveries?: readonly string[]
  platforms?: readonly string[]
  trust?: UpdateTrustRoot
}): string[] {
  return decideWave(ctx).selected
}
