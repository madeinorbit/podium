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
 *
 * ON THE SYNC WRITE ENTRY POINT (POD-6419): the route is an adapter onto
 * `submit`, and the shell's start is a `session.launch` effect record the write
 * creates; the spawn runs after the commit, so the shell row appears a beat
 * after the answer. A shell whose start is still under way is live.
 */

import { asMachineId, type SessionId, firstAdminMemberId } from '@podium/model'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeOracles, makeOracle } from '../sessions/oracle-support'
import { SESSION_LAUNCH_KIND } from '../sessions/session-launch-effect'
import {
  appliedReply,
  envelope,
  expectAppliedOnPath,
  rowsOf,
  submit,
} from '../sync-write/outbox-test-support'

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
  return o
}

async function shellSessionsFor(o: Oracle, cwd: string) {
  const all = await o.reg.modules.sessions.listSessions(undefined, 'rpc')
  return all.filter((s) => s.agentKind === 'shell' && s.cwd === cwd && !s.archived)
}

/** The shell's start ran: its row exists. */
async function started(o: Oracle, cwd: string, count = 1) {
  await vi.waitFor(async () => expect(await shellSessionsFor(o, cwd)).toHaveLength(count))
}

/** The `session.launch` records on one session id. */
async function launchesOf(o: Oracle, sessionId: SessionId) {
  const row = await o.store.effects.newestOnTarget(
    SESSION_LAUNCH_KIND,
    { kind: 'session', id: sessionId },
    'active',
  )
  const done = await o.store.effects.newestOnTarget(
    SESSION_LAUNCH_KIND,
    { kind: 'session', id: sessionId },
    'succeeded',
  )
  return [row, done].filter((r) => r !== undefined)
}

describe('shells.forWorktree', () => {
  it('two opens of one worktree attach to the same session id', async () => {
    const o = await makeShellsOracle()
    const first = await o.call.shells.forWorktree({ worktreePath: '/r/.worktrees/a' })
    expect(first.created).toBe(true)
    await started(o, '/r/.worktrees/a')
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
    await started(o, '/r/.worktrees/a')
    expect(await shellSessionsFor(o, '/r/.worktrees/a')).toHaveLength(1)
  })

  it('a shell whose start is still under way is live: a second open attaches to it', async () => {
    const o = await makeShellsOracle()
    // Hold the start pending: no daemon can take it.
    const ready = vi.spyOn(o.reg.modules.machines, 'onlineMachineIds').mockReturnValue([])
    const first = await o.call.shells.forWorktree({ worktreePath: '/r/.worktrees/p' })
    const second = await o.call.shells.forWorktree({ worktreePath: '/r/.worktrees/p' })
    expect(second).toEqual({ sessionId: first.sessionId, created: false })
    expect(await launchesOf(o, first.sessionId)).toHaveLength(1)
    ready.mockRestore()
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

describe('shells.forWorktree on the sync write entry point (POD-6419)', () => {
  it('is applied once with provenance and a receipt; the replay asks for no second start', async () => {
    const o = await makeShellsOracle()
    const { result, rows } = await expectAppliedOnPath(
      o,
      envelope('shells.forWorktree', { worktreePath: '/r/.worktrees/s' }, 'mut_shell_s'),
      { writes: true },
    )
    const { sessionId } = result as { sessionId: SessionId }
    // The start is an effect record, written by this command.
    expect(rows.map((row) => row.entity)).toContain('effect')
    await started(o, '/r/.worktrees/s')
    expect((await shellSessionsFor(o, '/r/.worktrees/s'))[0]?.sessionId).toBe(sessionId)
    expect(await launchesOf(o, sessionId)).toHaveLength(1)
  })

  it('a rollback asks for no start and spawns nothing; a commit asks for exactly one', async () => {
    const o = await makeShellsOracle()
    const spawns = () => o.daemon.filter((msg) => msg.type === 'spawn').length
    const before = spawns()
    const rollback = new Error('forced rollback')
    let claimed: SessionId | undefined
    await expect(
      o.store.transact(async () => {
        claimed = (
          await o.reg.modules.dockShells.forWorktree(firstAdminMemberId(), '/r/.worktrees/rb')
        ).sessionId
        throw rollback
      }),
    ).rejects.toBe(rollback)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(spawns()).toBe(before)
    expect(claimed && (await launchesOf(o, claimed))).toEqual([])
    expect(await o.store.dockShells.get(firstAdminMemberId(), '/r/.worktrees/rb')).toBeUndefined()

    const { sessionId } = await o.store.transact(
      async () =>
        await o.reg.modules.dockShells.forWorktree(firstAdminMemberId(), '/r/.worktrees/rb'),
    )
    await started(o, '/r/.worktrees/rb')
    expect(spawns()).toBe(before + 1)
    expect(await launchesOf(o, sessionId)).toHaveLength(1)
  })

  it('an unknown machine is refused before the handler, in the old words', async () => {
    const o = await makeShellsOracle()
    const forWorktree = vi.spyOn(o.reg.modules.dockShells, 'forWorktree')
    const reply = await submit(
      o,
      envelope(
        'shells.forWorktree',
        { worktreePath: '/r/.worktrees/m', machineId: randomUUID() },
        'mut_shell_unknown_machine',
      ),
    )
    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'target-not-found', message: 'unknown machine' },
    })
    expect(forWorktree).not.toHaveBeenCalled()
    expect(await rowsOf(o, 'mut_shell_unknown_machine')).toEqual([])
  })

  it('the old route is a thin adapter onto the entry point', async () => {
    const o = await makeShellsOracle()
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const answer = await o.call.shells.forWorktree({ worktreePath: '/r/.worktrees/route' })
    expect(entry.mock.calls.map(([env]) => env.command)).toEqual(['shells.forWorktree'])
    const viaSubmit = appliedReply(
      await submit(o, envelope('shells.forWorktree', { worktreePath: '/r/.worktrees/route' }, 'mut_shell_again')),
    )
    expect(viaSubmit.result).toEqual({ sessionId: answer.sessionId, created: false })
  })
})
