/**
 * TASK EDIT HISTORY AND COMMENT AUTHORSHIP (POD-6289; docs/design/multi-user-instance.md
 * §2.2, §4.4; acceptance MU-19, MU-17 edits half).
 *
 * Every description and brief text a task holds is a revision attributed to
 * who wrote it and the human it acted for. Anyone who may edit the task may
 * restore one, and the restore is a new revision. Concurrent edits cut from
 * one revision resolve by that revision: one applies, the other is refused,
 * and nothing either wrote is lost. Only a comment's author edits or deletes
 * it; an admin may moderate, which is audited and keeps the author.
 *
 * Every test makes its own task so the shared fixture rows stay as the other
 * two-member files expect them.
 */

import type { IssueId, SessionId } from '@podium/model'
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
  id: IssueId
  seq: number
  revision: number
  description?: string
  brief?: string
}

interface Revision {
  id: number
  field: 'description' | 'brief'
  body: string
  source: 'create' | 'baseline' | 'edit' | 'restore'
  restoredFrom: number | null
  issueRevision: number | null
  actor: string | null
  onBehalfOf: string | null
}

interface Comment {
  id: string
  author: string
  body: string
  authorId?: string
  editedAt?: string
  editedBy?: string
}

const trpc = async (name: MemberName) => (await f.as(name)).trpc
const store = () => f.handle.registry.sessionStore

/** A fresh task of Alice's, created through her own login. */
async function aliceTask(
  title: string,
  extra: { description?: string; brief?: string; parentId?: IssueId } = {},
): Promise<Wire> {
  return (await (
    await trpc('alice')
  ).issues.create.mutate({
    repoPath: REPO_PATH,
    title,
    startNow: false,
    ...extra,
  } as never)) as Wire
}

const read = async (id: string): Promise<Wire> =>
  (await (await trpc('alice')).issues.get.query({ id } as never)) as Wire

const history = async (
  name: MemberName,
  id: string,
  field: 'description' | 'brief' = 'description',
): Promise<Revision[]> =>
  (await (await trpc(name)).issues.textRevisions.query({ id, field } as never)) as Revision[]

const comments = async (name: MemberName, id: string): Promise<Comment[]> =>
  (await (await trpc(name)).issues.comments.query({ id } as never)) as Comment[]

async function commentAs(name: MemberName, id: string, body: string): Promise<Comment> {
  await (await trpc(name)).issues.addComment.mutate({ id, body } as never)
  const mine = (await comments(name, id)).find((c) => c.body === body)
  if (!mine) throw new Error(`comment "${body}" was not recorded`)
  return mine
}

const textEvents = async (id: string) =>
  (await store().events.listEventsSince(0, { kinds: ['issue.text_revised'], subject: id })).map(
    (e) => e.payload as Record<string, unknown>,
  )

const moderationAudit = async () =>
  (await store().settingsAudit.list(1000)).filter((row) =>
    ['issues.editComment', 'issues.deleteComment'].includes(row.command),
  )

const agentActor = (sessionId: SessionId) => `session:${sessionId}`

describe('MU-19: Bob’s edit to Alice’s task is his revision; restore is a new one', () => {
  it('Bob edits Alice’s description: a revision attributed to Bob, after Alice’s first text', async () => {
    const task = await aliceTask('history: bob edits', { description: 'v1 by alice' })
    const edited = (await (
      await trpc('bob')
    ).issues.update.mutate({ id: task.id, patch: { description: 'v2 by bob' } } as never)) as Wire
    expect(edited.description).toBe('v2 by bob')

    const revs = await history('bob', task.id)
    expect(revs.map((r) => [r.source, r.body, r.actor, r.onBehalfOf])).toEqual([
      ['create', 'v1 by alice', alice, alice],
      ['edit', 'v2 by bob', bob, bob],
    ])
    expect(revs[1]?.issueRevision).toBe(edited.revision)
    expect(await textEvents(task.id)).toEqual([
      expect.objectContaining({
        field: 'description',
        actor: bob,
        by: bob,
        revision: edited.revision,
      }),
    ])
  })

  it('Alice restores her text: a new revision under her name, the earlier ones untouched', async () => {
    const task = await aliceTask('history: restore', { description: 'original' })
    await (await trpc('bob')).issues.update.mutate({
      id: task.id,
      patch: { description: 'rewritten by bob' },
    } as never)
    const before = await history('alice', task.id)
    const original = before.find((r) => r.source === 'create')
    if (!original) throw new Error('no create revision')

    const restored = (await (
      await trpc('alice')
    ).issues.restoreTextRevision.mutate({ id: task.id, revisionId: original.id } as never)) as Wire
    expect(restored.description).toBe('original')

    const after = await history('alice', task.id)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after).toHaveLength(before.length + 1)
    expect(after.at(-1)).toMatchObject({
      source: 'restore',
      body: 'original',
      restoredFrom: original.id,
      actor: alice,
      onBehalfOf: alice,
      issueRevision: restored.revision,
    })
    expect(after.at(-1)?.id).not.toBe(original.id)
  })

  it('the brief keeps its own history the same way', async () => {
    const task = await aliceTask('history: brief', { brief: 'brief v1' })
    await (await trpc('bob')).issues.update.mutate({
      id: task.id,
      patch: { brief: 'brief v2' },
    } as never)
    expect((await history('alice', task.id, 'brief')).map((r) => [r.body, r.onBehalfOf])).toEqual([
      ['brief v1', alice],
      ['brief v2', bob],
    ])
    // The description was never written, so it has no history at all.
    expect(await history('alice', task.id, 'description')).toEqual([])
  })

  it('a task from before the history: its first edit keeps the old text as a restorable baseline', async () => {
    const task = await aliceTask('history: legacy', { description: 'written before history' })
    // As an upgraded instance has it: the text, and no history rows.
    // @ts-expect-error test-only access to SessionStore's private connection
    await store().db.prepare('DELETE FROM issue_text_revisions WHERE issue_id = ?').run(task.id)

    await (await trpc('bob')).issues.update.mutate({
      id: task.id,
      patch: { description: 'first recorded edit' },
    } as never)
    const revs = await history('alice', task.id)
    expect(revs.map((r) => [r.source, r.body, r.actor, r.onBehalfOf])).toEqual([
      // Who wrote it is unknown, so the baseline names nobody.
      ['baseline', 'written before history', null, null],
      ['edit', 'first recorded edit', bob, bob],
    ])
    await (await trpc('alice')).issues.restoreTextRevision.mutate({
      id: task.id,
      revisionId: revs[0]?.id,
    } as never)
    expect((await read(task.id)).description).toBe('written before history')
    // Only the first edit records a baseline.
    expect((await history('alice', task.id)).filter((r) => r.source === 'baseline')).toHaveLength(1)
  })

  it('a restore of another task’s revision is refused and writes nothing', async () => {
    const mine = await aliceTask('history: foreign a', { description: 'a text' })
    const other = await aliceTask('history: foreign b', { description: 'b text' })
    const foreign = (await history('alice', other.id))[0]
    if (!foreign) throw new Error('no revision on the other task')
    await expect(
      (await trpc('bob')).issues.restoreTextRevision.mutate({
        id: mine.id,
        revisionId: foreign.id,
      } as never),
    ).rejects.toThrow(/not a revision of issue/)
    expect((await read(mine.id)).description).toBe('a text')
    expect(await history('alice', mine.id)).toHaveLength(1)
  })

  it('Bob cannot edit or delete Alice’s comment; Alice can edit her own', async () => {
    const task = await aliceTask('comments: author only')
    const hers = await commentAs('alice', task.id, 'alice wrote this')
    expect(hers.authorId).toBe(alice)

    const bobs = await trpc('bob')
    await expect(
      bobs.issues.editComment.mutate({
        id: task.id,
        commentId: hers.id,
        body: 'bob was here',
      } as never),
    ).rejects.toThrow(/only the comment's author/)
    await expect(
      bobs.issues.deleteComment.mutate({ id: task.id, commentId: hers.id } as never),
    ).rejects.toThrow(/only the comment's author/)
    // Bob's agent acts for Bob, so it is refused too.
    await expect(
      f.agent(f.sessions.bobOnAliceTask, { outsideScope: true }).client.issues.editComment.mutate({
        id: task.id,
        commentId: hers.id,
        body: 'bob agent was here',
      } as never),
    ).rejects.toThrow(/only the comment's author/)
    expect((await comments('alice', task.id)).find((c) => c.id === hers.id)).toMatchObject({
      body: 'alice wrote this',
      authorId: alice,
    })
    expect(
      (await comments('alice', task.id)).find((c) => c.id === hers.id)?.editedAt,
    ).toBeUndefined()

    await (await trpc('alice')).issues.editComment.mutate({
      id: task.id,
      commentId: hers.id,
      body: 'alice rewrote this',
    } as never)
    expect((await comments('bob', task.id)).find((c) => c.id === hers.id)).toMatchObject({
      body: 'alice rewrote this',
      author: hers.author,
      authorId: alice,
      editedBy: alice,
    })
    // An author's own edit is not moderation: nothing in the audit trail.
    expect(
      (await moderationAudit()).filter((r) => JSON.stringify(r.detail).includes(hers.id)),
    ).toEqual([])

    await (await trpc('alice')).issues.deleteComment.mutate({
      id: task.id,
      commentId: hers.id,
    } as never)
    expect((await comments('alice', task.id)).map((c) => c.id)).not.toContain(hers.id)
  })

  it('a comment id from another task is unknown here', async () => {
    const a = await aliceTask('comments: task a')
    const b = await aliceTask('comments: task b')
    const onB = await commentAs('alice', b.id, 'on b')
    await expect(
      (await trpc('alice')).issues.editComment.mutate({
        id: a.id,
        commentId: onB.id,
        body: 'moved?',
      } as never),
    ).rejects.toThrow(/comment/)
    expect((await comments('alice', b.id)).find((c) => c.id === onB.id)?.body).toBe('on b')
  })
})

describe('MU-17 (edits): concurrent edits resolve by revision, attributed, nothing lost', () => {
  it('two edits cut from one revision: one applies, the other is refused, history has the winner only', async () => {
    const task = await aliceTask('race: description', { description: 'base' })
    const { revision } = await read(task.id)
    const results = await Promise.allSettled([
      (await trpc('alice')).issues.update.mutate({
        id: task.id,
        patch: { description: 'alice wins?' },
        expectedRevision: revision,
      } as never),
      (await trpc('bob')).issues.update.mutate({
        id: task.id,
        patch: { description: 'bob wins?' },
        expectedRevision: revision,
      } as never),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(refused.reason)).toMatch(/expected revision \d+ .* but it is at revision \d+/)

    const current = await read(task.id)
    const edits = (await history('alice', task.id)).filter((r) => r.source === 'edit')
    expect(edits).toHaveLength(1)
    expect(edits[0]?.body).toBe(current.description)
    expect(edits[0]?.onBehalfOf).toBe(current.description === 'alice wins?' ? alice : bob)
    const events = await textEvents(task.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ by: edits[0]?.onBehalfOf, revision: current.revision })
  })

  it('the refused editor re-reads and retries: both edits are attributed revisions, no update lost', async () => {
    const task = await aliceTask('race: retry', { description: 'base' })
    const { revision } = await read(task.id)
    await (await trpc('alice')).issues.update.mutate({
      id: task.id,
      patch: { description: 'alice first' },
      expectedRevision: revision,
    } as never)
    await expect(
      (await trpc('bob')).issues.update.mutate({
        id: task.id,
        patch: { description: 'bob from stale' },
        expectedRevision: revision,
      } as never),
    ).rejects.toThrow(/revision/)
    expect((await read(task.id)).description).toBe('alice first')

    const fresh = await read(task.id)
    await (await trpc('bob')).issues.update.mutate({
      id: task.id,
      patch: { description: 'bob after alice' },
      expectedRevision: fresh.revision,
    } as never)

    const revs = await history('bob', task.id)
    expect(revs.map((r) => [r.source, r.body, r.onBehalfOf])).toEqual([
      ['create', 'base', alice],
      ['edit', 'alice first', alice],
      ['edit', 'bob after alice', bob],
    ])
    expect((await textEvents(task.id)).map((e) => e.by)).toEqual([alice, bob])
  })

  it('edits without a revision both land in order, and the overwritten text stays restorable', async () => {
    const task = await aliceTask('race: no revision', { description: 'base' })
    await (await trpc('alice')).issues.update.mutate({
      id: task.id,
      patch: { description: 'alice text' },
    } as never)
    await (await trpc('bob')).issues.update.mutate({
      id: task.id,
      patch: { description: 'bob text' },
    } as never)
    const revs = await history('alice', task.id)
    expect(revs.map((r) => [r.body, r.onBehalfOf])).toEqual([
      ['base', alice],
      ['alice text', alice],
      ['bob text', bob],
    ])
    const alicesText = revs[1]
    if (!alicesText) throw new Error('alice text missing')
    await (await trpc('alice')).issues.restoreTextRevision.mutate({
      id: task.id,
      revisionId: alicesText.id,
    } as never)
    expect((await read(task.id)).description).toBe('alice text')
  })
})

describe('an agent’s edit is attributed to the agent and its human', () => {
  it('Bob’s agent edits a task in its subtree: actor is the session, on behalf of Bob', async () => {
    // A child of Alice's task sits in the subtree of Bob's agent on that task.
    const child = await aliceTask('agent edits', {
      brief: 'brief by alice',
      parentId: f.tasks.alice,
    })
    await f
      .agent(f.sessions.bobOnAliceTask)
      .cli(['update', String(child.id), '--brief', 'brief by bob agent'])
    expect((await history('alice', child.id, 'brief')).at(-1)).toMatchObject({
      source: 'edit',
      body: 'brief by bob agent',
      actor: agentActor(f.sessions.bobOnAliceTask),
      onBehalfOf: bob,
    })
    expect((await textEvents(child.id)).at(-1)).toMatchObject({
      actor: agentActor(f.sessions.bobOnAliceTask),
      by: bob,
    })
  })

  it('a comment Bob’s agent writes is Bob’s: Bob may edit it, Alice’s agent may not', async () => {
    const task = await aliceTask('agent comment', { parentId: f.tasks.alice })
    await f
      .agent(f.sessions.bobOnAliceTask)
      .client.issues.addComment.mutate({ id: task.id, body: 'from bob agent' } as never)
    const written = (await comments('alice', task.id)).find((c) => c.body === 'from bob agent')
    expect(written?.authorId).toBe(bob)
    if (!written) throw new Error('agent comment missing')

    // Alice is an admin, but her agent is not: moderation is a person's act.
    await expect(
      f.agent(f.sessions.alice).client.issues.editComment.mutate({
        id: task.id,
        commentId: written.id,
        body: 'alice agent rewrote',
      } as never),
    ).rejects.toThrow(/only the comment's author/)

    await (await trpc('bob')).issues.editComment.mutate({
      id: task.id,
      commentId: written.id,
      body: 'bob tidied his agent’s note',
    } as never)
    expect((await comments('alice', task.id)).find((c) => c.id === written.id)).toMatchObject({
      body: 'bob tidied his agent’s note',
      author: written.author,
      authorId: bob,
      editedBy: bob,
    })
  })
})

describe('admin moderation is allowed, audited, and keeps the author', () => {
  it('Alice (admin) edits Bob’s comment: an audit row names her, the comment still shows Bob', async () => {
    const task = await aliceTask('moderate: edit')
    const his = await commentAs('bob', task.id, 'something to moderate')
    expect(his).toMatchObject({ author: MEMBERS.bob.displayName, authorId: bob })

    await (await trpc('alice')).issues.editComment.mutate({
      id: task.id,
      commentId: his.id,
      body: '[removed by a moderator]',
    } as never)

    const shown = (await comments('bob', task.id)).find((c) => c.id === his.id)
    expect(shown).toMatchObject({
      author: MEMBERS.bob.displayName,
      authorId: bob,
      body: '[removed by a moderator]',
      editedBy: alice,
    })
    const row = await store().issues.getIssueComment(his.id)
    expect(row).toMatchObject({ actor: bob, onBehalfOf: bob, editedOnBehalfOf: alice })

    const audit = (await moderationAudit()).filter(
      (r) => (r.detail as { commentId?: string }).commentId === his.id,
    )
    expect(audit).toEqual([
      expect.objectContaining({
        command: 'issues.editComment',
        outcome: 'applied',
        actorKind: 'user',
        actorId: alice,
        onBehalfOf: alice,
        detail: expect.objectContaining({ moderation: true, issueId: task.id, authorId: bob }),
      }),
    ])
    // The trail carries ids, never the comment's text.
    expect(JSON.stringify(audit)).not.toContain('something to moderate')
  })

  it('Alice (admin) deletes Bob’s comment: audited the same way', async () => {
    const task = await aliceTask('moderate: delete')
    const his = await commentAs('bob', task.id, 'to be removed')
    await (await trpc('alice')).issues.deleteComment.mutate({
      id: task.id,
      commentId: his.id,
    } as never)
    expect((await comments('alice', task.id)).map((c) => c.id)).not.toContain(his.id)
    expect(
      (await moderationAudit()).filter(
        (r) => (r.detail as { commentId?: string }).commentId === his.id,
      ),
    ).toEqual([
      expect.objectContaining({
        command: 'issues.deleteComment',
        actorId: alice,
        detail: expect.objectContaining({ moderation: true, authorId: bob }),
      }),
    ])
  })
})
