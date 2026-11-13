/**
 * THE NOTICE INBOX ACROSS MEMBERS (POD-6881, credential management spec §13).
 *
 * Through the real server, with Alice (an admin), Bob (a member) and Carol (a
 * disabled account):
 *
 *  - acceptance 3, PRIVACY: `notices.list` answers only the caller's notices;
 *    another member, the admin included, can neither read nor mark one; the
 *    sync stream carries a notice to its recipient's devices and nobody else's.
 *  - acceptance 4, MENTIONS: one notice per mentioned member who may read the
 *    task, none for the author (or the author's agent), none for a disabled
 *    account, none for a name that is no member; an edit tells the added name
 *    only, and dropping a name or deleting the comment resolves its notice.
 *
 * Each refusal sits beside a control: the same call by the recipient, answered.
 */

import { asUserId, type NoticeWire, noticeRowId, type UserId } from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { memberFacts } from './store/fixtures/test-support'
import {
  changedIds,
  MEMBERS,
  type MemberName,
  REPO_PATH,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
const DAVE: UserId = asUserId('mem_fixture_dave')

beforeAll(async () => {
  f = await startTwoMemberInstance()
  // A third active member, so an edit can ADD a name beside Bob.
  await memberFacts(f.handle.registry.sessionStore).create(
    {
      id: DAVE,
      displayName: 'Dave Rowe',
      email: 'dave@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
      disabledAt: null,
    },
    await hashPassword('dave-fixture-password'),
  )
}, 60_000)
afterAll(async () => {
  await f?.close()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const trpc = async (name: MemberName) => (await f.as(name)).trpc
const store = () => f.handle.registry.sessionStore
const alice = () => MEMBERS.alice.id
const bob = MEMBERS.bob.id
const carol = MEMBERS.carol.id

const list = async (name: MemberName): Promise<NoticeWire[]> =>
  (await (await trpc(name)).notices.list.query({} as never)) as NoticeWire[]

const unread = async (user: UserId) => await store().notices.countUnread(user)

/** Every notice row of one comment, read off the table, open or resolved. */
const rowsOfComment = async (commentId: string) =>
  (
    await Promise.all(
      [alice(), bob, carol, DAVE].map(
        async (user) => await store().notices.listOpen(user, { limit: 200 }),
      ),
    )
  )
    .flat()
    .filter((row) => row.subjectAnchor === commentId)

async function submit(name: MemberName, command: string, input: unknown) {
  return (await (
    await trpc(name)
  ).sync.submit.mutate({
    mutationId: `m-${crypto.randomUUID()}`,
    command,
    version: 1,
    input,
  } as never)) as { outcome: string; result?: unknown; refusal?: { kind: string } }
}

async function newTask(title: string): Promise<{ id: string; seq: number }> {
  return (await (
    await trpc('alice')
  ).issues.create.mutate({
    repoPath: REPO_PATH,
    title,
    startNow: false,
  } as never)) as { id: string; seq: number }
}

async function comment(name: MemberName, id: string, body: string): Promise<string> {
  await (await trpc(name)).issues.addComment.mutate({ id, body } as never)
  const all = (await (await trpc(name)).issues.comments.query({ id } as never)) as {
    id: string
    body: string
  }[]
  const mine = all.find((c) => c.body === body)
  if (!mine) throw new Error(`comment "${body}" was not recorded`)
  return mine.id
}

describe('mentions (acceptance 4)', () => {
  it('one notice for each mentioned member who may read the task; none for the author, a disabled account or a stranger', async () => {
    const task = await newTask('notices: mention fan-out')
    const before = { alice: await unread(alice()), carol: await unread(carol) }
    // The author by their own name: the first admin's profile name on this instance.
    const author = (await store().users.get(alice()))?.displayName
    expect(author).toBeTruthy()

    const commentId = await comment(
      'alice',
      task.id,
      `@Bob and @${author}, also @Carol and @Nobody: look`,
    )

    const rows = await rowsOfComment(commentId)
    expect(rows.map((r) => r.recipientUserId)).toEqual([bob])
    expect(rows[0]?.kind).toBe('mention')
    expect(rows[0]?.subjectKind).toBe('issue')
    expect(rows[0]?.subjectId).toBe(task.id)
    expect(rows[0]?.title).toBe(
      `${author} mentioned you on REP-${task.seq}: notices: mention fan-out`,
    )
    expect(await unread(alice())).toBe(before.alice)
    expect(await unread(carol)).toBe(before.carol)
  })

  it('a member’s agent mentioning that member raises nothing; mentioning another raises one', async () => {
    const agent = f.agent(f.sessions.bob)
    await agent.client.issues.addComment.mutate({
      id: f.tasks.bob,
      body: 'note to @Bob from his agent, and to @Dave Rowe',
    } as never)
    const all = (await (await trpc('bob')).issues.comments.query({ id: f.tasks.bob } as never)) as {
      id: string
      body: string
    }[]
    const commentId = all.find((c) => c.body.startsWith('note to @Bob'))?.id ?? ''
    expect((await rowsOfComment(commentId)).map((r) => r.recipientUserId)).toEqual([DAVE])
  })

  it('an edit that adds a name tells the added name only; dropping a name resolves its notice', async () => {
    const task = await newTask('notices: edit adds a name')
    const commentId = await comment('alice', task.id, 'first, @Bob')
    expect((await rowsOfComment(commentId)).map((r) => r.recipientUserId)).toEqual([bob])

    const emitted = vi.spyOn(f.handle.registry.modules.notices, 'emitNotice')
    await (await trpc('alice')).issues.editComment.mutate({
      id: task.id,
      commentId,
      body: 'first, @Bob, and now @Dave Rowe',
    } as never)
    expect(emitted.mock.calls.map(([i]) => i.recipientUserId)).toEqual([DAVE])
    expect((await rowsOfComment(commentId)).map((r) => r.recipientUserId).sort()).toEqual(
      [bob, DAVE].sort(),
    )

    await (await trpc('alice')).issues.editComment.mutate({
      id: task.id,
      commentId,
      body: 'only @Dave Rowe now',
    } as never)
    expect((await rowsOfComment(commentId)).map((r) => r.recipientUserId)).toEqual([DAVE])

    await (await trpc('alice')).issues.deleteComment.mutate({ id: task.id, commentId } as never)
    expect(await rowsOfComment(commentId)).toEqual([])
  })
})

describe('privacy (acceptance 3)', () => {
  it('notices.list answers only the caller’s notices, the admin’s call included', async () => {
    const task = await newTask('notices: private list')
    const commentId = await comment('alice', task.id, 'for @Bob only')

    const bobs = await list('bob')
    expect(bobs.some((n) => n.subjectAnchor === commentId)).toBe(true)
    expect(bobs.every((n) => n.recipientUserId === bob)).toBe(true)
    const alices = await list('alice')
    expect(alices.some((n) => n.subjectAnchor === commentId)).toBe(false)
    expect(alices.every((n) => n.recipientUserId === alice())).toBe(true)
  })

  it('another member, the admin included, cannot mark a notice; its recipient can', async () => {
    const task = await newTask('notices: private marks')
    const commentId = await comment('alice', task.id, 'mark this, @Bob')
    const notice = (await list('bob')).find((n) => n.subjectAnchor === commentId)
    if (!notice) throw new Error('Bob has no notice for the comment')
    const bobsUnread = await unread(bob)

    const byAdmin = await submit('alice', 'notices.markRead', { id: notice.noticeId })
    expect(byAdmin.outcome).toBe('applied')
    expect(byAdmin.result).toEqual({ marked: false })
    await submit('alice', 'notices.markAllRead', {})
    expect(await unread(bob)).toBe(bobsUnread)

    // Control: Bob marks his own.
    const byBob = await submit('bob', 'notices.markRead', { id: notice.noticeId })
    expect(byBob.result).toEqual({ marked: true })
    expect(await unread(bob)).toBe(bobsUnread - 1)
  })

  it('the sync stream delivers a notice to its recipient and to nobody else', async () => {
    const task = await newTask('notices: private feed')
    const bobFeed = await (await f.as('bob')).feed()
    const aliceFeed = await (await f.as('alice')).feed()
    try {
      const commentId = await comment('alice', task.id, 'feed check, @Bob')
      const notice = (await list('bob')).find((n) => n.subjectAnchor === commentId)
      if (!notice) throw new Error('Bob has no notice for the comment')
      const rowId = noticeRowId(bob, notice.noticeId)

      await bobFeed.until(() => changedIds(bobFeed.deltas(), 'inboxNotice').includes(rowId))
      // Canary: Alice's stream carried the same commit (the task's comment), so
      // the absence below is not a stream that never moved.
      await aliceFeed.until(() =>
        changedIds(aliceFeed.deltas(), 'issueProjection').includes(task.id),
      )
      expect(changedIds(aliceFeed.deltas(), 'inboxNotice')).toEqual([])
    } finally {
      bobFeed.close()
      aliceFeed.close()
    }
  })
})
