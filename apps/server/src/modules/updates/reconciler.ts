import { createLogger } from '@podium/logger'
import { type UpdateChannel } from '@podium/model'
import { type UpdateTarget } from '@podium/protocol'
import { type UpdatesService } from './service'

const log = createLogger('server:updates')

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
