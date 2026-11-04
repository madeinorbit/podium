/**
 * ONE ACCOUNTABLE ASSIGNEE (POD-6287; docs/design/multi-user-instance.md §2.2,
 * §2.3, §4.3; acceptance MU-24, MU-17 claims half, MU-30).
 *
 * A task's assignee is its owner: one human. Any active member reassigns it to
 * any active member, under the task's revision, with an attributed event and a
 * notice in both people's inboxes. Agents never change it. Stopping, closing or
 * deleting a task ends only the caller's own sessions on it, and a reassignment
 * moves no session, credential, approval or spending.
 *
 * Every test makes its own task (Alice's, through her own login) so the shared
 * fixture rows stay as the other two-member files expect them.
 */

import { asIssueId, type SessionId, type UserId } from '@podium/model'
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
  seq: number
  revision: number
  assignee?: string
  legacyAssignee?: string
  stage: string
}

const trpc = async (name: MemberName) => (await f.as(name)).trpc

/** A fresh task of Alice's, created through her own login. */
async function aliceTask(title: string): Promise<Wire> {
  return (await (
    await trpc('alice')
  ).issues.create.mutate({
    repoPath: REPO_PATH,
    title,
    startNow: false,
  } as never)) as Wire
}

const read = async (id: string): Promise<Wire> =>
  (await (await trpc('alice')).issues.get.query({ id } as never)) as Wire

const reassignedEvents = async (id: string) =>
  await f.handle.registry.sessionStore.events.listEventsSince(0, {
    kinds: ['issue.reassigned'],
    subject: id,
  })

const inbox = async (name: MemberName): Promise<string[]> =>
  ((await (await trpc(name)).messages.inbox.mutate({})) as Array<{ body: string }>).map(
    (m) => m.body,
  )

/** A session of `owner` on `issueId`, started the way the fixture starts its own. */
async function sessionOn(
  owner: 'alice' | 'bob',
  issueId: string,
  title: string,
): Promise<SessionId> {
  return (
    await f.handle.registry.modules.sessions.createSession({
      ownerUserId: MEMBERS[owner].id,
      agentKind: 'claude-code',
      cwd: `/wt/${owner}-${title}`,
      title,
      machineId: f.machines[owner],
      issueId: asIssueId(issueId),
      binding: { principal: { kind: 'user', userId: MEMBERS[owner].id } },
    })
  ).sessionId
}

const statusOf = async (sessionId: SessionId) =>
  (await f.handle.registry.sessionStore.sessions.getSession(sessionId))?.status

const deletedAt = async (sessionId: SessionId) =>
  (await f.handle.registry.sessionStore.sessions.getSession(sessionId))?.deletedAt ?? null

/** Control frames to Bob's machine that name `sessionId`. */
const framesFor = (sessionId: SessionId) =>
  f.daemonFrames(f.machines.bob).filter((frame) => JSON.stringify(frame).includes(sessionId))

describe('MU-24: any active member reassigns; both people are told; agents cannot', () => {
  it('Bob reassigns Alice’s task to himself: owner moves, event attributed, both inboxes told, creator kept', async () => {
    const task = await aliceTask('reassign me to bob')
    expect(task.assignee).toBe(alice)

    const moved = (await (
      await trpc('bob')
    ).issues.update.mutate({
      id: task.id,
      patch: { assignee: 'me' },
    } as never)) as Wire
    expect(moved.assignee).toBe(bob)
    // The creator is recorded separately and never changes.
    const row = await f.handle.registry.sessionStore.issues.getIssue(task.id)
    expect(row).toMatchObject({
      ownerUserId: bob,
      createdByActor: alice,
      createdByOnBehalfOf: alice,
    })

    const events = await reassignedEvents(task.id)
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ from: alice, to: bob, by: bob })

    expect(
      (await inbox('alice')).some((b) => b.includes(`#${task.seq}`) && b.includes('from you')),
    ).toBe(true)
    expect(
      (await inbox('bob')).some(
        (b) => b.includes(`#${task.seq}`) && b.includes('assigned yourself'),
      ),
    ).toBe(true)
  })

  it('Alice reassigns her task to Bob by id; a disabled member or a non-member is refused', async () => {
    const task = await aliceTask('reassign to bob by id')
    const alices = await trpc('alice')
    await expect(
      alices.issues.update.mutate({ id: task.id, patch: { assignee: MEMBERS.carol.id } } as never),
    ).rejects.toThrow(/active member/)
    await expect(
      alices.issues.update.mutate({ id: task.id, patch: { assignee: 'agent:codex' } } as never),
    ).rejects.toThrow(/active member/)
    expect((await read(task.id)).assignee).toBe(alice)

    await alices.issues.update.mutate({ id: task.id, patch: { assignee: bob } } as never)
    expect((await read(task.id)).assignee).toBe(bob)
    expect(
      (await inbox('bob')).some((b) => b.includes(`#${task.seq}`) && b.includes('assigned you')),
    ).toBe(true)
  })

  it('an agent cannot reassign a human, and its claim leaves the assignee alone', async () => {
    const task = await aliceTask('agents never reassign')
    // Bob's agent, on Alice's task (its scope), naming Bob, and naming its own human `me`.
    const agent = f.agent(f.sessions.bobOnAliceTask, { outsideScope: true })
    await expect(
      agent.client.issues.update.mutate({ id: task.id, patch: { assignee: bob } } as never),
    ).rejects.toThrow(/agent cannot change a task's assignee/)
    await expect(
      agent.client.issues.update.mutate({ id: task.id, patch: { assignee: 'me' } } as never),
    ).rejects.toThrow(/agent cannot change a task's assignee/)

    // `claim --assignee me` is every agent's habit: it starts the work only.
    const claimed = (await agent.client.issues.claim.mutate({
      id: task.id,
      assignee: 'me',
    } as never)) as Wire
    expect(claimed.stage).toBe('in_progress')
    expect(claimed.assignee).toBe(alice)
    expect(await reassignedEvents(task.id)).toHaveLength(0)
  })

  it('a person’s claim makes them the assignee; `--assignee me` in search is the caller', async () => {
    const task = await aliceTask('bob claims it')
    const claimed = (await (
      await trpc('bob')
    ).issues.claim.mutate({ id: task.id } as never)) as Wire
    expect(claimed).toMatchObject({ stage: 'in_progress', assignee: bob })
    const found = (await (
      await trpc('bob')
    ).issues.search.query({
      repoPath: REPO_PATH,
      assignee: 'me',
    } as never)) as Wire[]
    expect(found.map((i) => i.id)).toContain(task.id)
    const alices = (await (
      await trpc('alice')
    ).issues.search.query({
      repoPath: REPO_PATH,
      assignee: 'me',
    } as never)) as Wire[]
    expect(alices.map((i) => i.id)).not.toContain(task.id)
  })

  it('stopping or closing a task stops only the caller’s sessions; Bob’s keep running', async () => {
    const stopTask = await aliceTask('alice stops her task')
    const alicesOnStop = await sessionOn('alice', stopTask.id, 'stop-a')
    const bobsOnStop = await sessionOn('bob', stopTask.id, 'stop-b')
    const before = await statusOf(bobsOnStop)

    const stopped = (await (
      await trpc('alice')
    ).issues.stop.mutate({
      id: stopTask.id,
      force: true,
    } as never)) as { stopped: string[] }
    expect(stopped.stopped).toContain(alicesOnStop)
    expect(stopped.stopped).not.toContain(bobsOnStop)
    expect(await statusOf(bobsOnStop)).toBe(before)
    expect(framesFor(bobsOnStop).filter((frame) => frame.type === 'kill')).toEqual([])

    const closeTask = await aliceTask('alice closes her task')
    const bobsOnClose = await sessionOn('bob', closeTask.id, 'close-b')
    const beforeClose = await statusOf(bobsOnClose)
    await (await trpc('alice')).issues.close.mutate({ id: closeTask.id } as never)
    // The close's stop runs after the commit; give it time to have run.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await statusOf(bobsOnClose)).toBe(beforeClose)
    expect(framesFor(bobsOnClose).filter((frame) => frame.type === 'kill')).toEqual([])
    // The row records who closed it, for the closed-task sweep.
    const row = await f.handle.registry.sessionStore.issues.getIssue(closeTask.id)
    expect(row?.closedByUserId).toBe(alice)
  })

  it('deleting a task ends only the deleter’s sessions on it', async () => {
    const task = await aliceTask('alice deletes her task')
    const alices = await sessionOn('alice', task.id, 'delete-a')
    const bobs = await sessionOn('bob', task.id, 'delete-b')
    const result = (await (await trpc('alice')).issues.delete.mutate({ id: task.id } as never)) as {
      deletedSessionIds: string[]
    }
    expect(result.deletedSessionIds).toEqual([alices])
    expect(await deletedAt(alices)).not.toBeNull()
    expect(await deletedAt(bobs)).toBeNull()
  })
})

describe('MU-17 (claims): concurrent reassignments resolve by revision, no receipt crosses members', () => {
  it('two reassignments cut from one revision: one applies, the other is refused', async () => {
    const task = await aliceTask('race for it')
    const { revision } = await read(task.id)
    const results = await Promise.allSettled([
      (await trpc('alice')).issues.update.mutate({
        id: task.id,
        patch: { assignee: bob },
        expectedRevision: revision,
      } as never),
      (await trpc('bob')).issues.claim.mutate({
        id: task.id,
        expectedRevision: revision,
      } as never),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(refused.reason)).toMatch(/revision/)
    const events = await reassignedEvents(task.id)
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ from: alice, to: bob })
    expect(['alice', 'bob'].map((n) => MEMBERS[n as MemberName].id)).toContain(
      (events[0]?.payload as { by: UserId }).by,
    )
  })

  it('Bob reusing Alice’s mutation id gets his own reassignment, not her receipt', async () => {
    const task = await aliceTask('shared mutation id')
    const mutationId = `mut_${task.id}`
    const hers = (await (
      await trpc('alice')
    ).issues.update.mutate({
      id: task.id,
      patch: { assignee: bob },
      mutationId,
    } as never)) as Wire
    expect(hers.assignee).toBe(bob)
    // Her own retry replays her receipt: nothing is applied twice.
    await (await trpc('alice')).issues.update.mutate({
      id: task.id,
      patch: { assignee: bob },
      mutationId,
    } as never)
    expect(await reassignedEvents(task.id)).toHaveLength(1)

    const his = (await (
      await trpc('bob')
    ).issues.update.mutate({
      id: task.id,
      patch: { assignee: alice },
      mutationId,
    } as never)) as Wire
    expect(his.assignee).toBe(alice)
    expect((await read(task.id)).assignee).toBe(alice)
    const events = await reassignedEvents(task.id)
    expect(events.map((e) => (e.payload as { by: string }).by)).toEqual([alice, bob])
  })
})

describe('MU-30: a reassignment leaves existing work where it is', () => {
  it('Alice’s session on a task reassigned to Bob stays Alice’s, and Bob gets no access to it', async () => {
    const task = await aliceTask('work stays with alice')
    const hers = await sessionOn('alice', task.id, 'mu30')
    const before = await f.handle.registry.sessionStore.sessions.getSession(hers)
    await (await trpc('alice')).issues.update.mutate({
      id: task.id,
      patch: { assignee: bob },
    } as never)
    expect((await read(task.id)).assignee).toBe(bob)

    const after = await f.handle.registry.sessionStore.sessions.getSession(hers)
    expect(after?.ownerUserId).toBe(alice)
    expect(after?.delegation).toEqual(before?.delegation)
    expect(after?.createdByOnBehalfOf ?? null).toBe(before?.createdByOnBehalfOf ?? null)

    // The new assignee cannot read or drive it.
    const bobs = await trpc('bob')
    await expect(bobs.sessions.status.query({ ref: hers })).rejects.toThrow(
      `no session found for ${hers}`,
    )
    await expect(
      bobs.sessions.rename.mutate({ sessionId: hers, name: 'bob drives it' } as never),
    ).rejects.toThrow()
    // It is still Alice's to drive: the session owner the authorization reads.
    expect((await f.handle.registry.modules.sessions.sessionOwner(hers))?.owner).toBe(alice)
  })
})

describe('one-member behaviour and legacy labels', () => {
  it('a new task is assigned to its creating human; an agent’s task to the agent’s human', async () => {
    const task = await aliceTask('mine by default')
    expect(task.assignee).toBe(alice)
    const agent = f.agent(f.sessions.bob)
    const child = (await agent.client.issues.create.mutate({
      repoPath: REPO_PATH,
      title: 'bob’s agent files a child',
      startNow: false,
      parentId: f.tasks.bob,
    } as never)) as Wire
    expect(child.assignee).toBe(bob)
    expect(child.legacyAssignee).toBeUndefined()
  })

  it('an old free-text label is shown as the legacy label and makes nobody accountable', async () => {
    const task = await aliceTask('legacy label')
    const row = await f.handle.registry.sessionStore.issues.getIssue(task.id)
    if (!row) throw new Error('missing row')
    // What an earlier release left behind: an agent tag in the old column.
    await f.handle.registry.sessionStore.issues.upsertIssue(
      { ...row, assignee: 'agent:codex' },
      { expectedRevision: row.revision ?? null },
    )
    expect(await read(task.id)).toMatchObject({
      assignee: alice,
      legacyAssignee: 'agent:codex',
    })
  })
})
