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
  detail?: string
}

/**
 * Server-owned convergence orchestration. A target is inert until setTarget is
 * called, and every grant comes from planWave. Daemon status is attributed by
 * the authenticated gateway before it reaches onStatus.
 */
export class UpdatesService {
  private targetValue: UpdateTarget | undefined
  private authorized = false
  private canaryHealthy = false
  private halted = false
  private readonly machineStates = new Map<string, MachineConvergenceState>()
  private readonly pendingGrants = new Map<string, string>()

  constructor(private readonly deps: UpdatesDeps) {}

  targetVersion(): string | undefined {
    return this.targetValue?.version
  }

  /** The immutable target descriptor currently published by the server. */
  target(): UpdateTarget | undefined {
    return this.targetValue
  }

  setTarget(target: UpdateTarget): void {
    // Re-publishing the same label can replace its artifact descriptor without
    // invalidating the proof already made for that target.
    if (this.targetValue?.version === target.version) {
      this.targetValue = target
      return
    }
    this.targetValue = target
    this.authorized = false
    this.canaryHealthy = false
    this.halted = false
    this.machineStates.clear()
    this.pendingGrants.clear()
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
      ...(message.detail ? { detail: message.detail } : {}),
    })

    if (message.state === 'current' && message.version === target.version) {
      if (pendingGrant !== undefined) {
        this.canaryHealthy = true
        this.pendingGrants.delete(machineId)
      }
      if (this.authorized) this.tick()
      return
    }

    if (pendingGrant !== undefined && (message.state === 'rejected' || message.state === 'stuck')) {
      this.pendingGrants.delete(machineId)
      if (!this.canaryHealthy) this.halted = true
    }
  }

  /** Record the operator's one decision and start the planner-controlled wave. */
  authorize(): string[] {
    this.authorized = true
    return this.tick()
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
      issued.push(machineId)
    }
    return issued
  }

  /** Wave-machine projection used by the fleet read model and the planner. */
  fleet(): WaveMachine[] {
    const targetVersion = this.targetValue?.version
    return this.deps.machines().map((machine) => {
      const state = this.machineStates.get(machine.id)
      // The machine directory is refreshed from the daemon handshake. Once it
      // reports the target version, that durable fact wins over the old in-memory
      // grant state left behind by the restart.
      if (targetVersion !== undefined && machine.version === targetVersion) {
        if (state) this.canaryHealthy = true
        this.machineStates.delete(machine.id)
        this.pendingGrants.delete(machine.id)
        return { ...machine, state: 'current', version: machine.version }
      }
      return state
        ? {
            ...machine,
            state: state.state,
            version: state.version,
            ...(state.detail ? { detail: state.detail } : {}),
          }
        : { ...machine }
    })
  }
}
