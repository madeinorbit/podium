import type { HarnessActionResult, HarnessInstallAction } from '@podium/protocol'
import type { MachineHarness } from './machine-harness'
import { RequestAnswer } from './request-answer'

export interface HarnessInstallClient {
  harnessInstalls: {
    action: {
      mutate(input: {
        machineId: string
        harness: MachineHarness['kind']
        action: HarnessInstallAction
      }): Promise<HarnessActionResult>
    }
  }
}

/** An action answer belongs to its open view; machine facts arrive through inventory sync. */
export class HarnessInstallAnswer extends RequestAnswer<HarnessActionResult> {
  async run(
    client: HarnessInstallClient,
    row: MachineHarness,
    action: HarnessInstallAction,
  ): Promise<void> {
    await this.load(async () => {
      const result = await client.harnessInstalls.action.mutate({
        machineId: row.machine.id,
        harness: row.kind,
        action,
      })
      return result
    }, true)
  }
}
