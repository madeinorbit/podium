import type { UpdateChannel } from '@podium/model'
import type {
  ConvergenceState,
  UpdateGrantMessage,
  UpdateStatusMessage,
  UpdateTarget,
} from '@podium/protocol'
import { planWave, type WaveMachine } from './wave'

export interface UpdatesDeps {
  machines(): readonly WaveMachine[]
  send(machineId: string, message: UpdateGrantMessage): void
  now(): number
  nextGrantId(): string
  concurrency: number
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
    const machine = this.deps.machines().find((candidate) => candidate.id === machineId)
    return machine ? this.target(this.channelOf(machine)) : undefined
  }

  /** Explain why a machine's selected authority cannot currently advertise a target. */
  targetUnavailableReasonFor(machineId: string): string | undefined {
    const machine = this.deps.machines().find((candidate) => candidate.id === machineId)
    if (!machine) return 'Machine is no longer registered.'
    const channel = this.channelOf(machine)
    if (this.target(channel)) return undefined
    return (
      this.unavailableReasons.get(channel) ??
      `${channel} target has not been resolved by this coordinator.`
    )
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

  /** Authorize only the selected machine; changing one row never widens another row's wave. */
  authorizeMachine(machineId: string): string[] {
    const machine = this.fleet().find((candidate) => candidate.id === machineId)
    if (!machine) return []
    const channel = this.channelOf(machine)
    const target = this.target(channel)
    if (!target) return []
    const selected = planWave({
      machines: [machine],
      targetVersion: target.version,
      concurrency: 1,
      canaryHealthy: true,
    })
    return this.issueGrants(channel, target, [machine], selected)
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
      return currentState
        ? {
            ...machine,
            state: currentState.state,
            version: currentState.version,
            ...(currentState.detail ? { detail: currentState.detail } : {}),
          }
        : { ...machine }
    })
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
      this.pendingGrants.set(machineId, { channel, grantId: grant.grantId })
      this.machineStates.set(machineId, {
        channel,
        state: 'granted',
        version: machine?.version ?? '',
      })
      issued.push(machineId)
    }
    return issued
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
