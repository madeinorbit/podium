/**
 * SEVERAL WORKSPACES OVER ONE DATABASE, for a test [POD-6959 design 2.4].
 *
 * `openWorkspaceStores(['ws_a', 'ws_b'])` opens one database and returns one
 * `SessionStore` per id, in the order given: the first id is the workspace the
 * database boots, and every id is provisioned. The stores share the database,
 * so closing any one of them closes it for all.
 *
 * It builds on `openTestStore`, so a store here is opened exactly as every
 * other test store is (the pre-migrated image, the engine switch, change
 * capture only once a change log attaches).
 */

import { asWorkspaceId, type MachineId } from '@podium/model'
import type { SessionStore } from '../store'
import { openTestStore } from './open-test-store'

export async function openWorkspaceStores<const Ids extends readonly [string, ...string[]]>(
  ids: Ids,
  options: { path?: string; hostMachineId?: MachineId } = {},
): Promise<{ readonly [K in keyof Ids]: SessionStore }> {
  const workspaces = ids.map(asWorkspaceId)
  if (new Set(workspaces).size !== workspaces.length) {
    throw new Error(`openWorkspaceStores: the workspace ids repeat: ${ids.join(', ')}`)
  }
  const [boot, ...others] = workspaces as [(typeof workspaces)[number], ...typeof workspaces]
  const first = await openTestStore(options.path, options.hostMachineId, undefined, {
    workspace: boot,
  })
  const stores: SessionStore[] = [first]
  try {
    for (const workspace of others) {
      await first.database.provisionWorkspace(workspace)
      stores.push(await first.database.workspace(workspace))
    }
  } catch (error) {
    await first.close()
    throw error
  }
  return stores as unknown as { readonly [K in keyof Ids]: SessionStore }
}
