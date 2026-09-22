/**
 * shells.forWorktree over tRPC (POD-4436) — the server-owned dock-shell mapping.
 *
 * DONE WHEN 1: opening the dock for a worktree on two devices shows the same
 * session id (same principal, two calls). DONE WHEN 2 at the wire: concurrent
 * forWorktree calls create exactly one shell session.
 *
 * Real spawns need a real target: the fixture provisions the host machine row
 * (assignment server + agentExecution, like session-start.test.ts) and busts
 * the machine-record cache, because makeOracle attaches the daemon socket but
 * writes no machine row.
 */

import { asMachineId, firstAdminMemberId } from '@podium/model'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, makeOracle } from '../sessions/oracle-support'

afterEach(() => disposeOracles())

type Oracle = Awaited<ReturnType<typeof makeOracle>>

async function makeShellsOracle(): Promise<Oracle> {
  const o = await makeOracle()
  await o.store.machines.upsertMachine({
    id: o.store.hostMachineId,
    name: 'test-host',
    hostname: 'test-host',
    tokenHash: 'test',
    ownerUserId: await firstAdminMemberId(o.store),
    assignment: { server: true, agentExecution: true },
  })
  o.reg.modules.machines.invalidateMachineCache()
  return o
}

async function shellSessionsFor(o: Oracle, cwd: string) {
  const all = await o.reg.modules.sessions.listSessions(undefined, 'rpc')
  return all.filter((s) => s.agentKind === 'shell' && s.cwd === cwd && !s.archived)
}

describe('shells.forWorktree', () => {
  it('two opens of one worktree attach to the same session id', async () => {
    const o = await makeShellsOracle()
    const first = await o.call.shells.forWorktree({ worktreePath: '/r/.worktrees/a' })
    expect(first.created).toBe(true)
    // The second device opens the same worktree: same id, not created.
    const second = await o.call.shells.forWorktree({ worktreePath: '/r/.worktrees/a/' })
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.created).toBe(false)
    expect(await shellSessionsFor(o, '/r/.worktrees/a')).toHaveLength(1)
  })

  it('concurrent opens create exactly one shell', async () => {
    const o = await makeShellsOracle()
    const [a, b] = await Promise.all([
      o.call.shells.forWorktree({ worktreePath: '/r/.worktrees/a' }),
      o.call.shells.forWorktree({ worktreePath: '/r/.worktrees/a' }),
    ])
    expect(a.sessionId).toBe(b.sessionId)
    expect(await shellSessionsFor(o, '/r/.worktrees/a')).toHaveLength(1)
  })

  it('different worktrees get different shells', async () => {
    const o = await makeShellsOracle()
    const a = await o.call.shells.forWorktree({ worktreePath: '/r/.worktrees/a' })
    const b = await o.call.shells.forWorktree({ worktreePath: '/r/.worktrees/b' })
    expect(b.sessionId).not.toBe(a.sessionId)
  })

  it('an explicit host machine is accepted; an unknown machine is refused', async () => {
    const o = await makeShellsOracle()
    const onHost = await o.call.shells.forWorktree({
      worktreePath: '/r/.worktrees/a',
      machineId: o.store.hostMachineId,
    })
    expect(onHost.created).toBe(true)
    await expect(
      o.call.shells.forWorktree({
        worktreePath: '/r/.worktrees/b',
        machineId: asMachineId(randomUUID()),
      }),
    ).rejects.toThrow()
  })

  it('a relative path is refused without creating', async () => {
    const o = await makeShellsOracle()
    await expect(o.call.shells.forWorktree({ worktreePath: 'relative/path' })).rejects.toThrow()
    expect(await shellSessionsFor(o, 'relative/path')).toHaveLength(0)
  })
})
