/**
 * `startServer({ identity })`: the server calls the hosted root's function once
 * with its member rows, the cursor and the member list, and brings the member
 * rows up to date before it serves (POD-6746; specification section 3).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemberWrite, WorkspaceIdentity } from '@podium/identity'
import { asMachineId, newMemberId, parseMachineAccessRowId } from '@podium/model'
import { readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { readOrCreateUpdateSigningKey } from '@podium/runtime/update-signing-key'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IdentitySeamDeps } from './identity/server-identity'
import { noJanitorWorkerForTests } from './janitor-host'
import { startServer } from './server'
import { SessionStore } from './store'

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
          core: {
            accounts: {},
            capabilities: () => ({ adminEndDeviceSignIn: false }),
            sweep: async () => {},
          },
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
    // An ordinary start: the database may be written.
    expect(seen?.recoveryOnly).toBe(false)
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

/**
 * A hosted workspace whose memberships changed while the server was down: the
 * boot catch-up applies them before it serves, and each member write is a
 * change-log commit (POD-6920). It must run once the registry has wired the
 * member writer to the log, or the capture is left undrained and the server
 * cannot start (POD-6938 finding 1).
 */
describe('startServer identity seam: memberships pending at boot', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  const stays = newMemberId()
  const leaves = newMemberId()
  const joins = newMemberId()
  const machine = 'm-seeded'
  const member = (change: Partial<MemberWrite> & { memberId: string; version: number }) =>
    ({
      state: 'active',
      role: 'member',
      accountId: `acct-${change.memberId}`,
      profile: { name: change.memberId, image: null, email: `${change.memberId}@example.test` },
      actor: { system: 'organisation' },
      ...change,
    }) as MemberWrite
  // What the organisation changed while the server was down, above the cursor.
  // Admins see the seeded machine, plain members do not (it has no custodian):
  // each change moves its member's access record on it.
  const pending: MemberWrite[] = [
    member({ memberId: joins, version: 3, role: 'admin' }),
    member({ memberId: stays, version: 4, role: 'admin' }),
    member({ memberId: leaves, version: 5, state: 'removed', accountId: null, profile: null }),
  ]

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-identity-seam-pending-'))
    process.env.PODIUM_STATE_DIR = stateDir
    // The workspace as the last run left it: two members applied, cursor at 2,
    // and one machine whose access records the members' changes move.
    const seeded = await SessionStore.open(
      join(stateDir, 'podium.db'),
      asMachineId(readOrCreateLocalMachineId(stateDir)),
      { changeCapture: 'whenLogAttaches' },
    )
    await seeded.users.memberRows.write(member({ memberId: stays, version: 1 }))
    await seeded.users.memberRows.write(member({ memberId: leaves, version: 2 }))
    await seeded.settings.recordAppliedMembershipVersion(2)
    await seeded.machines.upsertMachine({
      id: machine,
      name: machine,
      hostname: machine,
      tokenHash: 'seeded',
      ownerUserId: null,
    })
    await seeded.close()
    // An installation with an enrolled machine already has its update key.
    readOrCreateUpdateSigningKey(stateDir)

    handle = await startServer({
      janitorWorkerForTests: noJanitorWorkerForTests,
      port: 0,
      identity: async (deps) =>
        ({
          workspaceId: 'ws_seam_pending',
          core: {
            accounts: {},
            capabilities: () => ({ adminEndDeviceSignIn: false }),
            sweep: async () => {},
          },
          // The package's catch-up: each membership above the cursor, applied
          // with its cursor step in one transaction, in version order.
          catchUp: async () => {
            const cursor = await deps.appliedCursor.read()
            let applied = 0
            for (const change of pending.filter((row) => row.version > cursor)) {
              await deps.appliedCursor.transaction!(async () => {
                await deps.memberRows.write(change)
                await deps.appliedCursor.write(change.version)
              })
              applied += 1
            }
            return { applied }
          },
        }) as unknown as WorkspaceIdentity,
    })
  })

  afterAll(async () => {
    await handle?.close()
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('boots and applies the join, the role change and the removal', async () => {
    const store = handle.registry.sessionStore
    expect(await store.settings.appliedMembershipVersion()).toBe(5)
    const rows = new Map(
      (await store.users.listIncludingDisabled()).map((row) => [row.id as string, row]),
    )
    expect(rows.get(joins)).toMatchObject({ role: 'admin', disabledAt: null })
    expect(rows.get(stays)).toMatchObject({ role: 'admin', disabledAt: null })
    expect(rows.get(leaves)?.disabledAt).not.toBeNull()
  })

  it('puts each change in the log as the access records it moved, in version order', async () => {
    const store = handle.registry.sessionStore
    // Each member's last access change on the seeded machine. The boot may
    // append rows for the seeded members before the catch-up (the host's row);
    // only the catch-up appends after the join, so the order proves the source.
    const last = new Map<string, { op: string; seq: number }>()
    for (const change of await store.sync.changesSince(0)) {
      if (change.entity !== 'machineAccess') continue
      const { userId, machineId } = parseMachineAccessRowId(change.entityId)
      if (machineId === machine) last.set(userId, { op: change.op, seq: change.seq })
    }
    expect(last.get(joins)?.op).toBe('upsert')
    expect(last.get(stays)?.op).toBe('upsert')
    expect(last.get(leaves)?.op).toBe('remove')
    expect(last.get(joins)!.seq).toBeLessThan(last.get(stays)!.seq)
    expect(last.get(stays)!.seq).toBeLessThan(last.get(leaves)!.seq)
  })

  it('still serves', async () => {
    const health = await fetch(`http://127.0.0.1:${handle.port}/health`)
    expect(await health.text()).toBe('ok')
  })
})
