/**
 * A REPO THE SERVER REGISTERS BY ITSELF REACHES THE FEED WITH ITS ROW
 * (POD-6769's finding, fixed in POD-6770).
 *
 * Repo discovery wrote the registry bare. While the `repo` kind compared a
 * declared value with the stored copy, the next registry write republished
 * every repo, so nobody noticed. With compare at save a record changes only
 * in the commit that names it, so a discovered repo stayed off the feed until
 * the boot reconcile. Discovery's writes now run through the registry's write
 * funnel; this drives the write as the server wires it and reads the feed.
 */

import type { MachineId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'

/** Discovery's registry writes, as the composition root wired them. */
interface DiscoveryWrites {
  addRepo(path: string, machineId: MachineId, originUrl?: string): Promise<void>
  removeRepo(path: string, machineId: MachineId): Promise<void>
}
const discoveryWrites = (reg: SessionRegistry): DiscoveryWrites =>
  (reg.repoDiscovery as unknown as { deps: DiscoveryWrites }).deps

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

describe('repo discovery publishes the repo it registers', () => {
  it('appends the repo record with the row, and its remove when the row goes', async () => {
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    registries.push(reg)
    const machineId = reg.sessionStore.hostMachineId
    const writes = discoveryWrites(reg)

    const before = await reg.changeLedger.cursor()
    await writes.addRepo('/discovered/repo', machineId, 'https://example.test/discovered.git')
    const added = ((await reg.changeLedger.changesSince(before)) ?? []).filter(
      (change) => change.entity === 'repo',
    )
    // The row exists, and the same commit appended its record.
    const row = (await reg.sessionStore.repos.listRepos(machineId)).find(
      (repo) => repo.path === '/discovered/repo',
    )
    expect(row).toBeDefined()
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ op: 'upsert', id: row?.repoId })

    const afterAdd = await reg.changeLedger.cursor()
    await writes.removeRepo('/discovered/repo', machineId)
    const removed = ((await reg.changeLedger.changesSince(afterAdd)) ?? []).filter(
      (change) => change.entity === 'repo',
    )
    expect(removed).toEqual([expect.objectContaining({ op: 'remove', id: row?.repoId })])
  })
})
