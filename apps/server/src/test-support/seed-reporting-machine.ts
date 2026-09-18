import { firstAdminMemberId } from '@podium/model'
import type { SessionStore } from '../store'

/** Explicit fixture placement: an enrolled execution machine and its reported roots. */
export async function seedReportingMachine(store: SessionStore, repoPaths: string[] = []): Promise<void> {
  await store.machines.upsertMachine({
    id: store.hostMachineId,
    name: 'fixture-machine',
    hostname: 'fixture-machine',
    tokenHash: 'fixture-token',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: true, agentExecution: true },
  })
  for (const path of repoPaths) await store.repos.addRepo(path, store.hostMachineId)
}
