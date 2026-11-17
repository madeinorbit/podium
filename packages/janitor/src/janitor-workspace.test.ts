/**
 * THE JANITOR SERVES ONE WORKSPACE (POD-7021, POD-6959 design 2.4 "Fleet reads").
 *
 * A command does not name its workspace yet, so the janitor serves a database of one
 * workspace and refuses one of several, and the workspace must have an active admin.
 * That each read observes only its workspace's rows, joins included, is the server's
 * to prove: `apps/server/src/store/janitor-reads.workspace.test.ts`, on both engines.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  type JanitorDatabase,
  type JanitorReads,
  type JanitorWorkspace,
  startJanitor,
} from './janitor'

/** A workspace whose only read is the boot check's. */
function workspace(id: string, admin: string | undefined): JanitorWorkspace & { scans: number } {
  const ws = {
    id,
    scans: 0,
    scan: async <T>(fn: (reads: JanitorReads) => Promise<T>): Promise<T> => {
      ws.scans += 1
      return await fn({ earliestAdminId: async () => admin } as JanitorReads)
    },
  }
  return ws
}

function databaseOf(workspaces: JanitorWorkspace[]): JanitorDatabase & {
  close: ReturnType<typeof vi.fn>
} {
  return { workspacesWithFeed: async () => workspaces, close: vi.fn(async () => {}) }
}

/** No server listens here: the first tick's handshake fails fast and is only a delay. */
const OFFLINE = { serverUrl: 'http://127.0.0.1:1', token: 't', tickMs: 60_000 }

describe('the janitor serves one workspace (POD-7021)', () => {
  it('refuses a database of several workspaces, and closes it', async () => {
    const database = databaseOf([workspace('ws_a', 'mem_a'), workspace('ws_b', 'mem_b')])
    await expect(startJanitor({ ...OFFLINE, database })).rejects.toThrow(
      'janitor serves a database of one workspace; this one has 2 with a feed',
    )
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('refuses a workspace without an active admin, and closes it', async () => {
    const database = databaseOf([workspace('local', undefined)])
    await expect(startJanitor({ ...OFFLINE, database })).rejects.toThrow(
      'janitor requires an active admin member',
    )
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('serves the one workspace, and closes the database when it is closed', async () => {
    const local = workspace('local', 'mem_admin')
    const database = databaseOf([local])
    const handle = await startJanitor({ ...OFFLINE, database })
    try {
      expect(local.scans).toBe(1)
      expect(database.close).not.toHaveBeenCalled()
    } finally {
      await handle.close()
    }
    expect(database.close).toHaveBeenCalledOnce()
  })
})
