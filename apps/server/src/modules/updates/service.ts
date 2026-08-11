import type { UpdateChannel } from '@podium/model'
import type {
  ConvergenceState,
  UpdateGrantMessage,
  UpdateStatusMessage,
  UpdateTarget,
} from '@podium/protocol'
import { IN_FLIGHT_STATES, planWave, TERMINAL_STATES, type WaveMachine } from './wave'

export interface UpdatesDeps {
  machines(): readonly WaveMachine[]
  channelFor?(machineId: string): UpdateChannel | undefined
  send(machineId: string, message: UpdateGrantMessage): void
  now(): number
  nextGrantId(): string
  concurrency: number
  /** Overridable only so tests can age a grant without waiting ten minutes. */
  grantDeadlineMs?: number
  resolveTarget?(channel: 'edge' | 'stable'): Promise<UpdateTarget>
}

interface MachineConvergenceState {
  channel: UpdateChannel
  state: ConvergenceState
  version: string
  detail?: string
}

interface PendingGrant {
  channel: UpdateChannel
  grantId: string
  issuedAt: number
  /** Last accepted phase report; the deadline is measured from here. */
  lastProgressAt: number
}

/**
 * How long one issued grant may stay in flight before the coordinator stops
 * believing it. A daemon that goes silent — killed mid-download, rebooted into
 * a build that never reconnects — used to leave the row converging forever and
 * the Apply action permanently excluded by the planner. After this deadline the
 * grant ages into `stuck`, which is a state the operator can see and retry.
 */
const GRANT_DEADLINE_MS = 10 * 60_000

const GRANT_TIMED_OUT_DETAIL = 'The machine stopped reporting progress while updating.'

/** The one decision an explicit per-machine Apply can produce. */
export type MachineApplyOutcome =
  | { result: 'granted'; version: string }
  | { result: 'already-current'; version: string }
  | { result: 'offline' }
  | { result: 'unknown-machine' }
  | { result: 'no-target'; reason: string }
  | { result: 'in-flight'; state: ConvergenceState }

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

  constructor(private readonly deps: UpdatesDeps) {}

  targetVersion(machineId?: string): string | undefined {
    return machineId === undefined
      ? this.target('dev')?.version
      : this.targetFor(machineId)?.version
  }

  /** The immutable descriptor currently published for one authority channel. */
  target(channel: UpdateChannel = 'dev'): UpdateTarget | undefined {
    return this.targets.get(channel)
  }

  /** Resolve a machine through its durable channel choice. */
  targetFor(machineId: string): UpdateTarget | undefined {
    const channel = this.channelForMachine(machineId)
    return channel ? this.target(channel) : undefined
  }

  /** Explain why a machine's selected authority cannot currently advertise a target. */
  targetUnavailableReasonFor(machineId: string): string | undefined {
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
      this.machineStates.set(machineId, { ...state, state: 'stuck', detail: reason })
    }
  }

  setTarget(channel: UpdateChannel, target: UpdateTarget): void
  /** Compatibility form for the existing development publisher. */
  setTarget(target: UpdateTarget): void
  setTarget(channelOrTarget: UpdateChannel | UpdateTarget, maybeTarget?: UpdateTarget): void {
    const channel = typeof channelOrTarget === 'string' ? channelOrTarget : 'dev'
    const target = typeof channelOrTarget === 'string' ? maybeTarget : channelOrTarget
    if (!target) throw new Error(`missing ${channel} update target`)

    this.unavailableReasons.delete(channel)

    // Re-publishing the same label can replace its artifact descriptor without
    // invalidating the proof already made for that target.
    if (this.targets.get(channel)?.version === target.version) {
      this.targets.set(channel, target)
      return
    }

    this.targets.set(channel, target)
    this.rollouts.set(channel, freshRollout())
    for (const [machineId, state] of this.machineStates) {
      if (state.channel === channel) this.machineStates.delete(machineId)
    }
    for (const [machineId, pending] of this.pendingGrants) {
      if (pending.channel === channel) this.pendingGrants.delete(machineId)
    }
  }

  /** Refresh one selected authority without turning a failed lookup into a stale grant. */
  async refreshTarget(channel: UpdateChannel): Promise<void> {
    if (channel === 'dev') {
      if (!this.target('dev')) {
        this.unavailableReasons.set(
          'dev',
          'Development target is not currently published by this source server.',
        )
      }
      return
    }
    if (!this.deps.resolveTarget) {
      this.unavailableReasons.set(channel, `${channel} target resolver is not configured.`)
      return
    }
    try {
      this.setTarget(channel, await this.deps.resolveTarget(channel))
    } catch (error) {
      if (!this.target(channel)) {
        this.unavailableReasons.set(channel, error instanceof Error ? error.message : String(error))
      }
    }
  }

  onStatus(machineId: string, message: UpdateStatusMessage): void {
    const machine = this.deps.machines().find((candidate) => candidate.id === machineId)
    if (!machine) return
    const channel = this.channelOf(machine)
    const target = this.target(channel)
    if (!target) return

    const pending = this.pendingGrants.get(machineId)
    const pendingGrant = pending?.channel === channel ? pending : undefined
    // A status carrying a grant id must belong to the grant currently issued for
    // this channel and target. Late reports from a channel the machine left are inert.
    if (message.grantId && message.grantId !== pendingGrant?.grantId) return

    // The deadline measures SILENCE, not total duration. Every accepted phase
    // report is progress, so it restarts the clock — otherwise a large download
    // on a slow link would be aged out mid-transfer while it was working fine.
    if (pendingGrant !== undefined) pendingGrant.lastProgressAt = this.deps.now()

    const effectiveState =
      message.state === 'current' &&
      message.version !== target.version &&
      pendingGrant !== undefined
        ? 'granted'
        : message.state
    this.machineStates.set(machineId, {
      channel,
      state: effectiveState,
      version: message.version,
      ...(message.detail ? { detail: message.detail } : {}),
    })

    const rollout = this.rollout(channel)
    if (message.state === 'current' && message.version === target.version) {
      if (pendingGrant !== undefined) {
        rollout.canaryHealthy = true
        this.pendingGrants.delete(machineId)
      }
      if (rollout.authorized) this.tick(channel)
      return
    }

    if (pendingGrant !== undefined && (message.state === 'rejected' || message.state === 'stuck')) {
      this.pendingGrants.delete(machineId)
      if (!rollout.canaryHealthy) rollout.halted = true
    }
  }

  /** Record the operator decision for one authority and start its controlled wave. */
  authorize(channel: UpdateChannel = 'dev'): string[] {
    this.rollout(channel).authorized = true
    return this.tick(channel)
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
  authorizeMachine(machineId: string): MachineApplyOutcome {
    const machine = this.fleet().find((candidate) => candidate.id === machineId)
    if (!machine) return { result: 'unknown-machine' }
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
    if (IN_FLIGHT_STATES.has(machine.state)) {
      return { result: 'in-flight', state: machine.state }
    }
    if (!machine.online) return { result: 'offline' }

    // Retry path: forget the previous verdict for this machine so the planner
    // can consider it again, and un-halt the channel this row belongs to.
    if (TERMINAL_STATES.has(machine.state)) {
      this.machineStates.delete(machineId)
      this.pendingGrants.delete(machineId)
      this.rollout(channel).halted = false
    }

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

  tick(channel: UpdateChannel = 'dev'): string[] {
    const target = this.target(channel)
    const rollout = this.rollout(channel)
    if (!target || rollout.halted) return []

    const machines = this.fleet()
    const channelMachines = machines.filter((machine) => this.channelOf(machine) === channel)
    const selected = planWave({
      machines: channelMachines,
      targetVersion: target.version,
      concurrency: this.deps.concurrency,
      canaryHealthy: rollout.canaryHealthy,
    })
    return this.issueGrants(channel, target, channelMachines, selected)
  }

  /** Wave-machine projection used by the fleet read model and the planner. */
  fleet(): WaveMachine[] {
    return this.deps.machines().map((machine) => {
      const channel = this.channelOf(machine)
      const targetVersion = this.target(channel)?.version
      const state = this.machineStates.get(machine.id)
      const currentState = state?.channel === channel ? state : undefined
      // The machine directory is refreshed from the daemon handshake. Once it
      // reports the selected authority's target, that durable fact wins over a
      // stale in-memory grant from before a restart or channel switch.
      if (targetVersion !== undefined && machine.version === targetVersion) {
        if (currentState) this.rollout(channel).canaryHealthy = true
        this.machineStates.delete(machine.id)
        this.pendingGrants.delete(machine.id)
        return { ...machine, state: 'current', version: machine.version }
      }
      if (!currentState) return { ...machine }
      // A silent daemon must not converge forever. Once the grant outlives its
      // deadline the row becomes a failure the operator can see and retry.
      if (IN_FLIGHT_STATES.has(currentState.state) && this.grantExpired(machine.id)) {
        this.pendingGrants.delete(machine.id)
        const timedOut: MachineConvergenceState = {
          channel,
          state: 'stuck',
          version: currentState.version,
          detail: GRANT_TIMED_OUT_DETAIL,
        }
        this.machineStates.set(machine.id, timedOut)
        return { ...machine, state: 'stuck', version: timedOut.version, detail: timedOut.detail }
      }
      return {
        ...machine,
        state: currentState.state,
        version: currentState.version,
        ...(currentState.detail ? { detail: currentState.detail } : {}),
      }
    })
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
    const abandoned: string[] = []
    for (const machineId of machineIds) {
      const machine = this.fleet().find((candidate) => candidate.id === machineId)
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

  /** Raw handshake proof, deliberately bypassing optimistic convergence state. */
  machineBootedAtTarget(machineId: string, targetVersion: string): boolean {
    const machine = this.deps.machines().find((candidate) => candidate.id === machineId)
    return machine?.online === true && machine.version === targetVersion
  }

  private grantExpired(machineId: string): boolean {
    const pending = this.pendingGrants.get(machineId)
    if (!pending) return false
    return (
      this.deps.now() - pending.lastProgressAt >= (this.deps.grantDeadlineMs ?? GRANT_DEADLINE_MS)
    )
  }

  private issueGrants(
    channel: UpdateChannel,
    target: UpdateTarget,
    machines: readonly WaveMachine[],
    selected: readonly string[],
  ): string[] {
    const issued: string[] = []
    for (const machineId of selected) {
      const grant: UpdateGrantMessage = {
        type: 'updateGrant',
        grantId: this.deps.nextGrantId(),
        target,
      }
      this.deps.send(machineId, grant)
      const machine = machines.find((candidate) => candidate.id === machineId)
      const issuedAt = this.deps.now()
      this.pendingGrants.set(machineId, {
        channel,
        grantId: grant.grantId,
        issuedAt,
        lastProgressAt: issuedAt,
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

  private channelForMachine(machineId: string): UpdateChannel | undefined {
    return (
      this.deps.channelFor?.(machineId) ??
      this.deps.machines().find((candidate) => candidate.id === machineId)?.channel
    )
  }

  private channelOf(machine: WaveMachine): UpdateChannel {
    return machine.channel ?? 'dev'
  }

  private rollout(channel: UpdateChannel): ChannelRolloutState {
    const current = this.rollouts.get(channel)
    if (current) return current
    const created = freshRollout()
    this.rollouts.set(channel, created)
    return created
  }
}
