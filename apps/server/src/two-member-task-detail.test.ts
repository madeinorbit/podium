/**
 * WHAT THE TASK PAGE MAY OFFER (POD-6295; docs/design/multi-user-instance.md
 * §2.2, §2.3). The page draws a control only where the server says the
 * viewer may use it: reassign, edit, restore and comment on the task, and edit
 * on each comment. A member reassigns, edits and restores anyone's task; a
 * comment's edit control is its author's alone; an agent never reassigns.
 *
 * Every test makes its own task or comments, so the shared fixture rows stay
 * as the other two-member files expect them.
 */

import type { IssueId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
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

interface Allowed {
  reassign: boolean
  edit: boolean
  restore: boolean
  comment: boolean
}

interface Comment {
  id: string
  body: string
  mayEdit?: boolean
}

const trpc = async (name: MemberName) => (await f.as(name)).trpc

async function aliceTask(title: string): Promise<IssueId> {
  const task = (await (
    await trpc('alice')
  ).issues.create.mutate({
    repoPath: REPO_PATH,
    title,
    startNow: false,
  } as never)) as { id: IssueId }
  return task.id
}

const allowedFor = async (name: MemberName, id: string): Promise<Allowed | undefined> =>
  ((await (await trpc(name)).issues.get.query({ id } as never)) as { allowed?: Allowed }).allowed

const comments = async (name: MemberName, id: string): Promise<Comment[]> =>
  (await (await trpc(name)).issues.comments.query({ id } as never)) as Comment[]

describe('the task page’s controls come from the server', () => {
  it('Bob opening Alice’s task may reassign, edit, restore and comment', async () => {
    const id = await aliceTask('detail: bob may act')
    expect(await allowedFor('bob', id)).toEqual({
      reassign: true,
      edit: true,
      restore: true,
      comment: true,
    })
    // The same answer for the assignee: nothing on a task is hers alone.
    expect(await allowedFor('alice', id)).toEqual(await allowedFor('bob', id))
  })

  it('an agent may edit in its subtree but never reassign the human', async () => {
    const answer = (await f.agent(f.sessions.bobOnAliceTask).client.issues.get.query({
      id: f.tasks.alice,
    } as never)) as { allowed?: Allowed }
    expect(answer.allowed).toMatchObject({ reassign: false, edit: true })
  })

  it('outside its subtree an agent is offered no edit: the write would need --outside-scope', async () => {
    const answer = (await f.agent(f.sessions.bobOnAliceTask).client.issues.get.query({
      id: f.tasks.bob,
    } as never)) as { allowed?: Allowed }
    expect(answer.allowed).toEqual({ reassign: false, edit: false, restore: false, comment: false })
  })

  it('only the author of a comment is offered its edit control', async () => {
    const id = await aliceTask('detail: comment edit')
    await (await trpc('alice')).issues.addComment.mutate({ id, body: 'by alice' } as never)
    await (await trpc('bob')).issues.addComment.mutate({ id, body: 'by bob' } as never)

    const mayEdit = async (name: MemberName) =>
      Object.fromEntries((await comments(name, id)).map((c) => [c.body, c.mayEdit]))
    expect(await mayEdit('bob')).toEqual({ 'by alice': false, 'by bob': true })
    // Alice is an admin; moderation stays possible by command, but the page
    // offers edit on her own comments only.
    expect(await mayEdit('alice')).toEqual({ 'by alice': true, 'by bob': false })
  })
})
