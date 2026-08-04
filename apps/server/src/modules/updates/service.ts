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
}

interface MachineConvergenceState {
  state: ConvergenceState
  version: string
}

/**
 * Server-owned convergence orchestration. A target is inert until setTarget is
 * called, and every grant comes from planWave. Daemon status is attributed by the
 * authenticated gateway before it reaches onStatus.
 */
export class UpdatesService {
  private targetValue: UpdateTarget | undefined
  private canaryHealthy = false
  private halted = false
  private readonly machineStates = new Map<string, MachineConvergenceState>()
  private readonly pendingGrants = new Map<string, string>()
  private readonly transitionAt = new Map<string, number>()

  constructor(private readonly deps: UpdatesDeps) {}

  targetVersion(): string | undefined {
    return this.targetValue?.version
  }

  setTarget(target: UpdateTarget): void {
    // Re-publishing the same label can replace its artifact descriptor without
    // invalidating the proof already made for that target.
    if (this.targetValue?.version === target.version) {
      this.targetValue = target
      return
    }
    this.targetValue = target
    this.canaryHealthy = false
    this.halted = false
    this.machineStates.clear()
    this.pendingGrants.clear()
    this.transitionAt.clear()
  }

  onStatus(machineId: string, message: UpdateStatusMessage): void {
    const target = this.targetValue
    if (!target) return

    const pendingGrant = this.pendingGrants.get(machineId)
    // A status carrying a grant id must belong to the grant currently issued for
    // this target. This prevents a late report from a prior target resetting the
    // canary gate after a target change.
    if (message.grantId && message.grantId !== pendingGrant) return

    const effectiveState =
      message.state === 'current' &&
      message.version !== target.version &&
      pendingGrant !== undefined
        ? 'granted'
        : message.state
    this.machineStates.set(machineId, {
      state: effectiveState,
      version: message.version,
    })
    this.transitionAt.set(machineId, this.deps.now())

    if (message.state === 'current' && message.version === target.version) {
      if (pendingGrant !== undefined) {
        this.canaryHealthy = true
        this.pendingGrants.delete(machineId)
      }
      return
    }

    if (pendingGrant !== undefined && (message.state === 'rejected' || message.state === 'stuck')) {
      this.pendingGrants.delete(machineId)
      if (!this.canaryHealthy) this.halted = true
    }
  }

  tick(): string[] {
    const target = this.targetValue
    if (!target || this.halted) return []

    const machines = this.fleet()
    const selected = planWave({
      machines,
      targetVersion: target.version,
      concurrency: this.deps.concurrency,
      canaryHealthy: this.canaryHealthy,
    })
    const issued: string[] = []
    for (const machineId of selected) {
      const grant: UpdateGrantMessage = {
        type: 'updateGrant',
        grantId: this.deps.nextGrantId(),
        target,
      }
      this.deps.send(machineId, grant)
      const machine = machines.find((candidate) => candidate.id === machineId)
      this.pendingGrants.set(machineId, grant.grantId)
      this.machineStates.set(machineId, {
        state: 'granted',
        version: machine?.version ?? '',
      })
      this.transitionAt.set(machineId, this.deps.now())
      issued.push(machineId)
    }
    return issued
  }

  /** Wave-machine projection used by the fleet read model and the planner. */
  fleet(): WaveMachine[] {
    return this.deps.machines().map((machine) => {
      const state = this.machineStates.get(machine.id)
      return state ? { ...machine, state: state.state, version: state.version } : { ...machine }
    })
  }
}
      this.deps.send(machineId, grant)
