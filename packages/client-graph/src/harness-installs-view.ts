import type { HarnessActionResult, HarnessInstallAction } from '@podium/protocol'
import type { MachineHarness } from './machine-harness'
import { RequestAnswer } from './request-answer'

export interface HarnessInstallClient {
  harnessInstalls: {
    action: {
      mutate(input: {
        machineId: MachineHarness['machine']['id']
        harness: MachineHarness['kind']
        action: HarnessInstallAction
        confirmedConversations?: string[]
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
    confirmedConversations?: string[],
  ): Promise<void> {
    await this.load(async () => {
      const result = await client.harnessInstalls.action.mutate({
        machineId: row.machine.id,
        harness: row.kind,
        action,
        ...(confirmedConversations ? { confirmedConversations } : {}),
      })
      return result
    }, true)
  }
}
