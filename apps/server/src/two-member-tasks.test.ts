/**
 * SHARED AND PRIVATE TASK DATA (POD-6288; docs/design/multi-user-instance.md
 * §2.2, §4.1, §4.2; acceptance MU-05 and MU-06).
 *
 * Every member reads and edits every task, through the real transports and with
 * their own login. What a task points at in someone's private work (the
 * worktree on their machine, the sessions that coordinate or started it) goes
 * only to that person; everyone else gets the D13 summary of its sessions.
 *
 * The fixture's task `f.tasks.alice` is homed in a worktree on Alice's machine,
 * with Alice's session and Bob's session on it. `started` below is an extra task
 * of Alice's that one of her sessions started and coordinates.
 */

import { asIssueId, type IssueId, pinRowId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TASKS_VISIBLE_TO_ALL_MEMBERS } from './modules/issues/registry'
import {
  changedIds,
  MEMBERS,
  REPO_PATH,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

/** One person's pins by kind, read the way the boot reconcile reads them. */
async function pinsOf(
  repo: { allPinsForBootReconcile(): Promise<{ userId: string; kind: string; entityId: string }[]> },
  userId: string,
): Promise<{ panels: string[]; worktrees: string[]; repos: string[] }> {
  const pins = (await repo.allPinsForBootReconcile()).filter((p) => p.userId === userId)
  const of = (kind: string) => pins.filter((p) => p.kind === kind).map((p) => p.entityId)
  return { panels: of('panel'), worktrees: of('worktree'), repos: of('repo') }
}

/** One person's tab orders by worktree, read the way the boot reconcile reads them. */
async function tabOrdersOf(
  repo: {
    allTabOrdersForBootReconcile(): Promise<{ userId: string; entityId: string; sessionIds: string[] }[]>
  },
  userId: string,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  for (const o of await repo.allTabOrdersForBootReconcile()) {
    if (o.userId === userId) out[o.entityId] = o.sessionIds
  }
  return out
}

let f: TwoMemberInstance
let started: IssueId

const PRIVATE_KEYS = ['machineId', 'coordinatorSessionId', 'startedBySession'] as const

beforeAll(async () => {
  f = await startTwoMemberInstance()
  const crud = f.handle.registry.issues.crud
  // A task of Alice's that her session started and coordinates, homed in a
  // worktree on her machine: every execution-private field is set.
  started = asIssueId(
    (
      await crud.create(f.handle.registry.issues.reports.store.serverWriter, {
        repoPath: REPO_PATH,
        title: 'alice started task',
        startNow: false,
        ownerUserId: MEMBERS.alice.id,
        startedBySession: f.sessions.alice,
      })
    ).id,
  )
  await crud.update(f.handle.registry.issues.reports.store.serverWriter, started, {
    worktreePath: '/wt/alice-started',
    machineId: f.machines.alice,
    coordinatorSessionId: f.sessions.alice,
  })
}, 60_000)
afterAll(async () => {
  await f?.close()
})

/** Every object in `value` that is the task `id` (a report, a projection, a node). */
function copiesOf(value: unknown, id: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const walk = (item: unknown): void => {
    if (!item || typeof item !== 'object') return
    if (Array.isArray(item)) {
      for (const child of item) walk(child)
      return
    }
    const row = item as Record<string, unknown>
    if (row.id === id) out.push(row)
    for (const child of Object.values(row)) walk(child)
  }
  walk(value)
  return out
}

/** No copy of the task carries a pointer into Alice's private work. */
function expectNoPrivateFields(value: unknown, id: string): void {
  const copies = copiesOf(value, id)
  expect(copies.length, `no copy of ${id} found`).toBeGreaterThan(0)
  for (const copy of copies) {
    for (const key of PRIVATE_KEYS) expect(copy, key).not.toHaveProperty(key)
    expect(copy.worktreePath ?? null).toBeNull()
    expect(copy.humanQuestionAskedBy ?? null).toBeNull()
  }
}

describe('MU-05: every member reads and edits every task, without a grant', () => {
  it('Bob reads Alice’s task and edits it, its panel and its comments over tRPC', async () => {
    const bob = (await f.as('bob')).trpc
    const id = f.tasks.alice
    expect(await bob.issues.get.query({ id } as never)).toMatchObject({ title: "alice's task" })
    await bob.issues.update.mutate({ id, patch: { description: 'bob was here' } } as never)
    await bob.issues.addComment.mutate({ id, body: 'a comment from bob' } as never)
    await bob.issues.panelApply.mutate({ id, op: 'todo-add', text: 'bob’s todo' } as never)
    const seen = (await (await f.as('alice')).trpc.issues.get.query({ id } as never)) as {
      description: string
    }
    expect(seen.description).toBe('bob was here')
    const comments = (await bob.issues.comments.query({ id } as never)) as Array<{ body: string }>
    expect(comments.map((c) => c.body)).toContain('a comment from bob')
  })

  it('Bob reaches Alice’s task artifacts: the read answers about her task, not “unknown issue”', async () => {
    const read = async (name: 'alice' | 'bob') =>
      await (await f.as(name)).trpc.issues.artifactRead
        .query({ id: f.tasks.alice, index: 1 } as never)
        .catch((error: unknown) => String(error))
    const bob = await read('bob')
    expect(bob).toMatch(/no artifacts/)
    expect(bob).toBe(await read('alice'))
  })

  it('Carol (disabled) cannot sign in, and a caller with no login reaches no task', async () => {
    expect((await f.login('carol')).ok).toBe(false)
    const anonymous = await fetch(
      `${f.origin}/trpc/issues.get?input=${encodeURIComponent(JSON.stringify({ id: f.tasks.alice }))}`,
    )
    expect(anonymous.ok).toBe(false)
  })

  it('lifecycle commands keep their contracts: Bob, a plain member, cannot delete Alice’s task', async () => {
    const bob = (await f.as('bob')).trpc
    await expect(bob.issues.delete.mutate({ id: f.tasks.alice } as never)).rejects.toThrow(
      /not allowed/,
    )
    expect(await f.handle.registry.issues.reports.get(f.tasks.alice)).not.toBeNull()
  })

  it('issues.share and issues.unshare write no grant and say tasks are visible to all members', async () => {
    const bob = (await f.as('bob')).trpc
    const store = f.handle.registry.sessionStore
    const before = await store.grants.loadForResource('issue', f.tasks.bob)
    for (const proc of ['share', 'unshare'] as const) {
      await expect(
        bob.issues[proc].mutate({
          id: f.tasks.bob,
          grantee: MEMBERS.alice.id,
          verb: 'write',
        } as never),
      ).rejects.toThrow(TASKS_VISIBLE_TO_ALL_MEMBERS)
    }
    expect(await store.grants.loadForResource('issue', f.tasks.bob)).toEqual(before)
  })
})

describe('MU-05: Bob’s agent writes its own subtree freely and other tasks only with --outside-scope', () => {
  it('edits its own task, needs --outside-scope for Alice’s, and gains nothing on her session', async () => {
    const agent = f.agent(f.sessions.bob).client
    await agent.issues.update.mutate({ id: f.tasks.bob, patch: { description: 'agent edit' } })
    await expect(
      agent.issues.update.mutate({ id: f.tasks.alice, patch: { description: 'agent outside' } }),
    ).rejects.toThrow(/outside-scope|outside your/i)
    await f
      .agent(f.sessions.bob, { outsideScope: true })
      .client.issues.update.mutate({ id: f.tasks.alice, patch: { description: 'agent outside' } })
    expect((await f.handle.registry.issues.reports.get(f.tasks.alice))?.description).toBe(
      'agent outside',
    )
    // Alice's session is hers alone (design §2.3), --outside-scope or not:
    // re-homing it onto Bob's task leaves it where it was.
    const sessions = f.handle.registry.sessionStore.sessions
    const home = async () =>
      (await sessions.getSessions([f.sessions.alice])).get(f.sessions.alice)?.issueId
    const before = await home()
    await f
      .agent(f.sessions.bob, { outsideScope: true })
      .client.issues.attachSession.mutate({ sessionId: f.sessions.alice, targetId: f.tasks.bob })
      .catch(() => undefined)
    expect(await home()).toBe(before)
  })
})

describe('MU-06: no path carries Alice’s execution-private task fields to Bob', () => {
  it('issues.get: Alice receives her pointers, Bob only the D13 summary', async () => {
    const alice = (await (
      await f.as('alice')
    ).trpc.issues.get.query({ id: started } as never)) as Record<string, unknown>
    expect(alice).toMatchObject({
      worktreePath: '/wt/alice-started',
      machineId: f.machines.alice,
      coordinatorSessionId: f.sessions.alice,
      startedBySession: f.sessions.alice,
    })
    const bob = await (await f.as('bob')).trpc.issues.get.query({ id: started } as never)
    expectNoPrivateFields(bob, started)
  })

  it('D13: each member gets owner, title and live/idle for every session on the task, and only their own sessions in full', async () => {
    const summaryOf = async (name: 'alice' | 'bob') =>
      (await (await f.as(name)).trpc.issues.get.query({ id: f.tasks.alice } as never)) as {
        sessions: Array<{ sessionId: string }>
        sessionSummaries: Array<{ owner: string | null; title: string; state: string }>
      }
    const bob = await summaryOf('bob')
    expect(bob.sessions.map((s) => s.sessionId)).toEqual([f.sessions.bobOnAliceTask])
    expect(bob.sessionSummaries.map((s) => s.owner).sort()).toEqual(
      [MEMBERS.alice.id, MEMBERS.bob.id].sort(),
    )
    for (const summary of bob.sessionSummaries) {
      expect(Object.keys(summary).sort()).toEqual(['owner', 'state', 'title'])
      expect(['live', 'idle']).toContain(summary.state)
      expect(summary.title).not.toBe('')
    }
    expect((await summaryOf('alice')).sessionSummaries).toEqual(bob.sessionSummaries)
  })

  it('listings, search, tree, graph and counts: Bob sees the task without its pointers', async () => {
    const bob = (await f.as('bob')).trpc
    const alice = (await f.as('alice')).trpc
    expectNoPrivateFields(await bob.issues.list.query({ repoPath: REPO_PATH } as never), started)
    expectNoPrivateFields(
      await bob.issues.search.query({ text: 'alice started task' } as never),
      started,
    )
    expectNoPrivateFields(await bob.issues.graph.query({ repoPath: REPO_PATH } as never), started)
    // A child of the started task carries the parent into the tree and children reads.
    const child = await alice.issues.create.mutate({
      repoPath: REPO_PATH,
      title: 'child of the started task',
      parentId: started,
      startNow: false,
    } as never)
    expect(
      copiesOf(
        await bob.issues.children.query({ id: started } as never),
        (child as { id: string }).id,
      ).length,
    ).toBe(1)
    expectNoPrivateFields(await bob.issues.tree.query({ id: started } as never), started)
    // Counts hold every task for every member.
    expect(await bob.issues.count.query({ repoPath: REPO_PATH } as never)).toEqual(
      await alice.issues.count.query({ repoPath: REPO_PATH } as never),
    )
  })

  it('the feed: Bob’s bootstrap and deltas carry the task without its pointers', async () => {
    const aliceFeed = await (await f.as('alice')).feed()
    const bobFeed = await (await f.as('bob')).feed()
    try {
      const projection = (snapshot: Awaited<ReturnType<typeof bobFeed.bootstrap>>) =>
        (snapshot.issueProjections ?? []).find((issue) => issue.id === started)
      expect(projection(await aliceFeed.bootstrap())).toMatchObject({
        worktreePath: '/wt/alice-started',
        machineId: f.machines.alice,
        coordinatorSessionId: f.sessions.alice,
        startedBySession: f.sessions.alice,
      })
      expectNoPrivateFields(projection(await bobFeed.bootstrap()), started)

      await (await f.as('alice')).trpc.issues.update.mutate({
        id: started,
        patch: { title: 'alice started task, renamed' },
      } as never)
      await bobFeed.until(() => changedIds(bobFeed.deltas(), 'issueProjection').includes(started))
      const pushed = bobFeed
        .deltas()
        .filter((change) => change.entity === 'issueProjection' && change.entityId === started)
      expect(pushed.length).toBeGreaterThan(0)
      for (const change of pushed) {
        expectNoPrivateFields((change as { value?: unknown }).value, started)
      }
    } finally {
      aliceFeed.close()
      bobFeed.close()
    }
  })
})

describe('Self: per-user markers are each member’s own, on any task', () => {
  it('Bob marks read and tucks his own and Alice’s tasks; Alice’s markers do not move', async () => {
    const bob = (await f.as('bob')).trpc
    const store = f.handle.registry.sessionStore.issues
    const finished = asIssueId(
      (
        (await (
          await f.as('alice')
        ).trpc.issues.create.mutate({
          repoPath: REPO_PATH,
          title: 'alice finished task',
          startNow: false,
        } as never)) as { id: string }
      ).id,
    )
    await f.handle.registry.issues.crud.update(f.handle.registry.issues.reports.store.serverWriter, finished, { stage: 'done' })
    const aliceBefore = await store.getIssueUserState(MEMBERS.alice.id, finished)
    for (const id of [f.tasks.bob, finished]) {
      await bob.issues.markRead.mutate({ id } as never)
    }
    const tucked = (await bob.issues.setTucked.mutate({ id: finished, tucked: true } as never)) as {
      tuckedAt?: string | null
    }
    const mine = await store.getIssueUserState(MEMBERS.bob.id, finished)
    expect(mine?.readAt).toBeTruthy()
    expect(mine?.tuckedAt).toBeTruthy()
    // The mutation's own answer carries Bob's markers, not the broadcast viewer's.
    expect(tucked.tuckedAt).toBe(mine?.tuckedAt)
    expect((await store.getIssueUserState(MEMBERS.bob.id, f.tasks.bob))?.readAt).toBeTruthy()
    expect(await store.getIssueUserState(MEMBERS.alice.id, finished)).toEqual(aliceBefore)
    // Bob's reads of the task report his own markers.
    expect(await bob.issues.get.query({ id: finished } as never)).toMatchObject({
      readAt: mine?.readAt,
      tuckedAt: mine?.tuckedAt,
    })
  })

  it('Bob snoozes and pins his session over tRPC; the rows are his', async () => {
    const bob = (await f.as('bob')).trpc as unknown as {
      snoozes: { set: { mutate(input: unknown): Promise<unknown> } }
      sync: { submit: { mutate(input: unknown): Promise<{ outcome: string }> } }
    }
    await bob.snoozes.set.mutate({ sessionId: f.sessions.bob, until: null })
    // A pin is Bob's own synced record (POD-6673): a generic create.
    const pinned = await bob.sync.submit.mutate({
      mutationId: 'bob-pin',
      command: 'records.pin.create',
      version: 1,
      input: {
        id: pinRowId(MEMBERS.bob.id, 'panel', f.sessions.bob),
        fields: { userId: MEMBERS.bob.id, kind: 'panel', entityId: f.sessions.bob },
      },
    })
    expect(pinned.outcome).toBe('applied')
    const sessions = f.handle.registry.sessionStore.sessions
    expect(Object.keys(await sessions.listSnoozes(MEMBERS.bob.id))).toContain(f.sessions.bob)
    expect((await pinsOf(sessions, MEMBERS.bob.id)).panels).toContain(f.sessions.bob)
    expect(Object.keys(await sessions.listSnoozes(MEMBERS.alice.id))).not.toContain(f.sessions.bob)
    expect((await pinsOf(sessions, MEMBERS.alice.id)).panels).not.toContain(f.sessions.bob)
  })

  it('task defer is a shared edit: Bob defers Alice’s task and Alice sees it', async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString()
    await (await f.as('bob')).trpc.issues.defer.mutate({ id: f.tasks.alice, until } as never)
    const seen = (await (
      await f.as('alice')
    ).trpc.issues.get.query({ id: f.tasks.alice } as never)) as {
      deferUntil?: string | null
    }
    expect(seen.deferUntil).toBe(until)
    await (await f.as('bob')).trpc.issues.defer.mutate({ id: f.tasks.alice, until: null } as never)
  })
})
