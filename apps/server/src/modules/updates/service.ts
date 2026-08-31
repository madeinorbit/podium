import { createLogger } from '@podium/logger'
import type { MachineId, UpdateChannel } from '@podium/model'
import { asMachineId, resolveMachineChannel } from '@podium/model'
import type {
  ConvergenceState,
  UpdateGrantMessage,
  UpdateStatusMessage,
  UpdateTarget,
} from '@podium/protocol'
import { isHeadlessPlatform, isProvablyNewer, targetPlatforms } from '@podium/protocol'
import {
  decideWave,
  IN_FLIGHT_STATES,
  isPackagedRolloutTarget,
  machineCanTakeTargetPlatform,
  machineCanUseTargetTrust,
  offeredDeliveries,
  planWave,
  TERMINAL_STATES,
  type WaveMachine,
  type WaveRound,
} from './wave'

const log = createLogger('server:updates')

export interface UpdatesDeps {
  machines(): readonly WaveMachine[]
  channelFor?(machineId: MachineId): UpdateChannel | undefined
  send(machineId: MachineId, message: UpdateGrantMessage): void
  now(): number
  nextGrantId(): string
  /** Current publisher key, diagnostic-only in a grant; never replaces a daemon pin. */
  updatePubkey?(): string
  concurrency: number
  /**
   * Pull one channel's target from its feed. EVERY channel, `dev` included
   * (spec §1): dev used to be excluded here because its target was pushed by
   * the publisher, and that exclusion is what made it the one channel whose
   * resolution path nothing else exercised.
   */
  resolveTarget?(channel: UpdateChannel): Promise<UpdateTarget>
  /**
   * Does THIS server also mint targets for this channel? True for `dev` on a
   * source host, false everywhere else. See {@link UpdatesService.resolvedMayReplace}
   * for what it decides and why it is not simply "never go backwards".
   */
  locallyPublished?(channel: UpdateChannel): boolean
  /**
   * The instance's fleet default channel, read PER CALL so a Settings write is
   * followed without a restart (the same discipline `MachinesService` uses for
   * it). Absent only in tests that state no fleet default; see
   * `resolveMachineChannel`.
   */
  fleetChannel?(): UpdateChannel
  /** Overridable only so tests can exercise the forced-check window. */
  forcedCheckIntervalMs?: number
  /**
   * Is a durable exclusive operation (spec §3.0's `lifecycle` group) running?
   *
   * SINGLE-FLIGHT'S OTHER HALF (P6, POD-2098). Refusing a second `updates.start`
   * is not enough: a new version can be PUBLISHED mid-update by the release
   * feed's refresh timer or by the development publisher, and the old behaviour
   * let that publication mutate the running wave. Read per call, not captured —
   * the answer changes on every transition.
   */
  exclusiveOperationActive?(): boolean
  /**
   * Which version is the running exclusive operation DELIVERING on this channel?
   *
   * THE OTHER HALF OF "IT IS NOT A NEW VERSION" (POD-2228). {@link setTarget}
   * lets a descriptor for the version already published land mid-operation,
   * because a `dev+` identity gaining its tarball is the same update acquiring
   * its bytes. That test asked the wrong witness: the in-memory target. A
   * successor process has none — a restart empties the map — so the publication
   * the ADOPTED operation was waiting for was read as a rival version, queued,
   * and never applied. The operation then waited for a package this service was
   * holding, and the channel was blocked for every other publication until a
   * human cancelled it.
   *
   * The operation carries its target in `details.target`, so the running
   * operation always knows the answer even when this service has forgotten it.
   * Read per call, like {@link exclusiveOperationActive}: it changes on every
   * transition. Absent, or `undefined`, degrades to the memory test alone.
   */
  exclusiveOperationVersion?(channel: UpdateChannel): string | undefined
  /** A packaged rollback may be reported before target resolution finishes. */
  onTargetChanged?(channel: UpdateChannel): void
}

/** What one channel's last release-target lookup produced. */
export type ChannelCheckOutcome = { status: 'ok' } | { status: 'unavailable'; reason: string }

/**
 * One channel's refresh bookkeeping — the answer to "when did this instance last
 * ask, and what did it hear?".
 *
 * Without it a boot-time failure is indistinguishable from a target that was
 * checked a minute ago and genuinely has nothing published, which is exactly the
 * state Settings has to be able to describe ("checked 2 h ago"). Spec §9.2 makes
 * the cadence part of the contract: shown, not implied.
 */
export interface ChannelCheckRecord {
  channel: UpdateChannel
  checkedAt: number
  outcome: ChannelCheckOutcome
}

/** Rendering order for {@link UpdatesService.channelChecks}; not a priority. */
const CHANNEL_ORDER: readonly UpdateChannel[] = ['dev', 'edge', 'stable']

/**
 * How often a human-driven check may actually reach the release feed. Two
 * clients with the panel open, or one impatient person, must not turn a button
 * into a request loop; inside the window the recorded outcome is returned
 * unchanged, which is the honest answer ("this is what we know, as of then").
 */
const FORCED_CHECK_INTERVAL_MS = 30_000

interface MachineConvergenceState {
  channel: UpdateChannel
  state: ConvergenceState
  version: string
  /** Present only when this state was correlated with the active grant. */
  grantId?: string
  detail?: string
  /** Last reported progress within the phase, when the daemon reports one. */
  percent?: number
  phaseDetail?: string
}

interface PendingGrant {
  channel: UpdateChannel
  grantId: string
  issuedAt: number
}

/**
 * WHERE THE GRANT DEADLINE WENT (POD-2101, spec §3.3).
 *
 * This service used to hold a ten-minute deadline that aged a silent grant into
 * `stuck` — but only from inside `fleet()`, so it aged when somebody READ the
 * fleet and not when time passed. An update nobody was watching was an update
 * nothing was timing, which is the defect P4 names: deadlines fire on timers.
 *
 * The authority is now the operation's `machines` step, whose budget the engine
 * arms a real timer for (`UPDATE_STEP_DEADLINES`). What this service still owns
 * is ENDING a grant when told to: {@link abandonWait} for a specific verdict,
 * {@link reissueGrants} for the one automatic retry, and
 * {@link releaseInFlightGrants} when the operation that owned them terminates.
 */
export const GRANT_TIMED_OUT_DETAIL = 'The machine stopped reporting progress while updating.'

/**
 * The stable token that fronts a stuck detail written by {@link
 * UpdatesService.setTargetUnavailable} (POD-2241).
 *
 * The reason itself is free prose composed by the development publisher
 * ("Building the development bundle for dev+abc…", or a pack failure's public
 * reason), and free prose is precisely what no reader can classify: before this
 * token, a machine ended by a WITHDRAWN target read as `machine-unreachable`,
 * so the operator was sent to go and check a machine that was never the problem
 * and that had done nothing wrong.
 *
 * Only the per-machine detail is tokenized. The channel's own
 * `unavailableReason` — what Settings shows for the target — stays the bare
 * sentence, because there it is the whole answer rather than one machine's
 * verdict.
 */
export const TARGET_WITHDRAWN_TOKEN = 'update-withdrawn'

/** The one decision an explicit per-machine Apply can produce. */
export type MachineApplyOutcome =
  | { result: 'granted'; version: string }
  | { result: 'already-current'; version: string }
  | { result: 'source-checkout' }
  | { result: 'offline' }
  | { result: 'unknown-machine' }
  | { result: 'no-target'; reason: string }
  | { result: 'in-flight'; state: ConvergenceState }
  | { result: 'legacy-instance-trust'; version: string }
  /**
   * THE TWO ANSWERS THAT ARE NOT ABOUT TODAY (POD-2783).
   *
   * A release's platform list is fixed when it is minted, from the fleet as it
   * stood then, so a machine that enrolled afterwards can never take that
   * release however many times a human presses Apply. `platform-not-published`
   * is the harder version: Podium builds nothing for that platform at all.
   * Both carry the platform, because a row that says "no" without saying what
   * it is is the sentence this issue exists to delete.
   */
  | { result: 'platform-not-in-release'; platform: string }
  | { result: 'platform-not-published'; platform: string }

export function legacyInstanceTrustMessage(machineName: string): string {
  return (
    `${machineName} predates channel-keyed update trust. It can receive this development feed, ` +
    'but its updater will verify it with the baked release key instead of the pinned instance ' +
    'key. Changing or rotating that key cannot make this build use its pin; use the supported ' +
    'host-local stranded-machine repair.'
  )
}

interface ChannelRolloutState {
  authorized: boolean
  canaryHealthy: boolean
  halted: boolean
}

const freshRollout = (): ChannelRolloutState => ({
  authorized: false,
  canaryHealthy: false,
  halted: false,
})

function hasHeadlessBytes(target: UpdateTarget): boolean {
  return target.artifacts.headless !== undefined
}

function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.href
  } catch {
    return url
  }
}

function stripArtifactCredentials<T extends { platforms: Record<string, { url: string }> }>(
  artifact: T,
): T {
  return {
    ...artifact,
    platforms: Object.fromEntries(
      Object.entries(artifact.platforms).map(([platform, asset]) => [
        platform,
        { ...asset, url: stripUrlCredentials(asset.url) },
      ]),
    ),
  }
}

/**
 * `/version` is unauthenticated. The standing channel target keeps the token
 * so a grant can fetch; the advertisement must not.
 */
function withoutArtifactCredentials(target: UpdateTarget): UpdateTarget {
  const artifacts = { ...target.artifacts }
  if (artifacts.headless) artifacts.headless = stripArtifactCredentials(artifacts.headless)
  if (artifacts.headlessAlternatives) {
    artifacts.headlessAlternatives = artifacts.headlessAlternatives.map(stripArtifactCredentials)
  }
  if (artifacts.desktop) artifacts.desktop = stripArtifactCredentials(artifacts.desktop)
  return { ...target, artifacts }
}

/**
 * Server-owned convergence orchestration. Each channel names a separate
 * authority: `dev` is signed by this coordinating source server, while `edge`
 * and `stable` retain release-feed trust. Machines are planned only against the
 * target selected by their persisted channel.
 */
export class UpdatesService {
  private readonly targets = new Map<UpdateChannel, UpdateTarget>()
  private readonly unavailableReasons = new Map<UpdateChannel, string>()
  private readonly rollouts = new Map<UpdateChannel, ChannelRolloutState>()
  private readonly machineStates = new Map<string, MachineConvergenceState>()
  private readonly pendingGrants = new Map<string, PendingGrant>()
  // Keep only target-named terminal boot reports until the feed resolves.
  // Uncorrelated progress remains discarded so rollback fencing is unchanged.
  private readonly terminalStatusesBeforeTarget = new Map<
    UpdateChannel,
    Map<string, UpdateStatusMessage>
  >()
  // Keep target-named terminal boot reports while a reconnecting machine is
  // absent from the live directory; replay them once it is visible again.
  private readonly terminalStatusesBeforeMachine = new Map<string, UpdateStatusMessage>()
  private readonly checks = new Map<UpdateChannel, ChannelCheckRecord>()
  /** One shared resolve per channel, for EVERY caller of `refreshTarget` (POD-2153). */
  private readonly refreshesInFlight = new Map<UpdateChannel, Promise<boolean>>()
  /** Versions published while an exclusive operation held the group (§3.2). */
  private readonly nextTargets = new Map<UpdateChannel, UpdateTarget>()
  /**
   * EVERY ROUND OF GRANTS THIS PROCESS HAS ISSUED, PER CHANNEL (POD-2754).
   *
   * Append-only and in-memory, which is the whole reason it is not the durable
   * copy: a wave outlives this process — the coordinator replaces itself
   * halfway through one. {@link waveRounds} is what the update operation copies
   * into its own persisted record, and that record is what anybody reads
   * afterwards. This is only the buffer between the instant a round happens and
   * the next time the operation writes itself down.
   */
  private readonly waveHistory = new Map<UpdateChannel, WaveRound[]>()

  constructor(private readonly deps: UpdatesDeps) {}

  /**
   * The rounds this process has issued on this channel, oldest first. Callers
   * scope by target version and by their own start time; see {@link WaveRound}.
   */
  waveRounds(channel: UpdateChannel): readonly WaveRound[] {
    return this.waveHistory.get(channel) ?? []
  }

  targetVersion(machineId?: MachineId): string | undefined {
    return machineId === undefined
      ? this.target('dev')?.version
      : this.targetFor(machineId)?.version
  }

  /** The immutable descriptor currently published for one authority channel. */
  target(channel: UpdateChannel = 'dev'): UpdateTarget | undefined {
    return this.targets.get(channel)
  }

  /** Resolve a machine through its durable channel choice. */
  targetFor(machineId: MachineId): UpdateTarget | undefined {
    const channel = this.channelForMachine(machineId)
    return channel ? this.target(channel) : undefined
  }

  /** Explain why a machine's selected authority cannot currently advertise a target. */
  targetUnavailableReasonFor(machineId: MachineId): string | undefined {
    const channel = this.channelForMachine(machineId)
    if (!channel) return 'Machine is no longer registered.'
    if (this.target(channel)) return undefined
    return (
      this.unavailableReasons.get(channel) ??
      `${channel} target has not been resolved by this coordinator.`
    )
  }

  /**
   * Retract a channel's target and say why, in words a client may see.
   *
   * Withdrawing is the point: a `dev` target for an older commit must not keep
   * being served once this HEAD cannot produce one, or the fleet converges on a
   * version that no longer describes the source server. Machines already
   * converged are untouched — this removes the offer, it does not roll anything
   * back.
   */
  setTargetUnavailable(channel: UpdateChannel, reason: string): void {
    this.unavailableReasons.set(channel, reason)
    this.targets.delete(channel)
    this.rollouts.delete(channel)
    // A queued version on a channel that can no longer advertise anything is not
    // waiting its turn, it is stale. Publishing it later would offer an update
    // this coordinator has just said it cannot produce.
    this.nextTargets.delete(channel)
    for (const [machineId, pending] of this.pendingGrants) {
      if (pending.channel === channel) this.pendingGrants.delete(machineId)
    }
    // Dropping the pending record alone would strand any machine mid-grant:
    // `onStatus` ignores reports once the target is gone, nothing ages a grant
    // that no longer exists, and the row would sit in granted/downloading
    // forever. End those rows observably instead, carrying the same reason the
    // read model shows, so the fleet says "this stopped, and here is why".
    for (const [machineId, state] of this.machineStates) {
      if (state.channel !== channel) continue
      if (state.state === 'current' || state.state === 'rejected' || state.state === 'stuck') {
        continue
      }
      this.machineStates.set(machineId, {
        ...state,
        state: 'stuck',
        detail: `${TARGET_WITHDRAWN_TOKEN}: ${reason}`,
      })
    }
    this.deps.onTargetChanged?.(channel)
  }

  setTarget(channel: UpdateChannel, target: UpdateTarget): void
  /** Compatibility form for the existing development publisher. */
  setTarget(target: UpdateTarget): void
  setTarget(channelOrTarget: UpdateChannel | UpdateTarget, maybeTarget?: UpdateTarget): void {
    const channel = typeof channelOrTarget === 'string' ? channelOrTarget : 'dev'
    const target = typeof channelOrTarget === 'string' ? maybeTarget : channelOrTarget
    if (!target) throw new Error(`missing ${channel} update target`)

    // Re-publishing the same label replaces its artifact descriptor without
    // invalidating the proof already made for that target: a dev+ identity
    // gaining its packed tarball is the SAME update acquiring the bytes it is
    // about to deliver, and the running operation is waiting for exactly that.
    // So it lands immediately even mid-operation — it is not a new version.
    //
    // TWO WITNESSES, because after a restart only the second one exists
    // (POD-2228): the version this coordinator has published, and the version
    // the running operation is delivering. A successor's `targets` map is empty,
    // so asking memory alone made the adopted operation's own package look like
    // a rival publication — queued, never applied, and blocking the channel.
    //
    // WHAT IS GONE (POD-2098, spec §3.2/§10.2): this used to also `tick()` an
    // authorized wave from here, which made publishing a descriptor a way to
    // start granting. Sequencing is the operation's job now — the `machines`
    // step ticks explicitly, after `prepare`, exactly once, where a reader can
    // see it happen.
    if (this.isSameUpdate(channel, target.version)) {
      const standing = this.targets.get(channel)
      // The deliverable always comes from the feed. An identity for the same
      // version names no bytes, and replacing the packed target with it is how
      // a published package sat on "Waiting for the update package" — every
      // `/version` poll re-publishes the identity, including mid-operation.
      if (standing && hasHeadlessBytes(standing) && !hasHeadlessBytes(target)) {
        return
      }
      this.unavailableReasons.delete(channel)
      this.targets.set(channel, target)
      this.replayTerminalStatuses(channel, target.version)
      this.deps.onTargetChanged?.(channel)
      return
    }

    // A DIFFERENT version arriving mid-operation is queued, never applied (P6,
    // §3.2, §8's "a new version lands mid-update"). Mutating the wave under a
    // running update is what made a mid-flight publication change what the panel
    // was describing; the queued target re-surfaces as an OFFER once the
    // operation terminates — it never becomes an operation by itself.
    if (this.deps.exclusiveOperationActive?.()) {
      this.nextTargets.set(channel, target)
      return
    }

    this.unavailableReasons.delete(channel)
    this.targets.set(channel, target)
    this.rollouts.set(channel, freshRollout())
    for (const [machineId, state] of this.machineStates) {
      if (state.channel === channel) this.machineStates.delete(machineId)
    }
    for (const [machineId, pending] of this.pendingGrants) {
      if (pending.channel === channel) this.pendingGrants.delete(machineId)
    }
    this.replayTerminalStatuses(channel, target.version)
    this.deps.onTargetChanged?.(channel)
  }

  /**
   * Replay only terminal reports that name the target just resolved. Reports
   * for another release are stale and must not influence a later operation.
   */
  private replayTerminalStatuses(channel: UpdateChannel, targetVersion: string): void {
    this.replayTerminalStatusesForKnownMachines()
    const deferred = this.terminalStatusesBeforeTarget.get(channel)
    if (!deferred) return
    this.terminalStatusesBeforeTarget.delete(channel)
    for (const [machineId, message] of deferred) {
      if (message.targetVersion === targetVersion) {
        this.onStatus(asMachineId(machineId), message)
      }
    }
  }

  /**
   * Replay terminal reports held while a reconnecting machine was absent.
   * Once the directory has it again, exact target fencing still decides whether
   * the report may affect the operation.
   */
  private replayTerminalStatusesForKnownMachines(): void {
    if (this.terminalStatusesBeforeMachine.size === 0) return
    const machines = this.deps.machines()
    for (const [machineId, message] of this.terminalStatusesBeforeMachine) {
      const machine = machines.find((candidate) => candidate.id === machineId)
      if (!machine) continue
      const target = this.target(this.channelOf(machine))
      if (!target) continue
      this.terminalStatusesBeforeMachine.delete(machineId)
      if (message.targetVersion === target.version) {
        this.onStatus(asMachineId(machineId), message)
      }
    }
  }

  /**
   * Is this arriving version the update already under way on this channel —
   * rather than a rival publication? See {@link UpdatesDeps.exclusiveOperationVersion}.
   */
  private isSameUpdate(channel: UpdateChannel, version: string): boolean {
    if (this.targets.get(channel)?.version === version) return true
    return this.deps.exclusiveOperationVersion?.(channel) === version
  }

  /**
   * The version waiting its turn on this channel, if one was published while an
   * operation held the group. Read by the fleet model and by the panel: "0.4.4
   * will be offered when this update finishes" is a true sentence the old design
   * had no way to say.
   */
  nextTarget(channel: UpdateChannel): UpdateTarget | undefined {
    return this.nextTargets.get(channel)
  }

  /**
   * Publish everything that was queued — called on an operation's TERMINAL
   * transition, whatever the outcome.
   *
   * It re-creates the OFFER, not an operation (§3.2). The human decision that
   * started the finished operation was about the version that operation carried;
   * it is not consent to install whatever landed while it ran.
   */
  publishNextTargets(): UpdateChannel[] {
    const published: UpdateChannel[] = []
    for (const [channel, target] of [...this.nextTargets]) {
      this.nextTargets.delete(channel)
      // Guarded, not asserted: if something else already moved this channel
      // onto that version, re-applying it would reset a wave for no reason.
      if (this.targets.get(channel)?.version === target.version) continue
      this.setTarget(channel, target)
      published.push(channel)
    }
    return published
  }

  /**
   * Refresh one selected authority without turning a failed lookup into a stale grant.
   *
   * SINGLE-FLIGHT PER CHANNEL, and it lives HERE rather than at any call site
   * (POD-2153). Six production callers reach this method — the two boot resolves
   * and the periodic tick in `server.ts`, `onFleetChannelChanged`, and both fleet
   * handlers — plus {@link checkNow}. The in-flight map used to sit on the forced
   * check alone, which guarded that one caller against itself and nothing else.
   *
   * The duplicate feed request is the lesser half. The greater half is that every
   * one of these paths ends in {@link setTarget}, which is last-writer-wins by
   * COMPLETION order, not request order: a slow resolve that started first can
   * land after a fresh one and overwrite a newer target with a staler one. Sharing
   * one promise per channel removes the overlap that makes the ordering question
   * exist at all, so the guard cannot be reintroduced by adding a seventh caller.
   */
  refreshTarget(channel: UpdateChannel): Promise<boolean> {
    const inFlight = this.refreshesInFlight.get(channel)
    if (inFlight) return inFlight

    const refresh = this.resolveIntoTarget(channel).finally(() => {
      // Identity-checked so a slot re-taken by a later caller is never deleted by
      // an earlier one settling; `finally` also covers the failure path, or one
      // unreachable second would pin the channel shut for the life of the process.
      if (this.refreshesInFlight.get(channel) === refresh) {
        this.refreshesInFlight.delete(channel)
      }
    })
    this.refreshesInFlight.set(channel, refresh)
    return refresh
  }

  /**
   * MAY A FRESHLY PULLED TARGET REPLACE THE STANDING ONE?
   *
   * Normally yes, unconditionally, and that is load bearing: the server is
   * authority, so a channel that moves BACKWARDS — a bad release withdrawn, an
   * edge tag repointed — must be able to roll the fleet back. A resolver that
   * only ever moved forward would make rollback structurally impossible, which
   * is the same reasoning `planConvergence` is built on.
   *
   * THE ONE EXCEPTION IS A CHANNEL THIS SERVER ALSO PUBLISHES INTO. On a source
   * host, `dev` has two producers for the length of this transition: the feed
   * (what has been RELEASED) and the local publisher's identity (what this
   * checkout IS, spec §6 step 1, until POD-2507 turns it into a release
   * proposal). When HEAD moves without a release they disagree, and they
   * disagree in a knowable direction — the identity is a mint on the same
   * lineage, so it is PROVABLY newer. Letting the daily refresh pull the last
   * release over it would walk the read model back to a previous commit every
   * time the tick fired, which is exactly what `devIdentityTarget`'s "never
   * advertise an older commit's" rule existed to prevent.
   *
   * So: never regress a channel whose targets this server also mints. Rollback
   * on such a channel is not lost — it is the publisher's to perform, by
   * publishing the version it wants, which is the only actor that could know.
   *
   * THE PREDICATE ASKS ABOUT THE CANDIDATE, NOT ABOUT THE STANDING TARGET, and
   * that direction is the whole fail-closed posture. `isProvablyNewer` answers
   * false for two different situations — behind, and UNORDERABLE — so asking
   * "is the standing one newer?" and inverting would ACCEPT an unorderable
   * answer, which is a feed that has been hand-edited or corrupted saying
   * something this server cannot reason about. Asking "is the candidate
   * provably newer?" holds in both cases, which is the conservative reading of
   * not knowing. (Written the other way round first; the unorderable arm below
   * is what caught it.)
   */
  private resolvedMayReplace(channel: UpdateChannel, resolved: UpdateTarget): boolean {
    if (this.deps.locallyPublished?.(channel) !== true) return true
    const standing = this.target(channel)
    if (!standing || standing.version === resolved.version) return true
    return isProvablyNewer(resolved.version, standing.version)
  }

  /** True only when this attempt resolved a complete, current target. */
  private async resolveIntoTarget(channel: UpdateChannel): Promise<boolean> {
    // NO SPECIAL CASE FOR `dev` ANY MORE (spec §1). It used to branch here and
    // merely REPORT on whatever the publisher had pushed, because there was no
    // dev feed to ask. There is one now, so every channel takes the same three
    // lines below — which is the point of the convergence: the resolve path
    // production uses is exercised many times a day rather than at release.
    if (!this.deps.resolveTarget) {
      const reason = `${channel} target resolver is not configured.`
      this.unavailableReasons.set(channel, reason)
      this.recordCheck(channel, { status: 'unavailable', reason })
      return false
    }
    try {
      const resolved = await this.deps.resolveTarget(channel)
      // setTarget clears any recorded unavailable reason, which is what stops a
      // failed boot-time resolve from being pinned as the eternal truth for the
      // life of the process.
      if (this.resolvedMayReplace(channel, resolved)) this.setTarget(channel, resolved)
      this.recordCheck(channel, { status: 'ok' })
      return true
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // The reason shown to clients describes the ABSENCE of a target, so a
      // failed lookup that leaves a previously-good target standing must not
      // manufacture one. The CHECK still failed, and says so — those are two
      // different questions and this is where they stopped being one.
      if (!this.target(channel)) this.unavailableReasons.set(channel, reason)
      this.recordCheck(channel, { status: 'unavailable', reason })
      return false
    }
  }

  /**
   * Refresh every channel this instance actually uses, at human request, at most
   * once per channel per {@link FORCED_CHECK_INTERVAL_MS}.
   *
   * Inside the window the recorded outcome comes back unchanged rather than an
   * error or a silent no-op: the caller asked "what is the state of things", and
   * a thirty-second-old answer is a true answer to that question.
   */
  async checkNow(): Promise<ChannelCheckRecord[]> {
    const window = this.deps.forcedCheckIntervalMs ?? FORCED_CHECK_INTERVAL_MS
    const results: ChannelCheckRecord[] = []
    for (const channel of this.channelsInUse()) {
      const cached = this.checks.get(channel)
      if (cached && this.deps.now() - cached.checkedAt < window) {
        results.push(cached)
        continue
      }
      // Plain `refreshTarget`: the coalescing is the method's own now, so a forced
      // check shares one resolve with a boot, a tick or a fleet handler — not just
      // with another forced check. The rate window above is untouched and remains
      // the user-facing semantic: inside it, the recorded outcome comes straight back.
      await this.refreshTarget(channel)
      const record = this.checks.get(channel)
      if (record) results.push(record)
    }
    return results
  }

  /**
   * The channels this instance is answerable for: the fleet default, plus every
   * channel some machine is actually pinned to. Refreshing anything else would
   * be work nobody asked for, and omitting a pinned channel would leave the one
   * machine that cares about it on a boot-time target.
   */
  channelsInUse(): UpdateChannel[] {
    const inUse = new Set<UpdateChannel>([this.fleetDefaultChannel()])
    for (const machine of this.deps.machines()) inUse.add(this.channelOf(machine))
    return CHANNEL_ORDER.filter((channel) => inUse.has(channel))
  }

  /** Per-channel refresh bookkeeping, for the fleet read model. */
  channelChecks(): ChannelCheckRecord[] {
    return CHANNEL_ORDER.map((channel) => this.checks.get(channel)).filter(
      (record): record is ChannelCheckRecord => record !== undefined,
    )
  }

  /**
   * Is a convergence wave in flight on this channel?
   *
   * The scheduled refresh asks before it re-resolves: replacing a target under a
   * machine that is mid-download would strand its grant against a descriptor the
   * coordinator no longer publishes (`setTarget` clears the pending records for
   * the channel on a version change). A skipped tick costs at most one day of
   * staleness; a yanked target costs the update.
   */
  operationActive(channel: UpdateChannel): boolean {
    for (const pending of this.pendingGrants.values()) {
      if (pending.channel === channel) return true
    }
    for (const state of this.machineStates.values()) {
      if (state.channel === channel && IN_FLIGHT_STATES.has(state.state)) return true
    }
    return false
  }

  private recordCheck(channel: UpdateChannel, outcome: ChannelCheckOutcome): void {
    this.checks.set(channel, { channel, checkedAt: this.deps.now(), outcome })
  }

  onStatus(machineId: MachineId, message: UpdateStatusMessage): void {
    /** What the machine said, for every line below that has to quote it. */
    const reported = {
      state: message.state,
      version: message.version,
      ...(message.grantId ? { grantId: message.grantId } : {}),
      ...(message.targetVersion ? { targetVersion: message.targetVersion } : {}),
      ...(message.phaseDetail ? { phaseDetail: message.phaseDetail } : {}),
      ...(message.percent !== undefined ? { percent: message.percent } : {}),
      ...(message.detail ? { detail: message.detail } : {}),
    }
    const machine = this.deps.machines().find((candidate) => candidate.id === machineId)
    if (!machine) {
      if (
        (message.state === 'rejected' || message.state === 'stuck') &&
        message.targetVersion !== undefined
      ) {
        this.terminalStatusesBeforeMachine.set(machineId, message)
        return
      }
      log.warn('update status dropped', { machineId, because: 'unknown-machine', ...reported })
      return
    }
    const channel = this.channelOf(machine)
    const target = this.target(channel)
    if (!target) {
      if (
        (message.state === 'rejected' || message.state === 'stuck') &&
        message.targetVersion !== undefined
      ) {
        let deferred = this.terminalStatusesBeforeTarget.get(channel)
        if (!deferred) {
          deferred = new Map()
          this.terminalStatusesBeforeTarget.set(channel, deferred)
        }
        deferred.set(machineId, message)
        return
      }
      log.warn('update status dropped', {
        machineId,
        machine: machine.name,
        because: 'no-target',
        channel,
        ...reported,
      })
      return
    }

    const pending = this.pendingGrants.get(machineId)
    const pendingGrant = pending?.channel === channel ? pending : undefined
    // Ordinary progress carrying a grant id must belong to the current grant.
    // A packaged process can, however, be DOWN while the coordinator spends its
    // one retry and replaces that id. Its durable boot report is still the
    // machine's terminal truth for this SAME target, so accept that narrowly;
    // targetVersion prevents an old crash report poisoning a later release.
    const terminal = message.state === 'rejected' || message.state === 'stuck'
    const grantMismatch = message.grantId !== undefined && message.grantId !== pendingGrant?.grantId
    const recoveredTerminal = grantMismatch && terminal && message.targetVersion === target.version
    /**
     * A REPORT THIS SERVER CANNOT PLACE IS THE THING TO SAY OUT LOUD (POD-3170).
     *
     * `pendingGrants` is in-memory, so a coordinator that replaces itself
     * mid-wave comes back with none — and every frame the machines it granted
     * send about that grant lands here as a mismatch and is dropped. That is
     * the silence the flatblock investigation ran into: 6.5 minutes in which
     * the server said nothing whatsoever about a machine its own operation was
     * waiting on. Dropping the frame is still right; doing it without a trace
     * was not.
     */
    if (grantMismatch && !recoveredTerminal) {
      log.warn('update status dropped', {
        machineId,
        machine: machine.name,
        because: 'grant-mismatch',
        channel,
        knownGrantId: pendingGrant?.grantId,
        ...reported,
      })
      return
    }

    const effectiveState =
      message.state === 'current' && pendingGrant !== undefined
        ? message.version === target.version
          ? 'restarting'
          : 'granted'
        : message.state
    /**
     * A HEARTBEAT IS AN ORDINARY REPORT (POD-2101). The same state arriving
     * again with a new `percent` is accepted exactly like a phase change: it
     * replaces this machine's state, and the caller in `relay.ts` turns it into
     * the operation's progress event, which is what stamps `lastProgressAt` and
     * re-arms the step's deadline.
     *
     * REPLACED WHOLE, never merged. A percentage the newest frame did not carry
     * belongs to a phase that has ended, and a stale 62% sitting under
     * `restarting` is worse than no number at all on a contract whose subject is
     * liveness.
     */
    /**
     * THE PHASE TIMELINE, DURABLY, AND ONLY WHERE IT MOVES (POD-3170).
     *
     * A machine's phases were visible only in the live panel, so once an update
     * was over the question "how long did that machine spend downloading?" had
     * no answer anywhere — which is why attributing a seven-minute update meant
     * measuring an artifact route by hand.
     *
     * ON THE TRANSITION, not on the frame: the daemon heartbeats every two
     * seconds whether or not anything moved, and a line per heartbeat per
     * machine would bury the handful of instants that are the timeline. The
     * percentage rides along on the transition it was current for; the panel
     * remains where a live percentage is read.
     *
     * `sinceGrantMs` is the number the investigation actually needed, measured
     * from the instant recorded by `update grant issued` above.
     */
    const previous = this.machineStates.get(machineId)
    if (previous?.state !== effectiveState || previous?.version !== message.version) {
      log.info('update machine phase', {
        machineId,
        machine: machine.name,
        channel,
        ...reported,
        // AFTER the spread: `state` here is what this server RECORDED, which is
        // not always what the machine said — a `current` report against an
        // outstanding grant is read as `restarting`, and the difference between
        // those two readings is the whole of how a wave decides it is finished.
        state: effectiveState,
        reportedState: message.state,
        from: previous?.state,
        targetVersion: target.version,
        ...(pendingGrant
          ? { grantId: pendingGrant.grantId, sinceGrantMs: this.deps.now() - pendingGrant.issuedAt }
          : {}),
      })
    }
    this.machineStates.set(machineId, {
      channel,
      state: effectiveState,
      version: message.version,
      ...(pendingGrant && recoveredTerminal
        ? { grantId: pendingGrant.grantId }
        : message.grantId
          ? { grantId: message.grantId }
          : {}),
      ...(message.detail ? { detail: message.detail } : {}),
      ...(message.percent !== undefined ? { percent: message.percent } : {}),
      ...(message.phaseDetail ? { phaseDetail: message.phaseDetail } : {}),
    })

    const rollout = this.rollout(channel)
    if (pendingGrant !== undefined && (message.state === 'rejected' || message.state === 'stuck')) {
      this.pendingGrants.delete(machineId)
      if (!rollout.canaryHealthy) rollout.halted = true
    }
  }

  /**
   * Record the operator decision without issuing grants.
   *
   * Used when the development target is still an identity (no tarball). The
   * click is remembered so a later same-version setTarget that gains a
   * headless artifact can tick.
   */
  markAuthorized(channel: UpdateChannel = 'dev'): void {
    this.rollout(channel).authorized = true
    // A deliberate Apply/Try again is new authority. Terminal states are
    // intentionally sticky during automatic planning, but keeping them here
    // made the global retry a no-op after a failed canary.
    this.clearMachineVerdicts(channel)
  }

  /**
   * FORGET WHAT A MACHINE SAID TO SOMEBODY ELSE'S DECISION (POD-2201).
   *
   * `rejected` and `stuck` are deliberately sticky: they are the machine's own
   * word, and everything that plans automatically — the wave planner, the
   * standing reconciliation — is required to leave them standing, or a refusal
   * becomes a grant re-issued on every reconnect forever.
   *
   * What clears them is a HUMAN deciding to try again, and there are two routes
   * to that decision: {@link authorizeMachine} for one row, and an operation's
   * `machines` step for the fleet. Both now clear through here, so the two agree
   * about what a retry means rather than one route inheriting a verdict the
   * other would have cleared.
   *
   * `machineIds` scopes it to the machines the decision was actually about; with
   * no list, every terminal machine on the channel. The rollout is un-halted,
   * because forgetting a verdict re-opens the wave that verdict stopped.
   *
   * WHETHER IT ALSO UN-PROVES THE CANARY IS THE CALLER'S TO SAY (POD-2220), and
   * the two routes answer differently on purpose. A wave that RE-OPENS starts by
   * proving a canary again — §6.2's soak is what makes an automatic fleet-wide
   * update safe, so a fleet-wide retry re-earns it rather than inheriting it.
   * But the proof is about the BUNDLE, not about the machine that carried it: a
   * human applying ONE row has decided about one row and has un-proved nothing,
   * and clearing the flag there charges every other machine on the channel a
   * soak it has already paid — the wave collapses to one machine at a time, and
   * grants nobody anything while that one row is in flight. So the single-row
   * route passes {@link keepCanaryProof}. It is never a way to SET the flag,
   * only to leave a proof that already stands where it is.
   *
   * Returns whose verdict was forgotten — a caller that changes nothing should
   * be able to see that it changed nothing.
   */
  clearMachineVerdicts(
    channel: UpdateChannel,
    machineIds?: readonly string[],
    options: { keepCanaryProof?: boolean } = {},
  ): string[] {
    const cleared = [...this.machineStates.entries()]
      .filter(
        ([machineId, state]) =>
          state.channel === channel &&
          TERMINAL_STATES.has(state.state) &&
          (machineIds === undefined || machineIds.includes(machineId)),
      )
      .map(([machineId]) => machineId)
    if (cleared.length === 0) return []
    const rollout = this.rollout(channel)
    rollout.halted = false
    if (!options.keepCanaryProof) rollout.canaryHealthy = false
    for (const machineId of cleared) {
      this.machineStates.delete(machineId)
      this.pendingGrants.delete(machineId)
    }
    return cleared
  }

  /** Record the operator decision for one authority and start its controlled wave. */
  authorize(channel: UpdateChannel = 'dev'): string[] {
    this.markAuthorized(channel)
    return this.tick(channel)
  }

  /**
   * TAKE THE AUTHORITY BACK, because the operation that held it has finished
   * (POD-2169, spec §3.2).
   *
   * `markAuthorized` is the operator's consent, and {@link fleet} acts on it
   * WITHOUT being asked to: a machine whose directory version proves the target
   * makes the canary healthy and continues the wave, from inside a read. That is
   * what stops the panel reaching "1 of N" and waiting for a second Apply while
   * an update is running — and it is exactly wrong once the operation is over.
   *
   * The failure it produces is not theoretical. A cancel marks the in-flight
   * machines `stuck`, but a grant already sent is never recalled and the daemon's
   * swap is crash-safe, so the machine finishes anyway and reconnects at the
   * target. The next read of `fleet()` — the Settings page, the panel's idle
   * poll, anything — then sees that proof, finds the consent still standing, and
   * GRANTS THE NEXT MACHINE: an update the user cancelled, continuing with no
   * operation, no deadline and no panel watching it.
   *
   * Withdrawn on every terminal outcome, `done` included. After a finished
   * operation the machines still behind belong to the standing reconciliation
   * (§3.6), which converges them one at a time and refuses anyone who said no —
   * a wave continued from a stale flag can do neither.
   *
   * With no channel, every channel: the caller is the operation ending, and an
   * operation is not the reason any channel's consent should outlive it.
   */
  withdrawAuthorization(channel?: UpdateChannel): void {
    const channels = channel ? [channel] : [...this.rollouts.keys()]
    for (const each of channels) {
      const rollout = this.rollouts.get(each)
      if (rollout) rollout.authorized = false
    }
  }

  /**
   * Authorize only the selected machine; changing one row never widens another
   * row's wave.
   *
   * The outcome is explicit rather than inferred from an empty grant list. An
   * empty list conflated already-current, offline, no-target, in-flight and
   * terminally-failed, which is why a retry after a failure reported an
   * internal coordinator message and could never issue anything: a `rejected`
   * or `stuck` machine stays excluded by the planner until a NEW target resets
   * it. A deliberate human Apply is exactly that reset, so it clears this
   * machine's terminal state before planning.
   */
  /**
   * Would these bytes be a bricked daemon rather than an update (POD-2783)?
   *
   * Asked on BOTH human paths, because the wave's own answer covers neither: a
   * per-row Apply plans a fleet of one and a Repair plans no wave at all, so a
   * gate that lived only in `decideWave` would leave the two buttons a human
   * actually presses granting a package for another architecture.
   */
  private platformRefusal(
    machine: WaveMachine,
    target: UpdateTarget,
  ): MachineApplyOutcome | undefined {
    const platform = machine.platform
    if (platform === undefined) return undefined
    if (machineCanTakeTargetPlatform(machine, targetPlatforms(target))) return undefined
    return isHeadlessPlatform(platform)
      ? { result: 'platform-not-in-release', platform }
      : { result: 'platform-not-published', platform }
  }

  /** A permanent verifier mismatch, distinct from whether bytes are deliverable. */
  private trustRefusal(
    machine: WaveMachine,
    target: UpdateTarget,
  ): MachineApplyOutcome | undefined {
    return machineCanUseTargetTrust(machine, target.trust)
      ? undefined
      : { result: 'legacy-instance-trust', version: target.version }
  }

  authorizeMachine(machineId: MachineId): MachineApplyOutcome {
    // `project()`, because this issues a grant (POD-2180): a wave continued from
    // inside the lookup would move machines this row is not about, and then this
    // method would plan against the fleet as it was before that happened.
    const machine = this.project().machines.find((candidate) => candidate.id === machineId)
    if (!machine) return { result: 'unknown-machine' }
    if (!isPackagedRolloutTarget(machine)) return { result: 'source-checkout' }
    const channel = this.channelOf(machine)
    const target = this.target(channel)
    if (!target) {
      return {
        result: 'no-target',
        reason: this.targetUnavailableReasonFor(machineId) ?? 'No target is available.',
      }
    }
    if (machine.version === target.version) {
      return { result: 'already-current', version: machine.version }
    }
    // Before in-flight and before offline: this one does not clear when the
    // machine settles or reconnects, so answering it first is the difference
    // between "come back later" and the truth.
    const trustRefusal = this.trustRefusal(machine, target)
    if (trustRefusal) return trustRefusal
    const platformRefusal = this.platformRefusal(machine, target)
    if (platformRefusal) return platformRefusal
    if (IN_FLIGHT_STATES.has(machine.state)) {
      return { result: 'in-flight', state: machine.state }
    }
    if (!machine.online) return { result: 'offline' }

    // Retry path: forget the previous verdict for this machine so the planner
    // can consider it again, and un-halt the channel this row belongs to. THIS
    // ROW ONLY — a human applying one machine has decided about one machine,
    // and {@link clearMachineVerdicts} is where the fleet-wide route says the
    // same thing about its own set.
    //
    // `keepCanaryProof`, because one row is the whole decision (POD-2220). A
    // canary some OTHER machine proved for this target is still proved after
    // this click; un-proving it here would drop a running wave back to serial
    // and stall it outright until this machine answers.
    this.clearMachineVerdicts(channel, [machineId], { keepCanaryProof: true })

    const planned: WaveMachine = { ...machine, state: 'current' }
    const selected = planWave({
      machines: [planned],
      targetVersion: target.version,
      concurrency: 1,
      canaryHealthy: true,
    })
    const issued = this.issueGrants(channel, target, [planned], selected)
    return issued.includes(machineId)
      ? { result: 'granted', version: target.version }
      : { result: 'offline' }
  }

  /**
   * Re-deliver the selected machine's CURRENT target through the ordinary grant
   * protocol. Unlike Apply, equality is not success: replacing equal-version bytes
   * is the purpose of repair. Every schema, signature, progress, restart and rollback
   * guard below the grant remains unchanged.
   */
  repairMachine(machineId: MachineId): MachineApplyOutcome {
    const machine = this.project().machines.find((candidate) => candidate.id === machineId)
    if (!machine) return { result: 'unknown-machine' }
    if (!isPackagedRolloutTarget(machine)) return { result: 'source-checkout' }
    const channel = this.channelOf(machine)
    const target = this.target(channel)
    if (!target) {
      return {
        result: 'no-target',
        reason: this.targetUnavailableReasonFor(machineId) ?? 'No target is available.',
      }
    }
    const trustRefusal = this.trustRefusal(machine, target)
    if (trustRefusal) return trustRefusal
    const repairRefusal = this.platformRefusal(machine, target)
    if (repairRefusal) return repairRefusal
    if (IN_FLIGHT_STATES.has(machine.state)) {
      return { result: 'in-flight', state: machine.state }
    }
    if (!machine.online) return { result: 'offline' }
    this.clearMachineVerdicts(channel, [machineId], { keepCanaryProof: true })
    const issued = this.issueGrants(channel, target, [machine], [machine.id], true)
    return issued.includes(machineId)
      ? { result: 'granted', version: target.version }
      : { result: 'offline' }
  }

  tick(channel: UpdateChannel = 'dev'): string[] {
    const target = this.target(channel)
    const rollout = this.rollout(channel)
    if (!target || rollout.halted) return []

    // THE PROJECTION, NOT THE READ MODEL (POD-2180). `fleet()` continues an
    // authorized wave from inside itself, so planning against what it returned
    // meant planning against a snapshot taken BEFORE the grants that read had
    // just issued — every widened machine selected, and granted, twice.
    // {@link project} is the same computation with that continuation removed,
    // which is what makes this method the only thing granting on this path.
    const { machines } = this.project()
    const channelMachines = machines.filter((machine) => this.channelOf(machine) === channel)
    const decision = decideWave({
      machines: channelMachines,
      targetVersion: target.version,
      concurrency: this.deps.concurrency,
      canaryHealthy: rollout.canaryHealthy,
      deliveries: offeredDeliveries(target),
      trust: target.trust,
      // …and never a machine this release contains no bytes for (POD-2783).
      platforms: targetPlatforms(target),
    })
    const selected = decision.selected
    /**
     * WHY THIS TICK GRANTED WHAT IT GRANTED — INCLUDING NOTHING (POD-2741).
     *
     * A tick that selects nobody is indistinguishable from a tick that never
     * ran, and both look exactly like a wave that has stopped. The gate has
     * twice recorded a rollout sitting at `[source:current, fleet-a:pending,
     * fleet-b:pending]` with no way to tell which of the two happened, because
     * every input this decision turns on — whether the canary is proved, what
     * each machine's convergence state is, whether it is online at this instant
     * — lives only in memory and is gone by the time anybody reads a log.
     */
    log.info('update wave tick', {
      channel,
      targetVersion: target.version,
      gate: decision.gate,
      canaryHealthy: rollout.canaryHealthy,
      concurrency: this.deps.concurrency,
      selected,
      held: decision.held,
      considered: channelMachines.map((machine) => ({
        machine: machine.name ?? machine.id,
        version: machine.version,
        state: machine.state,
        online: machine.online,
      })),
    })
    const issued = this.issueGrants(channel, target, channelMachines, selected)
    /**
     * …AND THE SAME ANSWER SOMEWHERE A CHECK CAN READ IT (POD-2754).
     *
     * The log line above says all of this and says it to a human. The rollout
     * gate is not a human: it had to watch for the canary window instead, and
     * on a fast update that window is gone before the first sample. So a round
     * that actually granted something is written down too.
     *
     * ONLY WHEN GRANTS WENT OUT. A tick that selected nobody is answered by the
     * log line, and recording every one of them would bury the handful of rounds
     * that constitute the wave under hundreds that changed nothing.
     */
    if (issued.length > 0) {
      const granted = issued.map((machineId) => {
        const machine = channelMachines.find((candidate) => candidate.id === machineId)
        return { id: machineId, ...(machine?.name ? { name: machine.name } : {}) }
      })
      this.recordWaveRound(channel, {
        at: this.deps.now(),
        gate: decision.gate,
        targetVersion: target.version,
        granted,
        held: decision.held,
      })
    }
    return issued
  }

  /**
   * Append one round, keeping the buffer bounded.
   *
   * A wave is a handful of rounds; a coordinator that has been up for weeks has
   * served many waves. The cap is generous enough that no single wave can reach
   * it and small enough that the buffer cannot grow without limit — and dropping
   * the OLDEST is safe precisely because every consumer scopes to rounds newer
   * than its own start.
   */
  private recordWaveRound(channel: UpdateChannel, round: WaveRound): void {
    const rounds = this.waveHistory.get(channel) ?? []
    rounds.push(round)
    if (rounds.length > 200) rounds.splice(0, rounds.length - 200)
    this.waveHistory.set(channel, rounds)
  }

  /**
   * The fleet read model: the projection, plus the one wave continuation a read
   * is allowed to perform.
   *
   * WHY A READ GRANTS AT ALL. An installed daemon normally proves its new build
   * by reconnecting, which refreshes the machine directory before an
   * `updateStatus` message is guaranteed to arrive. Nothing else is watching for
   * that edge, so without this the panel reaches "1 of N" and waits for a second
   * Apply that should never be necessary.
   *
   * WHY IT IS TWO PROJECTIONS AND NOT ONE (POD-2180). The continuation issues
   * grants, and the snapshot taken before it is a description of the fleet that
   * stopped being true halfway through this method. Returning it told every
   * caller that the machines this call had just handed an update to were idle —
   * and `tick()`, one such caller, believed it and granted them again. The
   * second projection is the honest answer to "what is the fleet now", and the
   * work is one pass over the machine directory.
   */
  fleet(): WaveMachine[] {
    this.replayTerminalStatusesForKnownMachines()
    const { machines, continuing } = this.project()
    if (continuing.size === 0) return machines
    for (const channel of continuing) this.tick(channel)
    // The re-read cannot continue anything further: a machine is only ever
    // `continuing` because its directory version proved the target while a
    // convergence record still stood, and the projection above deleted that
    // record. So this is a projection, not a second round of the same question.
    return this.project().machines
  }

  /**
   * The projection ALONE — every fact the read model reports, and not one grant
   * (POD-2180).
   *
   * `continuing` names the channels whose canary has just been proved by the
   * machine directory while an operator authorization still stands; acting on
   * that is {@link fleet}'s job, and deliberately not this method's. Everything
   * that plans a wave reads through here instead, so no caller can be handed a
   * snapshot that something granted against behind its back.
   *
   * The state it does write is reconciliation, not rollout: the directory proof
   * makes the canary healthy and forgets the convergence record it supersedes.
   * Both are idempotent, both are true the moment the handshake landed, and
   * neither sends anything to a machine.
   */
  private project(): {
    machines: WaveMachine[]
    continuing: Set<UpdateChannel>
  } {
    const channelsReadyToContinue = new Set<UpdateChannel>()
    const fleet: WaveMachine[] = this.deps.machines().map((machine) => {
      const channel = this.channelOf(machine)
      const targetVersion = this.target(channel)?.version
      const state = this.machineStates.get(machine.id)
      const currentState = state?.channel === channel ? state : undefined
      // The machine directory is refreshed from the daemon handshake. Once it
      // reports the selected authority's target, that durable fact wins over a
      // stale in-memory grant from before a restart or channel switch.
      if (targetVersion !== undefined && machine.version === targetVersion) {
        if (currentState) {
          const rollout = this.rollout(channel)
          rollout.canaryHealthy = true
          if (rollout.authorized) channelsReadyToContinue.add(channel)
        }
        this.machineStates.delete(machine.id)
        this.pendingGrants.delete(machine.id)
        return { ...machine, state: 'current', version: machine.version }
      }
      if (!currentState) return { ...machine }
      // NO AGEING HERE (POD-2101). Reading the fleet is not the passage of
      // time; the operation's step deadline is what ends a silent grant now.
      return {
        ...machine,
        state: currentState.state,
        version: currentState.version,
        ...(currentState.detail ? { detail: currentState.detail } : {}),
        ...(currentState.percent !== undefined ? { percent: currentState.percent } : {}),
        ...(currentState.phaseDetail ? { phaseDetail: currentState.phaseDetail } : {}),
      }
    })

    return { machines: fleet, continuing: channelsReadyToContinue }
  }

  /**
   * Record that this coordinator gave up waiting for a machine.
   *
   * A wait that merely stops its timer is invisible: the operator sees a row
   * that never finishes and a coordinator that never restarts, with nothing
   * naming either. This writes the failure the fleet read model reports and the
   * dialog turns into retry guidance.
   */
  abandonWait(machineIds: readonly string[], detail: string): string[] {
    // Projected ONCE, outside the loop, and never through the read model: this
    // is cleanup, and a cleanup that continues a wave from inside its own lookup
    // is how the operation that just ended gets to grant one more machine
    // (POD-2180). Abandoning one machine does not change another's projection,
    // so one pass answers for all of them.
    const { machines } = this.project()
    const abandoned: string[] = []
    for (const machineId of machineIds) {
      const machine = machines.find((candidate) => candidate.id === machineId)
      if (!machine || !IN_FLIGHT_STATES.has(machine.state)) continue
      const channel = this.channelOf(machine)
      this.pendingGrants.delete(machineId)
      this.machineStates.set(machineId, {
        channel,
        state: 'stuck',
        version: machine.version,
        detail,
      })
      abandoned.push(machineId)
    }
    return abandoned
  }

  /**
   * RE-ISSUE THE GRANT for machines this coordinator is still waiting on — the
   * operation's ONE automatic retry after a stall (§3.3, POD-2101).
   *
   * It cannot be `tick()`: the wave planner deliberately excludes a machine it
   * believes is mid-grant, so the retry the engine bought would select nobody
   * and change nothing. Forgetting the in-flight record first is what makes the
   * machine selectable again, and re-granting is safe because the daemon's own
   * runner serializes: a repeat of the same grant id is ignored, and a newer one
   * cancels the delivery in flight before taking over.
   *
   * Offline machines are left alone. A grant cannot be delivered to a machine
   * that is not connected, and pretending otherwise would produce a fresh
   * deadline for a message nobody received.
   */
  reissueGrants(channel: UpdateChannel, machineIds?: readonly string[]): string[] {
    // `project()`, for the sharpest form of POD-2180: this selects on IN_FLIGHT
    // and then re-grants what it selects. Reading through `fleet()` would let
    // the read's own wave continuation hand a machine its first grant and this
    // method immediately cancel and re-issue it.
    const candidates = this.project().machines.filter(
      (machine) =>
        this.channelOf(machine) === channel &&
        isPackagedRolloutTarget(machine) &&
        machine.online &&
        IN_FLIGHT_STATES.has(machine.state) &&
        (machineIds === undefined || machineIds.includes(machine.id)),
    )
    const target = this.target(channel)
    if (!target || candidates.length === 0) return []

    const replanned: WaveMachine[] = []
    for (const machine of candidates) {
      if (machine.version === target.version) continue
      this.machineStates.delete(machine.id)
      this.pendingGrants.delete(machine.id)
      replanned.push({ ...machine, state: 'current' })
    }
    if (replanned.length === 0) return []
    return this.issueGrants(
      channel,
      target,
      replanned,
      replanned.map((machine) => machine.id),
    )
  }

  /**
   * Stop believing in every grant still in flight, because the operation that
   * owned them has finished (POD-2101).
   *
   * Without this the deletion of the poll-aged deadline would leave a permanent
   * lie: a daemon that vanished mid-download would stay `downloading` forever,
   * which excludes it from every future wave, keeps {@link operationActive}
   * true, and with it suppresses the scheduled target refresh for its channel.
   * The operation reaching a terminal state is exactly the moment nobody is
   * waiting for those grants any more.
   */
  releaseInFlightGrants(detail: string = GRANT_TIMED_OUT_DETAIL): string[] {
    // Projected, not read (POD-2180). The caller withdraws authorization before
    // reaching here precisely because this used to be able to grant from inside
    // its own lookup; that ordering still stands and is still right, but it is
    // no longer the only thing standing between a cancel and one more machine
    // being handed the update it cancelled.
    const inFlight = this.project()
      .machines.filter((machine) => IN_FLIGHT_STATES.has(machine.state))
      .map((machine) => machine.id)
    return this.abandonWait(inFlight, detail)
  }

  /** Raw handshake proof, deliberately bypassing optimistic convergence state. */
  machineBootedAtTarget(machineId: MachineId, targetVersion: string): boolean {
    const machine = this.deps.machines().find((candidate) => candidate.id === machineId)
    return machine?.online === true && machine.version === targetVersion
  }

  /**
   * Proof that the old daemon completed its side of the restart handoff.
   *
   * The normal proof is a target-version handshake. Across a wire boundary the
   * new daemon cannot make that handshake until the coordinator also restarts,
   * so waiting exclusively for it deadlocks both processes. A correlated
   * `restarting` report is emitted only after the artifact swap and pending
   * marker write; observing that same daemon disconnect then proves the old
   * process crossed the restart boundary without trusting an optimistic status
   * report as proof that the new process booted successfully.
   */
  machineCrossedRestartBoundary(machineId: MachineId, targetVersion: string): boolean {
    const machine = this.deps.machines().find((candidate) => candidate.id === machineId)
    const state = this.machineStates.get(machineId)
    const pending = this.pendingGrants.get(machineId)
    return (
      machine?.online === false &&
      state?.state === 'restarting' &&
      pending !== undefined &&
      state.channel === pending.channel &&
      state.grantId === pending.grantId &&
      this.target(state.channel)?.version === targetVersion
    )
  }

  private issueGrants(
    channel: UpdateChannel,
    target: UpdateTarget,
    machines: readonly WaveMachine[],
    selected: readonly string[],
    repair = false,
  ): string[] {
    const issued: string[] = []
    for (const machineId of selected) {
      const grant: UpdateGrantMessage = {
        type: 'updateGrant',
        grantId: this.deps.nextGrantId(),
        ...(repair ? { repair: true } : {}),
        target,
        ...(this.deps.updatePubkey ? { updatePubkey: this.deps.updatePubkey() } : {}),
      }
      const machine = machines.find((candidate) => candidate.id === machineId)
      this.deps.send(asMachineId(machineId), grant)
      /**
       * THE MOMENT A GRANT LEFT THIS PROCESS (POD-3170).
       *
       * The only grant anything logged was the coordinator's own, because
       * `local-participant.ts` logs on RECEIPT and a remote machine has no
       * equivalent. So the one fact needed to attribute a slow update — when
       * this machine was told to update, and under which grant id — existed
       * nowhere. Reconstructing it afterwards took the wave-round records, and
       * those are written AFTER the whole round, which is a different instant
       * from the one a download is measured against.
       *
       * `coordinator` is on the line because granting it is the event that ends
       * this server: every line after it belongs to a different process.
       */
      log.info('update grant issued', {
        machineId,
        ...(machine?.name ? { machine: machine.name } : {}),
        grantId: grant.grantId,
        channel,
        targetVersion: target.version,
        fromVersion: machine?.version,
        ...(machine?.coordinator ? { coordinator: true } : {}),
        ...(repair ? { repair: true } : {}),
      })
      this.pendingGrants.set(machineId, {
        channel,
        grantId: grant.grantId,
        issuedAt: this.deps.now(),
      })
      this.machineStates.set(machineId, {
        channel,
        state: 'granted',
        version: machine?.version ?? '',
      })
      issued.push(machineId)
    }
    return issued
  }

  /**
   * Undefined means NOT REGISTERED — never "registered but unpinned" (POD-2100).
   *
   * Reading the projection's `channel` field raw conflated the two, so a real
   * machine with no pin was reported to its own operator as "no longer
   * registered". A registered machine always has a channel; that is what the
   * fleet default IS.
   */
  private channelForMachine(machineId: MachineId): UpdateChannel | undefined {
    const selected = this.deps.channelFor?.(machineId)
    if (selected) return selected
    const machine = this.deps.machines().find((candidate) => candidate.id === machineId)
    return machine ? this.channelOf(machine) : undefined
  }

  /**
   * PUBLIC because it must be the only answer (POD-2100). The fleet read model
   * used to decide "is this a development machine?" with its own `?? 'dev'`, so
   * a machine with no pin could be counted into the dev wave here and resolved
   * to `stable` by the handler that grants it.
   */
  channelOf(machine: WaveMachine): UpdateChannel {
    return resolveMachineChannel(machine.channel, this.deps.fleetChannel?.())
  }

  /** The channel an unpinned machine follows. */
  fleetDefaultChannel(): UpdateChannel {
    return resolveMachineChannel(undefined, this.deps.fleetChannel?.())
  }

  /**
   * WHICH CHANNEL THE GLOBAL PANEL'S UPDATE IS ABOUT (POD-2189).
   *
   * Both composition roots used to write `channel: 'dev'` as a literal, with a
   * comment calling it inherited behaviour — "the dev authority is what the
   * global panel has always converged". That was true of a development
   * coordinator and false of every shipped one: `DEFAULT_FLEET_UPDATE_CHANNEL`
   * is `stable`, so on a real installation `planInputFrom` resolved no target
   * and threw *no dev update target is published*. A stable-pinned fleet got no
   * operation at all — no panel, no history, no progress — and converged only
   * through the standing reconciler, silently. That was the shipping
   * configuration, not scaffolding for one.
   *
   * The answer is the HOST's own channel, because the global panel updates THIS
   * installation and the coordinator is the installation. It reuses
   * {@link UpdatesService.channelOf}, which POD-2100 made the single answer to
   * "which channel is this machine on", so this cannot disagree with the
   * authority that will actually grant. A host that is not in the directory yet
   * — first boot, before its own handshake — falls back to the fleet default,
   * which is the same question asked of a machine with no pin.
   *
   * STILL ONE CHANNEL PER OPERATION, which is what §8's mixed-channel row asks
   * for ("the plan is computed per channel authority"): machines pinned
   * elsewhere are scoped out at plan time and keep their own per-row action and
   * the standing reconciliation. What is fixed here is only *which* authority.
   */
  operationChannel(hostMachineId?: string): UpdateChannel {
    const host = hostMachineId
      ? this.deps.machines().find((candidate) => candidate.id === hostMachineId)
      : undefined
    return host ? this.channelOf(host) : this.fleetDefaultChannel()
  }

  /**
   * WHAT `/version` ADVERTISES — THE OFFER'S ONLY INPUT (POD-2212/POD-2222).
   *
   * The panel derives its whole offer from `server.target`: no target, no
   * offer, no button. That target used to be assembled at the composition root
   * as `devPublisher.publishTarget() ?? updates.target()` — and `target()`
   * defaults to `dev`, so BOTH halves asked the development authority. On an
   * installed host the publisher is disabled and the dev authority has nothing
   * to say, so `/version` carried no target and a stable installation looked
   * permanently up to date while a published release sat one fetch away.
   *
   * The live drive measured the disagreement inside one second: the operation
   * resolved stable `0.1.3` while `/version` advertised `dev+03a2892`. This is
   * that fix and only that fix — the READ asks {@link operationChannel}, the
   * same question the ACTION already asks, so the offer and the update it
   * starts can no longer name different versions.
   *
   * A source checkout's HEAD does not participate here: it is a pre-release
   * proposal until an admin builds and publishes it. Only the standing target
   * pulled from that channel's feed can become an offer.
   */
  advertisedTarget(hostMachineId?: string): UpdateTarget | undefined {
    const channel = this.operationChannel(hostMachineId)
    const raw = this.target(channel)
    return raw ? withoutArtifactCredentials(raw) : undefined
  }

  private rollout(channel: UpdateChannel): ChannelRolloutState {
    const current = this.rollouts.get(channel)
    if (current) return current
    const created = freshRollout()
    this.rollouts.set(channel, created)
    return created
  }
}
