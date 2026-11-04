/**
 * PERSONAL TASK RECORDS (POD-6290; docs/design/multi-user-instance.md §2.2,
 * §4.4; acceptance MU-04's sidebar half and MU-09's data).
 *
 * A member's sidebar is built from the tasks they started or joined, plus a
 * removable "assigned to you by X" row for tasks assigned to them. Seeing,
 * searching or opening a task adds nothing. The same start and join records are
 * a task's collaborators, and being one grants no access.
 *
 * The personal set is read the way every client will read it: off the member's
 * own `issueUserState` rows in their feed bootstrap, through the one predicate
 * (`inPersonalSet`). Every test makes its own task through Alice's login, so the
 * shared fixture rows stay as the other two-member files expect them.
 */

import { asIssueId, type IssueUserStateWire, inPersonalSet, type SessionId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MEMBERS,
  type MemberName,
  REPO_PATH,
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

const alice = MEMBERS.alice.id
const bob = MEMBERS.bob.id

interface Wire {
  id: string
  revision: number
  assignee?: string
  updatedAt: string
}

const trpc = async (name: MemberName) => (await f.as(name)).trpc

/** A fresh task of Alice's, created through her own login. */
async function aliceTask(title: string): Promise<Wire> {
  return (await (
    await trpc('alice')
  ).issues.create.mutate({ repoPath: REPO_PATH, title, startNow: false } as never)) as Wire
}

const read = async (name: MemberName, id: string): Promise<Wire> =>
  (await (await trpc(name)).issues.get.query({ id } as never)) as Wire

/** The member's own user-state rows, as their feed bootstraps them. */
async function feedStates(name: MemberName): Promise<IssueUserStateWire[]> {
  const feed = await (await f.as(name)).feed()
  try {
    return ((await feed.bootstrap()).issueUserStates ?? []) as IssueUserStateWire[]
  } finally {
    feed.close()
  }
}

/** The ids in the member's personal set, read off their own feed. */
async function personalSet(name: MemberName): Promise<string[]> {
  return (await feedStates(name)).filter((row) => inPersonalSet(row)).map((row) => row.entityId)
}

const stored = async (name: MemberName, id: string) =>
  await f.handle.registry.sessionStore.issues.getIssueUserState(MEMBERS[name].id, asIssueId(id))

const collaborators = async (name: MemberName, id: string) =>
  (await (await trpc(name)).issues.collaborators.query({ id } as never)) as Array<{
    userId: string
    via: string | null
  }>

/** A shell session of Bob's on `issueId`, started through his own login. */
async function bobStartsOn(issueId: string, title: string): Promise<SessionId> {
  return (
    (await (
      await trpc('bob')
    ).sessions.create.mutate({
      agentKind: 'shell',
      cwd: `/wt/bob-${title}`,
      machineId: f.machines.bob,
      issueId,
      title,
    } as never)) as { sessionId: SessionId }
  ).sessionId
}

describe('starting work puts a task in the starter’s set, never the assignee’s choice', () => {
  it('Bob starting an agent on Alice’s task puts it in Bob’s set, with Alice as assignee', async () => {
    const task = await aliceTask('bob starts on this')
    // Control: before Bob does anything, the task is Alice's and only hers.
    expect(await personalSet('alice')).toContain(task.id)
    expect(await personalSet('bob')).not.toContain(task.id)

    const session = await bobStartsOn(task.id, 'start-on-alice')

    expect(await personalSet('bob')).toContain(task.id)
    expect(await stored('bob', task.id)).toMatchObject({ joinedVia: 'start', assignedAt: null })
    // The session is Bob's, and starting it changed nobody's assignment.
    expect((await f.handle.registry.modules.sessions.sessionOwner(session))?.owner).toBe(bob)
    expect((await read('bob', task.id)).assignee).toBe(alice)
    expect((await read('alice', task.id)).assignee).toBe(alice)
  })

  it('an agent of Bob’s that joins records Bob’s set, as his agent’s (own agent elevation)', async () => {
    const task = await aliceTask('bob’s agent joins this')
    await f.agent(f.sessions.bob, { outsideScope: true }).client.issues.join.mutate({
      id: task.id,
    } as never)
    expect(await personalSet('bob')).toContain(task.id)
    expect(await stored('bob', task.id)).toMatchObject({ joinedVia: 'agent' })
    expect((await read('bob', task.id)).assignee).toBe(alice)
  })

  it('an explicit join records the reason, and the first reason is kept', async () => {
    const task = await aliceTask('bob joins this')
    await (await trpc('bob')).issues.join.mutate({ id: task.id } as never)
    const first = await stored('bob', task.id)
    expect(first).toMatchObject({ joinedVia: 'join' })
    await bobStartsOn(task.id, 'after-join')
    expect(await stored('bob', task.id)).toMatchObject({
      joinedVia: 'join',
      joinedAt: first?.joinedAt,
    })
  })
})

describe('seeing, searching and opening a task add nothing', () => {
  it('Bob opening, reading or searching Alice’s task adds nothing to Bob’s set', async () => {
    const task = await aliceTask('findable only by searching zebracorn')
    const bobClient = await trpc('bob')

    // Bob sees it everywhere a reader can (design §2.2)...
    await bobClient.issues.get.query({ id: task.id } as never)
    await bobClient.issues.markRead.mutate({ id: task.id } as never)
    await bobClient.issues.list.query({ repoPath: REPO_PATH } as never)
    const found = JSON.stringify(
      await bobClient.issues.search.query({ text: 'zebracorn', repoPath: REPO_PATH } as never),
    )
    expect(found).toContain(task.id)
    // ...and opening it did write Bob's read marker, so the row exists:
    expect((await stored('bob', task.id))?.readAt).not.toBeNull()

    // ...but none of it made the task Bob's.
    expect(await personalSet('bob')).not.toContain(task.id)
    expect(await stored('bob', task.id)).toMatchObject({ joinedAt: null, assignedAt: null })
    expect((await collaborators('bob', task.id)).map((c) => c.userId)).toEqual([alice])
  })
})

describe('an assignment adds a removable row, and removing it changes nothing else', () => {
  it('reassigning to Bob adds “assigned to you by Alice”; dismissing it changes nothing else', async () => {
    const task = await aliceTask('reassigned to bob')
    expect(await personalSet('bob')).not.toContain(task.id)

    await (await trpc('alice')).issues.update.mutate({
      id: task.id,
      patch: { assignee: bob },
    } as never)

    expect(await personalSet('bob')).toContain(task.id)
    const row = (await feedStates('bob')).find((state) => state.entityId === task.id)
    expect(row).toMatchObject({ assignedBy: alice })
    expect(row?.assignedAt).toEqual(expect.any(String))
    // An assignment alone is not a start or a join: Bob is no collaborator.
    expect(row?.joinedAt ?? null).toBeNull()
    expect((await collaborators('bob', task.id)).map((c) => c.userId)).toEqual([alice])

    const issueBefore = await f.handle.registry.sessionStore.issues.getIssue(task.id)
    const aliceBefore = await stored('alice', task.id)
    const aliceSetBefore = await personalSet('alice')

    const dismissed = await (await trpc('bob')).issues.dismissAssignment.mutate({
      id: task.id,
    } as never)
    expect(dismissed).toEqual({ dismissed: true })

    expect(await personalSet('bob')).not.toContain(task.id)
    // Nothing else moved: the task row (assignee, revision, timestamps), Alice's
    // records and set, and the collaborators.
    expect(await f.handle.registry.sessionStore.issues.getIssue(task.id)).toEqual(issueBefore)
    expect((await read('bob', task.id)).assignee).toBe(bob)
    expect(await stored('alice', task.id)).toEqual(aliceBefore)
    expect(await personalSet('alice')).toEqual(aliceSetBefore)
    expect((await collaborators('bob', task.id)).map((c) => c.userId)).toEqual([alice])
  })

  it('dismissing keeps a start: a task Bob started stays in his set', async () => {
    const task = await aliceTask('bob started, then was assigned')
    await bobStartsOn(task.id, 'started-then-assigned')
    await (await trpc('alice')).issues.update.mutate({
      id: task.id,
      patch: { assignee: bob },
    } as never)
    await (await trpc('bob')).issues.dismissAssignment.mutate({ id: task.id } as never)
    expect(await personalSet('bob')).toContain(task.id)
    expect(await stored('bob', task.id)).toMatchObject({ joinedVia: 'start', assignedAt: null })
  })

  it('reassigning away clears the old assignee’s assigned row, not their start', async () => {
    const task = await aliceTask('to bob and back')
    await (await trpc('alice')).issues.update.mutate({
      id: task.id,
      patch: { assignee: bob },
    } as never)
    await (await trpc('bob')).issues.update.mutate({
      id: task.id,
      patch: { assignee: alice },
    } as never)
    expect(await stored('bob', task.id)).toBeUndefined()
    expect(await personalSet('bob')).not.toContain(task.id)
    // Alice keeps her creation start and gets "assigned to you by Bob".
    expect(await stored('alice', task.id)).toMatchObject({ joinedVia: 'start', assignedBy: bob })
  })
})

describe('collaborators are the start and join records, and grant no access', () => {
  it('collaborators come from start and join records only', async () => {
    const task = await aliceTask('collaborated on')
    await bobStartsOn(task.id, 'collaborator')
    expect(await collaborators('alice', task.id)).toEqual([
      expect.objectContaining({ userId: alice, via: 'start' }),
      expect.objectContaining({ userId: bob, via: 'start' }),
    ])
  })

  it('joining grants nothing: no grant row, and Alice’s session on the task stays hers', async () => {
    const grants = async () =>
      await f.handle.registry.sessionStore.grants.listForResource('issue', f.tasks.alice)
    const before = await grants()
    await (await trpc('bob')).issues.join.mutate({ id: f.tasks.alice } as never)
    expect((await collaborators('bob', f.tasks.alice)).map((c) => c.userId)).toContain(bob)

    expect(await grants()).toEqual(before)
    await expect(
      (await trpc('bob')).sessions.status.query({ ref: f.sessions.alice }),
    ).rejects.toThrow(`no session found for ${f.sessions.alice}`)
  })
})
