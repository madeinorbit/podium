/** Explicit offline target promotion, invoked before its server starts. Never called by boot. */
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { stateDir } from '@podium/runtime/config'
import { SessionStore } from './store'

/**
 * The store opens as the server opens it, capturing every write of a row a
 * synced record reads (POD-6920). No server runs here to drain that capture
 * into the change log, so a plain write would be refused at commit. The move
 * is one transaction that retires its own capture instead: the kinds it
 * captured (the machine-access records, which carry the server bit) go up a
 * generation, as a data migration's do, so a client refetches them from the
 * new server rather than keep the old server bit (POD-7100).
 */
export async function promoteMachineAssignment(input: {
  sourceMachineId: string
  targetMachineId: string
  requestId: string
}): Promise<void> {
  const store = await SessionStore.open(join(stateDir(), 'podium.db'), {
    id: asMachineId(input.targetMachineId),
  })
  try {
    await store.transact(async () => {
      const mark = await store.sync.captureMark()
      await store.machines.transferServerAssignment(
        input.sourceMachineId,
        input.targetMachineId,
        input.requestId,
      )
      await store.sync.retireCapture(mark)
    })
  } finally {
    await store.close()
  }
}
