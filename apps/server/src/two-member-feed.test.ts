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

import { asIssueId, type IssueId } from '@podium/model'
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
  await f.handle.registry.issues.crud.update(created.id, { stage: 'done' })
  return asIssueId(created.id)
}

describe('Bob’s feed and Bob’s view of a task never carry Alice’s per-user markers', () => {
  it('Alice reads, pins and tucks her task: none of it reaches Bob, all of it reaches Alice', async () => {
    const alice = (await f.as('alice')).trpc
    const id = await finishedTaskOf('alice', 'alice marks her own task')
    const bobFeed = await (await f.as('bob')).feed()
    try {
      await alice.issues.markRead.mutate({ id } as never)
      await alice.issues.update.mutate({ id, patch: { pinned: true } } as never)
      await alice.issues.setTucked.mutate({ id, tucked: true } as never)

      // The task's activity: Alice sees her own transitions, Bob sees none.
      const markerKinds = ['issue.read', 'issue.unread', 'issue.pinned']
      const aliceSees = (await eventsAs('alice', { subject: id })).filter((e) =>
        markerKinds.includes(e.kind),
      )
      expect(aliceSees.map((e) => e.kind).sort()).toEqual(['issue.pinned', 'issue.read'])
      expect(aliceSees.every((e) => e.payload.userId === MEMBERS.alice.id)).toBe(true)
      const bobSees = (await eventsAs('bob', { subject: id })).filter((e) =>
        markerKinds.includes(e.kind),
      )
      expect(bobSees).toEqual([])
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
        pinned: false,
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
    const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
    await store.setIssueUserState(MEMBERS.alice.id, id, { readAt: longAgo })
    // Activity happened before the read, so only whose read it is decides.
    const later = Date.now() + 10 * 86_400_000
    expect((await issues.attention.sweepAutoArchive(later)).map((w) => w.id)).not.toContain(id)
    expect((await issues.reports.get(id))?.archived).toBe(false)
    await store.setIssueUserState(MEMBERS.bob.id, id, {
      readAt: new Date(Date.now() + 1000).toISOString(),
    })
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
          .filter((c) => c.entity === 'issueEvent' && c.op === 'upsert')
          .map(
            (c) =>
              (c as { value: { kind: string; subject: string; payload: Record<string, unknown> } })
                .value,
          )
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
