/**
 * AGENT TASK DISCOVERY (POD-6296; docs/design/multi-user-instance.md §2.2,
 * §2.3, §5 Q4; acceptance MU-04 and MU-21).
 *
 * Every member reads every task, so finding Alice's task is a filter, never a
 * right: `--assignee me|all|<member>` across list, search, ready, tree, prime
 * and deck, resolved by the server for people and agents alike. Ready work, the
 * thing an agent picks up next, defaults to the agent's own human. The seat
 * rule's "user" is the agent's own human, and another human's coordinator is
 * never the one a session asks.
 *
 * Every test makes its own tasks so the shared fixture rows stay as the other
 * two-member files expect them.
 */

import { inPersonalSet, type IssueUserStateWire } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MEMBERS,
  type MemberName,
  REPO_PATH,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
const alice = MEMBERS.alice.id
const bob = MEMBERS.bob.id

beforeAll(async () => {
  f = await startTwoMemberInstance()
  // The fixture keeps the upgraded first admin's stored name; name her for the reader.
  await f.handle.registry.sessionStore.users.writeProfile(alice, MEMBERS.alice.displayName, null)
}, 60_000)
afterAll(async () => {
  await f?.close()
})

interface Wire {
  id: string
  seq: number
  title: string
  assignee?: string
  assigneeName?: string
}

const trpc = async (name: MemberName) => (await f.as(name)).trpc

/** A fresh task of `owner`'s, created through their own login. */
async function taskOf(owner: MemberName, title: string, parentId?: string): Promise<Wire> {
  return (await (
    await trpc(owner)
  ).issues.create.mutate({
    repoPath: REPO_PATH,
    title,
    startNow: false,
    ...(parentId ? { parentId } : {}),
  } as never)) as Wire
}

/** The ids in the member's personal set (their sidebar), read off their own feed. */
async function personalSet(name: MemberName): Promise<string[]> {
  const feed = await (await f.as(name)).feed()
  try {
    const states = ((await feed.bootstrap()).issueUserStates ?? []) as IssueUserStateWire[]
    return states.filter((row) => inPersonalSet(row)).map((row) => row.entityId)
  } finally {
    feed.close()
  }
}

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id)

describe('MU-04: Bob finds Alice’s task under All users, in search and through his agent', () => {
  it('Bob’s list and search hold Alice’s task, named with Alice as assignee', async () => {
    const task = await taskOf('alice', 'Quarterly glacier survey')
    const bobs = await trpc('bob')

    const all = (await bobs.issues.list.query({ repoPath: REPO_PATH } as never)) as Wire[]
    expect(all.find((row) => row.id === task.id)).toMatchObject({
      assignee: alice,
      assigneeName: 'Alice',
    })
    const named = (await bobs.issues.list.query({
      repoPath: REPO_PATH,
      assignee: 'Alice',
    } as never)) as Wire[]
    expect(ids(named)).toContain(task.id)
    expect(named.every((row) => row.assignee === alice)).toBe(true)
    const mine = (await bobs.issues.list.query({
      repoPath: REPO_PATH,
      assignee: 'me',
    } as never)) as Wire[]
    expect(ids(mine)).not.toContain(task.id)

    const found = (await bobs.issues.search.query({ text: 'glacier survey' } as never)) as Wire[]
    expect(found.map((row) => [row.id, row.assigneeName])).toEqual([[task.id, 'Alice']])
    const byEmail = (await bobs.issues.search.query({
      text: 'glacier survey',
      assignee: MEMBERS.alice.email,
    } as never)) as Wire[]
    expect(ids(byEmail)).toEqual([task.id])
    expect(
      await bobs.issues.search.query({ text: 'glacier survey', assignee: 'me' } as never),
    ).toEqual([])
  })

  it('Bob’s agent discovers it over the CLI and MCP with Alice named, and nothing joins his sidebar', async () => {
    const task = await taskOf('alice', 'Moraine sediment cores')
    const agent = f.agent(f.sessions.bob)

    const listed = await agent.cli(['list', '--assignee', 'all'])
    expect(listed).toContain(`#${task.seq} `)
    expect(listed).toMatch(new RegExp(`#${task.seq} .*Moraine sediment cores · assignee: Alice`))
    const searched = await agent.cli(['search', '--text', 'moraine sediment'])
    expect(searched).toContain('Moraine sediment cores · assignee: Alice')
    const viaMcp = await agent.mcp('issue_search', { text: 'moraine sediment', assignee: 'Alice' })
    expect(viaMcp).toContain('Moraine sediment cores · assignee: Alice')
    const tree = await agent.cli(['tree', String(task.seq)])
    expect(tree).toContain('assignee=Alice')

    expect(await personalSet('bob')).not.toContain(task.id)
  })

  it('an unknown member is refused by name, not read as nobody', async () => {
    await expect(
      (await trpc('bob')).issues.list.query({ assignee: 'Mallory' } as never),
    ).rejects.toThrow(/Mallory: no such member/)
  })
})

describe('ready work defaults to the agent’s own human', () => {
  it('Bob’s agent’s default ready list holds only Bob’s tasks; --assignee all shows Alice’s', async () => {
    const hers = await taskOf('alice', 'Alice ready crevasse map')
    const his = await taskOf('bob', 'Bob ready crevasse map')
    const agent = f.agent(f.sessions.bob)

    const ready = (await agent.client.issues.ready.query({ repoPath: REPO_PATH })) as Wire[]
    expect(ids(ready)).toContain(his.id)
    expect(ids(ready)).not.toContain(hers.id)
    expect(ready.every((row) => row.assignee === bob)).toBe(true)
    const text = await agent.cli(['ready'])
    expect(text).toContain('Bob ready crevasse map')
    expect(text).not.toContain('Alice ready crevasse map')

    const everyone = (await agent.client.issues.ready.query({
      repoPath: REPO_PATH,
      assignee: 'all',
    } as never)) as Wire[]
    expect(ids(everyone)).toEqual(expect.arrayContaining([hers.id, his.id]))
  })

  it('Bob in person gets the same default, and his agent’s `me` is Bob, not the task’s assignee', async () => {
    const hers = await taskOf('alice', 'Alice ready serac survey')
    const his = await taskOf('bob', 'Bob ready serac survey')
    const own = (await (await trpc('bob')).issues.ready.query({
      repoPath: REPO_PATH,
    } as never)) as Wire[]
    expect(ids(own)).toContain(his.id)
    expect(ids(own)).not.toContain(hers.id)

    // `bobOnAliceTask` is Bob's agent on Alice's task: its `me` is still Bob.
    const onAlices = (await f
      .agent(f.sessions.bobOnAliceTask)
      .client.issues.ready.query({ repoPath: REPO_PATH, assignee: 'me' } as never)) as Wire[]
    expect(ids(onAlices)).toContain(his.id)
    expect(ids(onAlices)).not.toContain(hers.id)
  })

  it('prime names Bob, Alice as the task’s assignee, the agent and its scope', async () => {
    const text = await f.agent(f.sessions.bobOnAliceTask).cli(['prime'])
    expect(text).toContain(`You act for Bob (${bob})`)
    expect(text).toContain(`This task's assignee is Alice (${alice}), not Bob`)
    expect(text).toContain(`You are agent session ${f.sessions.bobOnAliceTask}`)
    expect(text).toMatch(/Your write scope is REP-\d+ and its sub-issues/)
  })
})

describe('tree and deck narrow to one assignee and keep the path to it', () => {
  it('Bob’s sub-task under Alice’s task stays, with its parent; Alice’s other child is hidden', async () => {
    const root = await taskOf('alice', 'Ice shelf mission')
    const hersBelow = await taskOf('alice', 'Alice shelf child', root.id)
    const hisBelow = await taskOf('bob', 'Bob shelf child', root.id)
    const bobs = await trpc('bob')

    const tree = (await bobs.issues.tree.query({ id: root.id, assignee: 'me' } as never)) as {
      root: { id: string; children: Array<{ id: string }> }
      assigneeHidden?: number
    }
    expect(tree.root.id).toBe(root.id)
    expect(ids(tree.root.children)).toEqual([hisBelow.id])
    expect(tree.assigneeHidden).toBe(1)

    const deck = (await bobs.issues.deck.query({ id: root.id, assignee: 'me' } as never)) as {
      root: { children: Array<{ id: string; assigneeName?: string }> }
    }
    expect(deck.root.children.map((c) => [c.id, c.assigneeName])).toEqual([[hisBelow.id, 'Bob']])
    const full = (await bobs.issues.deck.query({ id: root.id } as never)) as {
      root: { children: Array<{ id: string }> }
    }
    expect(ids(full.root.children)).toEqual(expect.arrayContaining([hersBelow.id, hisBelow.id]))
  })
})
