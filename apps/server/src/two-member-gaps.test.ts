/**
 * WITNESSES FOR DESIGN GAPS 1, 2, 3 AND 7 (POD-6282; docs/design/multi-user-instance.md §3.3).
 *
 * Each `it.fails` states what the design REQUIRES and fails today, because
 * `dev/mw` still behaves as the gap describes. The task named in its title makes
 * it pass; that task then turns `it.fails` into `it`. A witness that starts
 * passing before then means the gap closed some other way: find out how before
 * flipping it.
 *
 * An expected failure is a weak instrument on its own: it also "passes" if the
 * fixture is broken. So every witness has a CONTROL beside it, an ordinary test
 * that makes the same call through the same helper for the person `dev/mw`
 * already answers correctly, and passes.
 *
 * | Gap | What dev/mw does today                                 | Flipped by |
 * |-----|--------------------------------------------------------|------------|
 * | 1   | tasks are owner-or-grant: Bob cannot read Alice's task | POD-6288   |
 * | 2   | admin scope `all` covers other people's sessions       | POD-6283   |
 * | 3   | a session on a task takes the task owner as its owner  | POD-6283   |
 * | 7   | the legacy device principal reads every feed row       | POD-6285   |
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
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

const getTask = async (name: 'alice' | 'bob', id: string) =>
  await (await f.as(name)).trpc.issues.get.query({ id } as never)
const renameSession = async (name: 'alice' | 'bob', sessionId: string, title: string) =>
  await (await f.as(name)).trpc.sessions.rename.mutate({ sessionId, name: title } as never)
const feedOf = async (name: 'alice' | 'bob') =>
  snapshotIds(await (await (await f.as(name)).feed()).bootstrap())

describe('gap 1: tasks are owner-or-grant instead of member-wide (POD-6288)', () => {
  it('control: each member reads their own task over tRPC and the feed', async () => {
    expect(await getTask('alice', f.tasks.alice)).toMatchObject({ title: "alice's task" })
    expect(await getTask('bob', f.tasks.bob)).toMatchObject({ title: "bob's task" })
    expect((await feedOf('bob')).issues).toContain(f.tasks.bob)
  })

  it.fails('POD-6288: Bob reads Alice’s task over tRPC', async () => {
    // Today: "unknown issue".
    expect(await getTask('bob', f.tasks.alice)).toMatchObject({ title: "alice's task" })
  })

  it.fails('POD-6288: Bob’s feed bootstrap carries Alice’s task', async () => {
    expect((await feedOf('bob')).issues).toContain(f.tasks.alice)
  })
})

describe('gap 2: the admin role covers other people’s sessions (POD-6283)', () => {
  it('control: a non-admin member is refused a write to another member’s session', async () => {
    await expect(renameSession('bob', f.sessions.alice, 'bob renames alice')).rejects.toThrow(
      /command refused/,
    )
  })

  it.fails('POD-6283: admin Alice is refused a write to Bob’s own session', async () => {
    // Today the admin's scope `all` lets the rename through.
    await expect(renameSession('alice', f.sessions.bob, 'alice renames bob')).rejects.toThrow()
  })
})

describe('gap 3: a session on a task takes the task’s owner (POD-6283)', () => {
  it('control: Bob writes to his session on his own task', async () => {
    await renameSession('bob', f.sessions.bob, 'bob renames his own')
  })

  it.fails('POD-6283: Bob’s session on Alice’s task is recorded as Bob’s', async () => {
    // Today `session-start.ts` gives an issue-owned session the issue's owner.
    const row = await f.handle.registry.sessionStore.sessions.getSession(f.sessions.bobOnAliceTask)
    expect(row?.ownerUserId).toBe(MEMBERS.bob.id)
  })

  it.fails('POD-6283: Bob writes to his session on Alice’s task', async () => {
    // Today: "command refused".
    await renameSession('bob', f.sessions.bobOnAliceTask, 'bob renames his session on alice')
  })

  it.fails('POD-6283: the feed gives Bob, not Alice, his session on Alice’s task', async () => {
    // Today it is the other way round.
    expect((await feedOf('bob')).sessions).toContain(f.sessions.bobOnAliceTask)
    expect((await feedOf('alice')).sessions).not.toContain(f.sessions.bobOnAliceTask)
  })
})

describe('gap 7: the legacy device principal reads every feed row (POD-6285)', () => {
  it('control: a member’s feed holds their own private session and not the other’s', async () => {
    const bob = (await feedOf('bob')).sessions
    expect(bob).toContain(f.sessions.bob)
    expect(bob).not.toContain(f.sessions.alice)
  })

  it.fails('POD-6285: the device-grade feed carries no member’s private session', async () => {
    // Today `feed-visibility.ts` admits `device:shared-instance-password` to every row.
    const device = snapshotIds(await f.legacyDeviceFeed())
    for (const sessionId of Object.values(f.sessions)) {
      expect(device.sessions).not.toContain(sessionId)
    }
  })
})
