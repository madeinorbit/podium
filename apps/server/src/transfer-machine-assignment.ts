/** Explicit offline target promotion, invoked before its server starts. Never called by boot. */
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { stateDir } from '@podium/runtime/config'
import { SessionStore } from './store'

export async function promoteMachineAssignment(input: { sourceMachineId: string; targetMachineId: string; requestId: string }): Promise<void> {
  const store = await SessionStore.open(join(stateDir(), 'podium.db'), asMachineId(input.targetMachineId))
  try {
    await store.machines.transferServerAssignment(input.sourceMachineId, input.targetMachineId, input.requestId)
  } finally {
    await store.close()
  }
}
