/**
 * THE TWO-MEMBER FIXTURE, AND WHAT `dev/mw` ALREADY TELLS ALICE AND BOB APART BY
 * (POD-6282).
 *
 * The first test pins who owns what, so a later change that moves an owner shows
 * up here rather than as a confusing failure in someone's acceptance test. Every
 * other test drives one fixture helper and shows that Alice and Bob get DIFFERENT
 * answers from it on a question today's code already answers per person: machine
 * `use`, the admin role, the per-person feed slice of private sessions, and an
 * agent's delegation. Each is a difference the design keeps (§2.3, §2.4), so
 * these stay green through the epic. A helper that gave both members the same answer could be
 * silently acting as one person; these are the checks that it does not.
 *
 * What the design says should change (gaps 1, 2, 3 and 7) is pinned separately,
 * as expected failures, in `two-member-gaps.test.ts`.
 */

import type { IssueId, SessionId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readIssue } from './modules/issues/issue-reader'
import {
  changedIds,
  MEMBERS,
  snapshotIds,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
beforeAll(async () => {
  f = await startTwoMemberInstance()
}, 60_000)
afterAll(async () => {
  await f?.close()
})

describe('the two-member fixture', () => {
  it('builds Alice, Bob and Carol with their machines, tasks and sessions in one call', async () => {
    const store = f.handle.registry.sessionStore
    expect(await store.users.get(MEMBERS.alice.id)).toMatchObject({
      role: 'admin',
      disabledAt: null,
    })
    expect(await store.users.get(MEMBERS.bob.id)).toMatchObject({
      role: 'member',
      disabledAt: null,
    })
    // A disabled account does not read back as an actor at all.
    expect(await store.users.get(MEMBERS.carol.id)).toBeUndefined()
    expect((await store.users.list()).map((member) => member.id)).not.toContain(MEMBERS.carol.id)

    // Custody is the grant edge, one machine each.
    expect(await store.machines.custodian(f.machines.alice)).toBe(MEMBERS.alice.id)
    expect(await store.machines.custodian(f.machines.bob)).toBe(MEMBERS.bob.id)

    const issue = async (id: IssueId) => await readIssue(store.issues, id)
    expect(await issue(f.tasks.alice)).toMatchObject({ ownerUserId: MEMBERS.alice.id })
    expect(await issue(f.tasks.bob)).toMatchObject({ ownerUserId: MEMBERS.bob.id })

    const session = async (id: SessionId) => await store.sessions.getSession(id)
    expect(await session(f.sessions.alice)).toMatchObject({
      ownerUserId: MEMBERS.alice.id,
      machineId: f.machines.alice,
      issueId: f.tasks.alice,
    })
    expect(await session(f.sessions.bob)).toMatchObject({
      ownerUserId: MEMBERS.bob.id,
      machineId: f.machines.bob,
      issueId: f.tasks.bob,
    })
    // Bob started it, on his machine, on Alice's task. Its recorded OWNER is gap 3
    // (two-member-gaps.test.ts); who started it is already right.
    expect(await session(f.sessions.bobOnAliceTask)).toMatchObject({
      machineId: f.machines.bob,
      issueId: f.tasks.alice,
      createdBy: { onBehalfOf: MEMBERS.bob.id },
    })
  })

  it('signs Alice and Bob in over HTTP and refuses Carol', async () => {
    expect((await f.login('alice')).status).toBe(200)
    expect((await f.login('bob')).status).toBe(200)
    expect((await f.login('carol')).status).toBe(401)
    await expect(f.as('carol')).rejects.toThrow(/carol could not sign in \(401\)/)
  })
})

describe('acting as a member over HTTP', () => {
  it('resolves each cookie to its own member', async () => {
    for (const name of ['alice', 'bob'] as const) {
      const status = await (await f.as(name)).fetch('/auth/status')
      expect(await status.json()).toMatchObject({ authed: true, userId: MEMBERS[name].id })
    }
  })

  it('tRPC: machine use follows custody, and only the admin sees the other machine', async () => {
    const list = async (name: 'alice' | 'bob') =>
      (await (await f.as(name)).trpc.machines.list.query()).map((machine) => [
        machine.id,
        machine.use,
      ])
    // Alice manages and sees every machine by her role, but holds `use` only on
    // her own; Bob sees only his.
    expect(await list('alice')).toEqual([
      [f.machines.alice, 'granted'],
      [f.machines.bob, 'denied'],
    ])
    expect(await list('bob')).toEqual([[f.machines.bob, 'granted']])
  })

  it('tRPC: instance management is the admin’s alone', async () => {
    expect(await (await f.as('alice')).trpc.auth.status.query()).toMatchObject({
      canManageInstance: true,
    })
    expect(await (await f.as('bob')).trpc.auth.status.query()).toMatchObject({
      canManageInstance: false,
    })
  })
})

describe('acting as a member over the WebSocket feed', () => {
  it('bootstraps each member with their own private session and not the other’s', async () => {
    const alice = snapshotIds(await (await (await f.as('alice')).feed()).bootstrap())
    const bob = snapshotIds(await (await (await f.as('bob')).feed()).bootstrap())
    expect(alice.sessions).toContain(f.sessions.alice)
    expect(alice.sessions).not.toContain(f.sessions.bob)
    expect(bob.sessions).toContain(f.sessions.bob)
    expect(bob.sessions).not.toContain(f.sessions.alice)
  })

  it('pushes a session’s incremental delta to its owner only', async () => {
    const aliceFeed = await (await f.as('alice')).feed()
    const bobFeed = await (await f.as('bob')).feed()
    const rename = async (name: 'alice' | 'bob', sessionId: string, title: string) =>
      await (await f.as(name)).trpc.sessions.rename.mutate({ sessionId, name: title } as never)

    // Bob's change first, then Alice's: once Alice holds her own later delta,
    // she would already hold Bob's had it been sent to her.
    await rename('bob', f.sessions.bob, 'bob renamed his session')
    await rename('alice', f.sessions.alice, 'alice renamed her session')
    await aliceFeed.until(() =>
      changedIds(aliceFeed.deltas(), 'session').includes(f.sessions.alice),
    )
    await bobFeed.until(() => changedIds(bobFeed.deltas(), 'session').includes(f.sessions.bob))

    expect(changedIds(aliceFeed.deltas(), 'session')).not.toContain(f.sessions.bob)
    expect(changedIds(bobFeed.deltas(), 'session')).not.toContain(f.sessions.alice)
    aliceFeed.close()
    bobFeed.close()
  })
})

describe('acting as an agent session over the daemon relay', () => {
  it('CLI: each agent is bound to its own human’s task', async () => {
    const alice = await f.agent(f.sessions.alice).cli(['prime'])
    const bob = await f.agent(f.sessions.bob).cli(['prime'])
    expect(alice).toContain("alice's task")
    expect(alice).not.toContain("bob's task")
    expect(bob).toContain("bob's task")
    expect(bob).not.toContain("alice's task")
  })

  it('MCP: each agent is bound to its own human’s task', async () => {
    const alice = await f.agent(f.sessions.alice).mcp('issue_prime', {})
    const bob = await f.agent(f.sessions.bob).mcp('issue_prime', {})
    expect(alice).toContain("alice's task")
    expect(alice).not.toContain("bob's task")
    expect(bob).toContain("bob's task")
    expect(bob).not.toContain("alice's task")
  })
})
