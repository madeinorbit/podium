import { fixtureWriteScope } from '@podium/sync/testing'
/**
 * EACH MEMBER'S APPS RECEIVE ONLY WHAT THAT MEMBER MAY SEE (POD-6291;
 * docs/design/multi-user-instance.md §3.3 gaps 6 and 10, §4.5; acceptance MU-13).
 *
 * On the two-member fixture (`test-support/two-member-instance.ts`): Alice is
 * the first admin and holds custody of `machine-alice`, where her task's
 * worktree lives; Bob holds `machine-bob`, where his task's worktree lives.
 *
 * - Per-user markers (read, pin, tuck) are each member's own: Bob's feed and
 *   Bob's view of the task's activity never carry Alice's.
 * - A task's events carry the same split as the task: a worktree path to the
 *   custodian of the task's machine, a session to its owner.
 * - Events about the task itself act on every member's marker (a reopen clears
 *   every tuck), and the archive sweep asks the task's assignee, never the
 *   first admin.
 * - Losing custody of a machine takes its tasks' worktree paths out of the
 *   former custodian's connected clients, and deletes nothing.
 */

import { asIssueId, type IssueId, pinRowId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  changedIds,
  MEMBERS,
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

type EventRow = { id: number; kind: string; subject: string; payload: Record<string, unknown> }

const eventsAs = async (
  member: 'alice' | 'bob',
  input: { subject?: string; kinds?: string[] } = {},
): Promise<EventRow[]> =>
  (await (
    await f.as(member)
  ).trpc.issues.events.query({ since: 0, ...input } as never)) as EventRow[]

/** A finished task of `owner`'s, made through the real create and update. */
const finishedTaskOf = async (owner: 'alice' | 'bob', title: string): Promise<IssueId> => {
  const created = (await (
    await f.as(owner)
  ).trpc.issues.create.mutate({
    repoPath: REPO_PATH,
    title,
    startNow: false,
  } as never)) as { id: string }
  await f.handle.registry.issues.crud.update(f.handle.registry.issues.reports.store.serverWriter, created.id, { stage: 'done' })
  return asIssueId(created.id)
}

describe('Bob’s feed and Bob’s view of a task never carry Alice’s per-user markers', () => {
  it('Alice reads, pins and tucks her task: none of it reaches Bob, all of it reaches Alice', async () => {
    const alice = (await f.as('alice')).trpc
    const id = await finishedTaskOf('alice', 'alice marks her own task')
    const bobFeed = await (await f.as('bob')).feed()
    try {
      await alice.issues.markRead.mutate({ id } as never)
      // Alice's pin is her own `pin` record (POD-6692): a generic create.
      const pinned = await (
        alice as unknown as {
          sync: { submit: { mutate(input: unknown): Promise<{ outcome: string }> } }
        }
      ).sync.submit.mutate({
        mutationId: 'alice-pins-her-task',
        command: 'records.pin.create',
        version: 1,
        input: {
          id: pinRowId(MEMBERS.alice.id, 'issue', id),
          fields: { userId: MEMBERS.alice.id, kind: 'issue', entityId: id },
        },
      })
      expect(pinned.outcome).toBe('applied')
      await alice.issues.setTucked.mutate({ id, tucked: true } as never)

      // The task's activity: Bob sees none of Alice's transitions, Alice all of them.
      const markerKinds = ['issue.read', 'issue.unread', 'issue.pinned']
      const bobSees = (await eventsAs('bob', { subject: id })).filter((e) =>
        markerKinds.includes(e.kind),
      )
      expect(bobSees).toEqual([])
      const aliceSees = (await eventsAs('alice', { subject: id })).filter((e) =>
        markerKinds.includes(e.kind),
      )
      expect(aliceSees.map((e) => e.kind).sort()).toEqual(['issue.pinned', 'issue.read'])
      expect(aliceSees.every((e) => e.payload.userId === MEMBERS.alice.id)).toBe(true)
      // Nor through the unfiltered log read.
      expect(
        (await eventsAs('bob', { kinds: markerKinds })).filter(
          (e) => e.payload.userId !== MEMBERS.bob.id,
        ),
      ).toEqual([])

      // Bob's feed: no per-user row of Alice's, in his bootstrap or his deltas.
      const snapshot = await bobFeed.bootstrap()
      for (const row of [
        ...(snapshot.issueUserStates ?? []),
        ...(snapshot.sessionUserStates ?? []),
      ]) {
        expect(row.userId).toBe(MEMBERS.bob.id)
      }
      for (const change of bobFeed.deltas()) {
        if (change.entity === 'issueUserState' || change.entity === 'sessionUserState') {
          expect(change.entityId).not.toContain(MEMBERS.alice.id)
        }
      }
      // And Bob's own view of the task reports his markers, not hers.
      expect(await (await f.as('bob')).trpc.issues.get.query({ id } as never)).toMatchObject({
        tuckedAt: null,
      })
    } finally {
      bobFeed.close()
    }
  })

  it('a reopen clears EVERY member’s tuck, not only the first admin’s', async () => {
    const id = await finishedTaskOf('bob', 'both tuck, alice reopens')
    for (const member of ['alice', 'bob'] as const) {
      await (await f.as(member)).trpc.issues.setTucked.mutate({ id, tucked: true } as never)
    }
    const store = f.handle.registry.sessionStore.issues
    expect((await store.getIssueUserState(MEMBERS.bob.id, id))?.tuckedAt).toBeTruthy()
    await (await f.as('alice')).trpc.issues.update.mutate({
      id,
      patch: { stage: 'in_progress' },
    } as never)
    expect((await store.getIssueUserState(MEMBERS.alice.id, id))?.tuckedAt ?? null).toBeNull()
    expect((await store.getIssueUserState(MEMBERS.bob.id, id))?.tuckedAt ?? null).toBeNull()
  })

  it('the archive sweep asks the task’s assignee: the first admin’s read never archives Bob’s finished task', async () => {
    const id = await finishedTaskOf('bob', 'bob finished, alice read it')
    const issues = f.handle.registry.issues
    const store = f.handle.registry.sessionStore.issues
    // Alice read it after its last activity, ten days before the sweep: on
    // her read alone the task is due. It is Bob's task, so her read decides nothing.
    const readAfterActivity = new Date(Date.now() + 1000).toISOString()
    await store.setIssueUserState(fixtureWriteScope(), MEMBERS.alice.id, id, { readAt: readAfterActivity })
    const later = Date.now() + 10 * 86_400_000
    expect((await issues.attention.sweepAutoArchive(later)).map((w) => w.id)).not.toContain(id)
    expect((await issues.reports.get(id))?.archived).toBe(false)
    // Bob's own read, the same moment, makes it due.
    await store.setIssueUserState(fixtureWriteScope(), MEMBERS.bob.id, id, { readAt: readAfterActivity })
    expect((await issues.attention.sweepAutoArchive(later)).map((w) => w.id)).toContain(id)
  })
})

describe('MU-13: what crosses owners, and what never does', () => {
  it('a dependency between Alice’s and Bob’s tasks is visible to both', async () => {
    const alice = (await f.as('alice')).trpc
    await alice.issues.depAdd.mutate({
      fromId: f.tasks.alice,
      toId: f.tasks.bob,
      type: 'blocked-by',
    } as never)
    for (const member of ['alice', 'bob'] as const) {
      const seen = (await (
        await f.as(member)
      ).trpc.issues.get.query({ id: f.tasks.alice } as never)) as {
        blockedBy?: unknown
      }
      expect(JSON.stringify(seen.blockedBy ?? seen)).toContain(f.tasks.bob)
      const deps = (await (await (await f.as(member)).feed()).bootstrap()).issueDeps ?? []
      expect(deps.some((dep) => JSON.stringify(dep).includes(f.tasks.bob))).toBe(true)
    }
  })

  it('a task event names the worktree only for the machine’s custodian, in the feed and the activity', async () => {
    const aliceFeed = await (await f.as('alice')).feed()
    const bobFeed = await (await f.as('bob')).feed()
    try {
      // As the start path logs it (`workflow.ts`, `issue.started`).
      await f.handle.registry.issues.reports.store.emitEvent('issue.started', f.tasks.alice, {
        seq: 1,
        branch: 'issue/1-alice',
        worktreePath: '/wt/alice-task',
      })
      const started = (feed: typeof bobFeed) =>
        feed
          .deltas()
          .map(
            (c) =>
              c as unknown as {
                entity: string
                op: string
                value: { kind: string; subject: string; payload: Record<string, unknown> }
              },
          )
          .filter((c) => c.entity === 'issueEvent' && c.op === 'upsert')
          .map((c) => c.value)
          .find((e) => e.kind === 'issue.started' && e.subject === f.tasks.alice)
      await aliceFeed.until(() => started(aliceFeed) !== undefined)
      await bobFeed.until(() => started(bobFeed) !== undefined)
      expect(started(aliceFeed)?.payload.worktreePath).toBe('/wt/alice-task')
      expect(started(bobFeed)?.payload).not.toHaveProperty('worktreePath')
      expect(started(bobFeed)?.payload.branch).toBe('issue/1-alice')

      const activity = async (member: 'alice' | 'bob') =>
        (await eventsAs(member, { subject: f.tasks.alice })).find((e) => e.kind === 'issue.started')
      expect((await activity('alice'))?.payload.worktreePath).toBe('/wt/alice-task')
      expect(JSON.stringify(await activity('bob'))).not.toContain('/wt/')
    } finally {
      aliceFeed.close()
      bobFeed.close()
    }
  })

  it('an event about Alice’s session, with its working directory, reaches only Alice', async () => {
    // As the notify service logs a phase change (`session.phase`, with `cwd`).
    await f.handle.registry.sessionStore.events.appendEvent({
      ts: new Date().toISOString(),
      kind: 'session.phase',
      subject: f.sessions.alice,
      payload: { phase: 'idle', cwd: '/wt/alice-session-alice-own', agentKind: 'claude-code' },
    })
    const phases = async (member: 'alice' | 'bob') =>
      (await eventsAs(member, { kinds: ['session.phase'] })).filter(
        (e) => e.subject === f.sessions.alice,
      )
    expect((await phases('alice')).length).toBeGreaterThan(0)
    expect(await phases('bob')).toEqual([])
  })
})

describe('MU-13: artifact entries and the rest of the event log, per member', () => {
  it('a legacy artifact entry’s absolute worktree path reaches only the machine’s custodian', async () => {
    const id = f.tasks.alice
    const store = f.handle.registry.issues.reports.store
    // As a server before artifact snapshots stored it: the file's absolute path.
    const draft = await store.draft(id)
    if (!draft) throw new Error('alice task missing')
    draft.panel = JSON.stringify({
      todos: [],
      deferred: [],
      artifacts: [
        {
          path: '/wt/alice-task/docs/shot.png',
          title: 'shot',
          addedAt: '2026-11-01T00:00:00.000Z',
        },
        { path: '/home/alice/notes/plan.md', addedAt: '2026-11-01T00:00:00.000Z' },
      ],
    })
    const bobFeed = await (await f.as('bob')).feed()
    try {
      await store.persist(store.serverWriter, draft)
      const paths = (value: unknown) =>
        ((value as { panel?: { artifacts?: Array<{ path: string }> } }).panel?.artifacts ?? []).map(
          (artifact) => artifact.path,
        )
      const get = async (member: 'alice' | 'bob') =>
        await (await f.as(member)).trpc.issues.get.query({ id } as never)
      expect(paths(await get('alice'))).toEqual([
        '/wt/alice-task/docs/shot.png',
        '/home/alice/notes/plan.md',
      ])
      expect(paths(await get('bob'))).toEqual(['docs/shot.png', 'plan.md'])
      // The feed: Bob's bootstrap and the delta the write pushed.
      expect(
        paths((await bobFeed.bootstrap()).issueProjections?.find((issue) => issue.id === id)),
      ).toEqual(['docs/shot.png', 'plan.md'])
      await bobFeed.until(() => changedIds(bobFeed.deltas(), 'issueProjection').includes(id))
      for (const change of bobFeed.deltas()) {
        if (change.entity === 'issueProjection' && change.entityId === id) {
          expect(JSON.stringify((change as { value?: unknown }).value)).not.toMatch(
            /\/wt\/|\/home\//,
          )
        }
      }
    } finally {
      bobFeed.close()
    }
  })

  it('an event about a message reaches only those the mail read rule gives that message', async () => {
    // Alice, signed in, writes to her own agent.
    const sent = await (await f.as('alice')).trpc.messages.send.mutate({
      to: f.sessions.alice,
      body: 'alice to her own agent',
    } as never)
    const messageId = /msg_[0-9a-f-]+/.exec(JSON.stringify(sent))?.[0]
    if (!messageId) throw new Error(`no message id in ${JSON.stringify(sent)}`)
    // As the maintenance sweep logs an expiry (`message.expired`, subject: the message).
    await f.handle.registry.sessionStore.events.appendEvent({
      ts: new Date().toISOString(),
      kind: 'message.expired',
      subject: messageId,
      payload: { toKind: 'session', toId: f.sessions.alice },
    })
    const expired = async (member: 'alice' | 'bob') =>
      (await eventsAs(member, { kinds: ['message.expired'] })).filter(
        (e) => e.subject === messageId,
      )
    expect((await expired('alice')).length).toBe(1)
    expect(await expired('bob')).toEqual([])
  })

  it('a lock event reaches the owners of the sessions it names, each seeing only their own', async () => {
    // As the lock service logs a steal (`lock.stolen`): Bob's agent took
    // Alice's agent's lock.
    await f.handle.registry.sessionStore.events.appendEvent({
      ts: new Date().toISOString(),
      kind: 'lock.stolen',
      subject: 'repo:merge:main',
      payload: {
        previousHolder: {
          sessionId: f.sessions.alice,
          issueId: f.tasks.alice,
          label: `session:${f.sessions.alice}`,
        },
        newHolder: `session:${f.sessions.bob}`,
      },
    })
    // And a lock only Alice's agent ever held.
    await f.handle.registry.sessionStore.events.appendEvent({
      ts: new Date().toISOString(),
      kind: 'lock.stolen',
      subject: 'repo:alice-only',
      payload: {
        previousHolder: {
          sessionId: f.sessions.alice,
          issueId: null,
          label: `session:${f.sessions.alice}`,
        },
        newHolder: 'operator',
      },
    })
    const locks = async (member: 'alice' | 'bob') =>
      await eventsAs(member, { kinds: ['lock.stolen'] })
    const alice = await locks('alice')
    const bob = await locks('bob')
    expect(alice.map((e) => e.subject).sort()).toEqual(['repo:alice-only', 'repo:merge:main'])
    expect(bob.map((e) => e.subject)).toEqual(['repo:merge:main'])
    expect(JSON.stringify(bob)).not.toContain(f.sessions.alice)
    expect(JSON.stringify(alice)).not.toContain(f.sessions.bob)
    expect(JSON.stringify(alice)).toContain(f.sessions.alice)
  })
})

describe('losing custody evicts the private fields from connected clients, deleting nothing', () => {
  it('Alice takes custody of Bob’s machine: Bob’s open feed loses his task’s worktree, Alice’s gains it', async () => {
    const id = f.tasks.bob
    const projection = (changes: ReturnType<Awaited<ReturnType<MemberFeed>>['deltas']>) =>
      changes
        .filter((c) => c.entity === 'issueProjection' && c.entityId === id && c.op === 'upsert')
        .map((c) => (c as { value: Record<string, unknown> }).value)
        .at(-1)
    const bobFeed = await (await f.as('bob')).feed()
    const aliceFeed = await (await f.as('alice')).feed()
    try {
      const bobBefore = (await bobFeed.bootstrap()).issueProjections?.find(
        (issue) => issue.id === id,
      )
      expect(bobBefore).toMatchObject({ worktreePath: '/wt/bob-task', machineId: f.machines.bob })
      const aliceBefore = (await aliceFeed.bootstrap()).issueProjections?.find(
        (issue) => issue.id === id,
      )
      expect(aliceBefore).not.toHaveProperty('worktreePath')

      // The admin takeover (`machines.transferOwnership` as an admin).
      await f.handle.registry.modules.machines.transferMachineOwnership(
        f.machines.bob,
        MEMBERS.alice.id,
        MEMBERS.alice.id,
      )

      await bobFeed.until(() => changedIds(bobFeed.deltas(), 'issueProjection').includes(id))
      await aliceFeed.until(() => changedIds(aliceFeed.deltas(), 'issueProjection').includes(id))
      const bobNow = projection(bobFeed.deltas())
      expect(bobNow).toMatchObject({ id, title: "bob's task" })
      expect(bobNow).not.toHaveProperty('worktreePath')
      expect(bobNow).not.toHaveProperty('machineId')
      expect(projection(aliceFeed.deltas())).toMatchObject({ worktreePath: '/wt/bob-task' })
      // Nothing was deleted: the task still has its worktree.
      const row = await f.handle.registry.sessionStore.issues.getIssue(id)
      expect(row?.worktreePath).toBe('/wt/bob-task')
      // And Bob's next bootstrap agrees with what his open client now holds.
      expect(
        (await bobFeed.bootstrap()).issueProjections?.find((issue) => issue.id === id),
      ).not.toHaveProperty('worktreePath')
    } finally {
      bobFeed.close()
      aliceFeed.close()
    }
  })
})

type MemberFeed = Awaited<ReturnType<TwoMemberInstance['as']>>['feed']
