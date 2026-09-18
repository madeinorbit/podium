import { updateFingerprint } from '@podium/runtime/machine-update'
import { createLogger } from '@podium/logger'
import { type UpdateChannel } from '@podium/model'
import { targetPlatforms, type UpdateTarget } from '@podium/protocol'
import { type UpdatesService } from './service'
import {
  IN_FLIGHT_STATES,
  isPackagedRolloutTarget,
  machineCanTakeDelivery,
  machineCanTakeTargetPlatform,
  machineCanUseTargetTrust,
  offeredDeliveries,
  TERMINAL_STATES,
  type WaveMachine,
} from './wave'

const log = createLogger('server:updates')

export type ReconcileRefusal =
  | 'operation-active'
  | 'unknown-machine'
  | 'coordinator'
  | 'no-target'
  | 'not-approved'
  | 'not-packaged-rollout-target'
  | 'at-target'
  | 'offline'
  | 'cannot-take-delivery'
  | 'legacy-instance-trust'
  | 'platform-not-in-release'
  | 'in-flight'
  | 'terminal'
  | 'attempts-exhausted'
  | 'human-operation-required'

export type ReconcileDecision = { converge: false; because: ReconcileRefusal }

export interface ReconcileFacts {
  machine: WaveMachine | undefined
  isCoordinator?: boolean
  target: UpdateTarget | undefined
  approvedTargetVersion?: string
  approvedTarget?: UpdateTarget
  operationActive: boolean
  attempts: number
  maxAttempts?: number
}

export const MAX_RECONCILE_ATTEMPTS = 2

export function decideReconciliation(facts: ReconcileFacts): ReconcileDecision {
  if (facts.operationActive) return { converge: false, because: 'operation-active' }
  const machine = facts.machine
  if (!machine) return { converge: false, because: 'unknown-machine' }
  // SECOND, and above every question about the target: this is a fact about
  // WHICH MACHINE this is, and it holds whatever is published and whatever the
  // row's state happens to be. Asking it after `at-target` would have made the
  // refusal invisible in the ordinary case and present only in the one case
  // that restarts the server.
  if (facts.isCoordinator ?? machine.coordinator === true) {
    return { converge: false, because: 'coordinator' }
  }
  if (!facts.target) return { converge: false, because: 'no-target' }
  if (facts.target.version !== facts.approvedTargetVersion)
    return { converge: false, because: 'not-approved' }
  if (
    facts.approvedTarget &&
    updateFingerprint(facts.target) !== updateFingerprint(facts.approvedTarget)
  )
    return { converge: false, because: 'not-approved' }
  if (!isPackagedRolloutTarget(machine)) {
    return { converge: false, because: 'not-packaged-rollout-target' }
  }
  if (machine.version === facts.target.version) return { converge: false, because: 'at-target' }
  if (!machine.online) return { converge: false, because: 'offline' }
  if (!machineCanTakeDelivery(machine, offeredDeliveries(facts.target))) {
    return { converge: false, because: 'cannot-take-delivery' }
  }
  if (!machineCanUseTargetTrust(machine, facts.target.trust)) {
    return { converge: false, because: 'legacy-instance-trust' }
  }
  if (!machineCanTakeTargetPlatform(machine, targetPlatforms(facts.target))) {
    return { converge: false, because: 'platform-not-in-release' }
  }
  if (IN_FLIGHT_STATES.has(machine.state)) return { converge: false, because: 'in-flight' }
  // THE LOOP GUARD. `authorizeMachine` clears this state as the human retry
  // path; reading it HERE, before calling that, is what keeps the machine's own
  // refusal standing against a process nobody asked.
  if (TERMINAL_STATES.has(machine.state)) return { converge: false, because: 'terminal' }
  if (facts.attempts >= (facts.maxAttempts ?? MAX_RECONCILE_ATTEMPTS)) {
    return { converge: false, because: 'attempts-exhausted' }
  }
  return { converge: false, because: 'human-operation-required' }
}

/** Background observation has no grant authority. Only an operation may converge drift. */
export interface UpdateReconcilerDeps {
  updates: UpdatesService
  operationActive: () => boolean | Promise<boolean>
  /** Compatibility for callers supplying a scheduler; observation needs no timers. */
  schedule?: (fn: () => void, ms: number) => void
}

export class UpdateReconciler {
  constructor(private readonly deps: UpdateReconcilerDeps) {}

  async onMachineConnected(machineId: string): Promise<void> {
    await this.reportDrift(machineId)
  }

  async onOperationSettled(channel: UpdateChannel, _target: UpdateTarget, _outcome?: string): Promise<void> {
    await this.reportDrift(undefined, channel)
  }

  async onBoot(): Promise<void> {
    await this.reportDrift()
  }

  onOperationStarted(): void {}

  convergedBy(_machine: WaveMachine): 'reconciler' | undefined {
    return undefined
  }

  private async reportDrift(machineId?: string, channel?: UpdateChannel): Promise<void> {
    if (await this.deps.operationActive()) return
    for (const machine of await this.deps.updates.observedFleet()) {
      if (machineId !== undefined && machine.id !== machineId) continue
      const selectedChannel = this.deps.updates.channelOf(machine)
      if (channel !== undefined && selectedChannel !== channel) continue
      const withdrawn = this.deps.updates.withdrawnTarget(selectedChannel)
      const target = this.deps.updates.target(selectedChannel) ?? withdrawn
      if (!target || machine.version === target.version) continue
      log.info('machine is behind update target; a human must start an operation', {
        machineId: machine.id,
        channel: selectedChannel,
        version: machine.version,
        targetVersion: target.version,
        withdrawn: withdrawn !== undefined,
        reason: withdrawn ? this.deps.updates.targetUnavailableReasonForChannel(selectedChannel) : undefined,
      })
    }
  }
}
