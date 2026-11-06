/**
 * THE LEFTOVER SERVER-LOCAL WRITES ON THE PLAIN COMMAND PATH (ADR 12 D8, POD-6419).
 *
 * The five lock writes, the two host reads served as mutations, and the update
 * panel's four commands write nothing synced: a lease expires by itself and no
 * screen lists it, a memory breakdown and an update proposal are request answers
 * (ADR 12 D1). Each runs inside the plain command scope, on every transport it is
 * served on, behind the front door: a caller it refuses never reaches the handler.
 * A lock's grant mail is the server's own write, so the scope lets it through.
 */

import type { Capability } from '@podium/model'
import { asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvePrincipal } from '../../command-principal'
import { currentPlainCommand } from '../../plain-command-scope'
import { appRouter } from '../../router'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'

afterEach(() => disposeOracles())

const REPO = '/repo-6419'

async function lockOracle(): Promise<Oracle> {
  const o = await makeOracle()
  await o.store.repos.addRepo(REPO, o.store.hostMachineId)
  return o
}

/** A spy that records which plain command, if any, its call ran inside. */
function scopeOf<T extends object, K extends keyof T>(target: T, key: K) {
  const seen: (string | undefined)[] = []
  const original = target[key] as unknown as (...args: unknown[]) => unknown
  vi.spyOn(target, key as never).mockImplementation(((...args: unknown[]) => {
    seen.push(currentPlainCommand())
    return original.apply(target, args)
  }) as never)
  return seen
}

const VIEWER: Capability = {
  role: 'viewer',
  scope: { kind: 'none' },
  actorUser: firstAdminMemberId(),
  onBehalfOf: firstAdminMemberId(),
}

describe('lock writes on the plain path', () => {
  it('a tRPC acquire and release run inside the plain scope', async () => {
    const o = await lockOracle()
    const acquire = scopeOf(o.reg.modules.locks, 'acquire')
    const release = scopeOf(o.reg.modules.locks, 'release')
    const got = (await o.call.lock.acquire({ repoPath: REPO, name: 'plain' })) as {
      granted: boolean
    }
    expect(got.granted).toBe(true)
    await o.call.lock.release({ repoPath: REPO, name: 'plain' })
    expect(acquire).toEqual(['lock.acquire'])
    expect(release).toEqual(['lock.release'])
  })

  it("an agent's relayed acquire runs inside the plain scope too", async () => {
    const o = await lockOracle()
    const { sessionId } = await o.reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: `${REPO}/.worktrees/a`,
    })
    const acquire = scopeOf(o.reg.modules.locks, 'acquire')
    const reply = await o.relay({
      requestId: 'r-lock',
      sessionId,
      router: 'lock',
      proc: 'acquire',
      input: { repoPath: REPO, name: 'relayed' },
    } as never)
    expect(reply).toMatchObject({ ok: true, result: { granted: true } })
    expect(acquire).toEqual(['lock.acquire'])
  })

  it('a viewer is refused at the front door, before the handler, in the old words', async () => {
    const o = await lockOracle()
    const acquire = vi.spyOn(o.reg.modules.locks, 'acquire')
    const viewer = appRouter.createCaller({
      registry: o.reg,
      capability: VIEWER,
      principal: resolvePrincipal(VIEWER, { parentSessionOf: () => undefined }),
    } as never)
    await expect(viewer.lock.acquire({ repoPath: REPO, name: 'nope' })).rejects.toThrow(
      'not allowed to use locks',
    )
    expect(acquire).not.toHaveBeenCalled()
  })

  it('bad input is refused as a validation error, before the handler', async () => {
    const o = await lockOracle()
    const acquire = vi.spyOn(o.reg.modules.locks, 'acquire')
    await expect(o.call.lock.acquire({ repoPath: REPO, name: 'bad\nname' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(acquire).not.toHaveBeenCalled()
  })

  it("a release that grants the next waiter still mails it: the server's own write", async () => {
    const o = await lockOracle()
    const issue = await o.reg.modules.issues.crud.create({
      repoPath: REPO,
      title: 'waiting for the lock',
      startNow: false,
    })
    await o.reg.modules.issues.crud.update(issue.id, { worktreePath: `${REPO}/.worktrees/w` })
    const { sessionId: waiter } = await o.reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: `${REPO}/.worktrees/w`,
    })
    await o.call.lock.acquire({ repoPath: REPO, name: 'handoff' })
    const queued = await o.relay({
      requestId: 'r-wait',
      sessionId: waiter,
      router: 'lock',
      proc: 'acquire',
      input: { repoPath: REPO, name: 'handoff' },
    } as never)
    expect(queued).toMatchObject({ ok: true, result: { granted: false } })
    const send = vi.spyOn(o.reg.modules.messages, 'send')
    await o.call.lock.release({ repoPath: REPO, name: 'handoff' })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await expect(send.mock.results[0]?.value).resolves.toBeDefined()
  })
})

describe('host and update panel commands on the plain path', () => {
  it('hosts.reclaimInventory runs inside the plain scope', async () => {
    const o = await makeOracle()
    const estimate = scopeOf(o.reg.modules.hosts, 'reclaimDiskEstimate')
    await o.call.hosts.reclaimInventory(undefined).catch(() => undefined)
    expect(estimate).toEqual(['hosts.reclaimInventory'])
  })

  it('updates.checkNow runs inside the plain scope', async () => {
    const o = await makeOracle()
    const check = scopeOf(o.reg.modules.updates, 'checkNow')
    await o.call.updates.checkNow()
    expect(check).toEqual(['updates.checkNow'])
  })

  it('updates.repairPayload keeps its administrator check and its words', async () => {
    const o = await makeOracle()
    const member = asUserId('usr_member_6419_updates')
    const capability: Capability = {
      role: 'worker',
      scope: { kind: 'owned', userId: member },
      actorUser: member,
      onBehalfOf: member,
    }
    const caller = appRouter.createCaller({
      registry: o.reg,
      capability,
      principal: resolvePrincipal(capability, { parentSessionOf: () => undefined }),
    } as never)
    const repair = vi.spyOn(o.reg.modules.updates, 'repairMachine')
    await expect(caller.updates.repairPayload({ id: asSessionId('m') })).rejects.toThrow(
      'Only an administrator can update Podium.',
    )
    expect(repair).not.toHaveBeenCalled()
  })
})
