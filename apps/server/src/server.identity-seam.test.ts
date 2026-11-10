/**
 * `startServer({ identity })`: the server calls the hosted root's function once
 * with its member rows, the cursor and the member list, and brings the member
 * rows up to date before it serves (POD-6746; specification section 3).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceIdentity } from '@podium/identity'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IdentitySeamDeps } from './identity/server-identity'
import { noJanitorWorkerForTests } from './janitor-host'
import { startServer } from './server'

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('startServer identity seam', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  const events: string[] = []
  let seen: IdentitySeamDeps | undefined
  let membersAtBoot: Awaited<ReturnType<IdentitySeamDeps['existingMembers']>> = []

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-identity-seam-'))
    process.env.PODIUM_STATE_DIR = stateDir
    handle = await startServer({
      janitorWorkerForTests: noJanitorWorkerForTests,
      port: 0,
      identity: async (deps) => {
        events.push('identity')
        seen = deps
        membersAtBoot = await deps.existingMembers()
        // Only what the server calls at boot is stood in; nothing else is reached here.
        return {
          workspaceId: 'ws_seam',
          catchUp: async () => {
            events.push('catchUp')
            await deps.appliedCursor.write(3)
            return { applied: 0 }
          },
        } as unknown as WorkspaceIdentity
      },
      plugins: [{ name: 'after-identity', register: () => void events.push('plugin') }],
    })
  })

  afterAll(async () => {
    await handle.close()
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('calls the function once, then catchUp, before plugins register and before it serves', () => {
    expect(events).toEqual(['identity', 'catchUp', 'plugin'])
  })

  it('hands it the member rows, the cursor and the member list of the open store', async () => {
    expect(typeof seen?.memberRows.write).toBe('function')
    expect(membersAtBoot).toEqual([
      { memberId: expect.any(String), role: 'admin', disabled: false, accountId: null },
    ])
    expect(await seen?.appliedCursor.read()).toBe(3)
  })

  it('still serves', async () => {
    const health = await fetch(`http://127.0.0.1:${handle.port}/health`)
    expect(await health.text()).toBe('ok')
  })
})
