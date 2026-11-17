/**
 * ISSUES ARE A WORKSPACE'S (POD-6959 design 2.4, 2.5; task POD-7016).
 *
 * Two workspaces over one database (`openWorkspaceStores`), each seeded through its own
 * repositories with its own issues, labels, dependencies, comments, text history, mail,
 * markers, session letters, panel records and git states.
 * Both workspaces hold the SAME ids and natural keys (POD-7025): the same issues, repository,
 * path, machine, people, label names, comments, mail and panel items. Every key leads with
 * workspace_id (POD-7024), so the same id is two rows, told apart only by the workspace. The
 * content differs (titles, texts, bodies, the owner, timestamps, panel positions, the labels
 * an issue carries, git states), so a read that crossed over would answer the other
 * workspace's content. Where a case needs an id the other workspace does not hold, it plants
 * one only the other holds (`only-<tag>`).
 *
 * For every repository method of the group (issues.ts with its listings, the panel and the git
 * states):
 *   - a read answers only its own workspace's rows;
 *   - an update, delete or upsert in one workspace leaves the other's rows unchanged, both for
 *     the ids the two share and for ids only the other holds, which must find nothing to change;
 *   - issue numbers count per (workspace, repository).
 */

import {
  asIssueId,
  asIssuePanelItemId,
  asMachineId,
  asRepoId,
  asUserId,
  type IssueId,
  type IssuePanelTodoWire,
  type UserId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { issueRowFixture } from '../test-support/issue-row'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import type { IssueListingShape } from './issue-listings'
import type { IssueRow } from './types'

type Tag = 'a' | 'b'
const TAGS = ['a', 'b'] as const
const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
/** Each workspace's own timestamp: content, not a key. */
const AT_OF: Record<Tag, string> = { a: '2026-11-17T10:00:00.000Z', b: '2026-11-17T10:30:00.000Z' }
const LATER = '2026-11-17T11:00:00.000Z'
const scope = fixtureWriteScope()

const other = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
// The same ids and natural keys in both workspaces.
const user = (name = 'alice'): UserId => asUserId(`user:${name}`)
const ALICE = user()
const BOB = user('bob')
const iss = (n: number): IssueId => asIssueId(`iss-${n}`)
const REPO = asRepoId('repo-1')
const ROOT = '/repo'
const MACHINE = asMachineId('machine-1')
const comment = (n: number) => `comment-${n}`
const message = (n: number) => `mail-${n}`
const todo = (n: number) => asIssuePanelItemId(`todo-${n}`)
const artifact = (n: number) => asIssuePanelItemId(`artifact-${n}`)
const deferred = (n: number) => asIssuePanelItemId(`deferred-${n}`)
/** The issues' owner: the same people in both, a different owner per workspace. */
const owner = (tag: Tag): UserId => (tag === 'a' ? ALICE : BOB)
/** The labels issue 1 carries: the same names, `ui` only in A. */
const labelsOf = (tag: Tag): string[] => (tag === 'a' ? ['bug', 'ui'] : ['bug'])
/** The position of the panel items: content, so `next` tells the workspaces apart. */
const position = (tag: Tag): number => (tag === 'a' ? 0 : 1)
// An id only `tag`'s workspace holds.
const only = (tag: Tag): IssueId => asIssueId(`only-${tag}`)

let opened: SessionStore | undefined

afterEach(async () => {
  await opened?.close()
  opened = undefined
})

interface RawDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
}
const rawDb = (store: SessionStore): RawDb => (store as unknown as { db: RawDb }).db

/** The tables this group owns, read raw per workspace, for "unchanged" comparisons. */
const TABLES = [
  'issues',
  'labels',
  'issue_labels',
  'issue_deps',
  'issue_comments',
  'issue_text_revisions',
  'issue_messages',
  'issue_message_user_state',
  'issue_user_state',
  'issue_ref_letters',
  'issue_panel_todos',
  'issue_panel_artifacts',
  'issue_panel_deferred',
  'issue_panel_states',
  'issue_git_states',
] as const

function rowsOf(store: SessionStore, tag: Tag): Record<string, unknown[]> {
  const db = rawDb(store)
  return Object.fromEntries(
    TABLES.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY rowid`).all(WS[tag]),
    ]),
  )
}

/** No content of the other workspace anywhere in `value`. */
function onlyOwn(value: unknown, tag: Tag): void {
  const o = other(tag)
  const text = JSON.stringify(value)
  expect(text).not.toMatch(
    new RegExp(`"${o} |\\b${o}-(artifact|issue-branch)|only-${o}|"${WS[o]}"`),
  )
  expect(text).not.toContain(AT_OF[o])
}

/**
 * One workspace's issues, in the repository `repo-1` at `/repo` (the same in both):
 *   1 parent, open, top level, labelled, deferred;
 *   2 child of 1, blocked by 3, with a worktree on the machine;
 *   3 child of 1, done;
 *   4 top level, deleted;
 *   5 top level, a legacy worktree with no machine.
 */
function issue(tag: Tag, n: number, patch: Partial<IssueRow> = {}): IssueRow {
  return issueRowFixture({
    id: iss(n),
    ownerUserId: owner(tag),
    createdByActor: owner(tag),
    createdByOnBehalfOf: owner(tag),
    repoPath: ROOT,
    repoId: REPO,
    seq: n,
    title: `${tag} issue ${n}`,
    description: `${tag} text ${n}`,
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    machineId: null,
    parentId: null,
    linearId: null,
    linearIdentifier: null,
    linearUrl: null,
    revision: 1,
    sortKey: null,
    deferUntil: null,
    deletedAt: null,
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    updatedAt: `2026-11-0${n}T00:00:00.000Z`,
    ...patch,
  } as Partial<IssueRow> as never)
}

function insertMachine(store: SessionStore, tag: Tag, id: string): void {
  rawDb(store)
    .prepare(
      `INSERT INTO machines (workspace_id, id, name, hostname, token_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(WS[tag], id, `${tag} machine`, `${tag}-host`, `${tag}-token-${id}`, AT_OF[tag], AT_OF[tag])
}

async function seed(store: SessionStore, tag: Tag): Promise<void> {
  const s = store.issues
  const at = AT_OF[tag]
  insertMachine(store, tag, MACHINE)
  await s.upsertIssue(scope, issue(tag, 1, { deferUntil: LATER, sortKey: 'm' }))
  await s.upsertIssue(
    scope,
    issue(tag, 2, {
      parentId: iss(1),
      stage: 'in_progress',
      worktreePath: `${ROOT}/.worktrees/two`,
      machineId: MACHINE,
    }),
  )
  await s.upsertIssue(scope, issue(tag, 3, { parentId: iss(1), stage: 'done' }))
  await s.upsertIssue(scope, issue(tag, 4, { deletedAt: at }))
  await s.upsertIssue(scope, issue(tag, 5, { worktreePath: `${ROOT}/.worktrees/five` }))

  await s.setIssueLabels(iss(1), labelsOf(tag))
  await s.addIssueDep(iss(2), iss(3))
  await s.addIssueDep(iss(2), iss(1), 'related')
  await s.addIssueComment({
    id: comment(1),
    issueId: iss(1),
    author: owner(tag),
    body: `${tag} needle one`,
    createdAt: at,
  })
  await s.addIssueComment({
    id: comment(2),
    issueId: iss(2),
    author: owner(tag),
    body: `${tag} needle two`,
    createdAt: LATER,
  })
  await s.appendIssueTextRevision({
    issueId: iss(1),
    field: 'description',
    body: `${tag} text first`,
    source: 'create',
    restoredFrom: null,
    issueRevision: 1,
    actor: owner(tag),
    onBehalfOf: owner(tag),
    createdAt: at,
  })
  for (const n of [1, 2]) {
    await s.addIssueMessage({
      id: message(n),
      issueId: iss(1),
      fromAuthor: owner(tag),
      body: `${tag} mail ${n}`,
      createdAt: n === 1 ? at : LATER,
      status: 'unread',
      claimedBy: null,
      claimedAt: null,
    })
  }
  await s.markIssueMessagesRead(ALICE, iss(1), [message(1)], at)
  await s.setIssueUserState(scope, ALICE, iss(1), { readAt: at })
  await s.setIssueUserState(scope, BOB, iss(2), { tuckedAt: at })
  expect(await s.allocateSessionLetter(iss(1))).toBe('A')

  const panel = s.panel
  await panel.save(scope, 'issuePanelTodo', {
    id: todo(1),
    issueId: iss(1),
    position: position(tag),
    text: `${tag} todo`,
    done: false,
  })
  await panel.save(scope, 'issuePanelArtifact', {
    id: artifact(1),
    issueId: iss(1),
    position: position(tag),
    path: `${tag}-artifact.png`,
    addedAt: at,
  })
  await panel.save(scope, 'issuePanelDeferred', {
    id: deferred(1),
    issueId: iss(1),
    position: position(tag),
    text: `${tag} deferred`,
    addedAt: at,
  })
  await panel.save(scope, 'issuePanelState', {
    id: iss(1),
    text: `${tag} state`,
    updatedAt: at,
  })
  await s.gitStates.set(scope, iss(2), {
    updatedAt: at,
    branch: `${tag}-issue-branch`,
    shared: false,
    dirtyFiles: tag === 'a' ? 1 : 2,
  })
}

async function twoSeeded(): Promise<readonly [SessionStore, SessionStore]> {
  const stores = await openWorkspaceStores([WS.a, WS.b], { path: ':memory:' })
  opened = stores[0]
  await seed(stores[0], 'a')
  await seed(stores[1], 'b')
  return stores
}

/** An issue only `tag`'s workspace holds: top level, in the same repository, its own number. */
async function plantOnly(store: SessionStore, tag: Tag): Promise<void> {
  await store.issues.upsertIssue(
    scope,
    issue(tag, 6, { id: only(tag), seq: tag === 'a' ? 6 : 7, title: `${tag} only` }),
  )
}

/** The sorted ids of `rows`, each held to its own workspace's title (or, for a row that
 *  carries none, to no content of the other's): the ids are the same in both workspaces, so
 *  the content is what tells a crossed-over row. */
function ids(rows: Iterable<{ id: string; title?: string }>, tag: Tag): string[] {
  const list = [...rows]
  for (const row of list) {
    if (typeof row.title === 'string') expect(row.title.startsWith(`${tag} `), row.id).toBe(true)
    else onlyOwn(row, tag)
  }
  return list.map((row) => row.id).sort()
}
/** The sorted ids of rows that carry no title, held to no other workspace's content. */
function idsOf(rows: Iterable<{ id: string }>, tag: Tag): string[] {
  const list = [...rows]
  onlyOwn(list, tag)
  return list.map((row) => row.id).sort()
}
const pairs = [
  ['a', 0],
  ['b', 1],
] as const

const LIVE: IssueListingShape = { repo: false, live: true, order: 'path-seq' }

describe('the issues repository reads only its own workspace', () => {
  it('writes every row under its own workspace', async () => {
    const [a] = await twoSeeded()
    for (const tag of TAGS) {
      const rows = rowsOf(a, tag)
      for (const table of TABLES) {
        expect({ table, rows: rows[table]!.length > 0 }).toEqual({ table, rows: true })
        onlyOwn(rows[table], tag)
      }
    }
  })

  it('answers the issue row reads with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [tag, at] of pairs) await plantOnly(stores[at], tag)
    for (const [tag, at] of pairs) {
      const s = stores[at].issues
      const o = other(tag)
      const all = [...[1, 2, 3, 4, 5].map(iss), only(tag)].sort()
      const live = [...[1, 2, 3, 5].map(iss), only(tag)].sort()

      // By id: the ids both hold answer with its own row, an id only the other holds misses.
      expect((await s.getIssue(iss(1)))?.title).toBe(`${tag} issue 1`)
      expect(await s.getIssue(only(o))).toBeNull()
      expect((await s.loadIssue(iss(2)))?.title).toBe(`${tag} issue 2`)
      expect(await s.loadIssue(only(o))).toBeUndefined()
      expect(ids((await s.loadIssues([iss(1), only(o)])).values(), tag)).toEqual([iss(1)])
      expect(ids((await s.getIssues([iss(1), only(o)])).values(), tag)).toEqual([iss(1)])
      expect((await s.getIssueLive(iss(1)))?.title).toBe(`${tag} issue 1`)
      expect(await s.getIssueLive(only(o))).toBeNull()
      expect(await s.hasIssue(iss(1))).toBe(true)
      expect(await s.hasIssue(only(o))).toBe(false)

      expect(ids(await s.listIssueRows(), tag)).toEqual(all)
      const pages: { id: string; title: string }[] = []
      for await (const page of s.issueRowPages(2)) pages.push(...page)
      expect(ids(pages, tag)).toEqual(all)
      expect((await s.listIssueParentEdges()).map((e) => e.id).sort()).toEqual(live)

      const refs = await s.issueRefsAtSeqs([1, 2])
      expect([...refs.values()].flat().map((r) => r.id)).toEqual([iss(1), iss(2)])
      expect((await s.issueRefsAt(1)).map((r) => r.id)).toEqual([iss(1)])
      expect((await s.issueRefsAt(1, REPO)).map((r) => r.id)).toEqual([iss(1)])
      // The other workspace's own number in the same repository is no number here.
      expect(await s.issueRefsAt(tag === 'a' ? 7 : 6, REPO)).toEqual([])

      const closure = await s.closureOf([iss(3), only(o)])
      expect([...closure.keys()]).toEqual([iss(3)])
      expect([...(await s.closedIssueIdsAmong([iss(3), iss(4), only(o)]))].sort()).toEqual([
        iss(3),
        iss(4),
      ])
      expect(ids(await s.liveChildrenOf([iss(1), only(o)]), tag)).toEqual([iss(2), iss(3)])

      const onMachines = await s.liveWorktreeIssuesOnMachines([MACHINE])
      expect(ids(onMachines.get(MACHINE) ?? [], tag)).toEqual([iss(2)])
      expect(ids(await s.worktreeOwnerCandidates([`${ROOT}/.worktrees/two/src`]), tag)).toEqual([
        iss(2),
      ])
      expect(await s.issuesMissingRepoId()).toBe(0)
    }
  })

  it('answers the listing reads with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [tag, at] of pairs) {
      const s = stores[at].issues
      const o = other(tag)
      const live = [1, 2, 3, 5].map(iss).sort()

      expect(ids(await s.listIssueRowsWhere(LIVE), tag)).toEqual(live)
      expect(
        ids(await s.listIssueRowsWhere({ ...LIVE, repo: true }, { repoId: REPO }), tag),
      ).toEqual(live)
      expect(ids(await s.listIssueRowsWhere({ ...LIVE, state: 'blocked' }), tag)).toEqual([])
      expect(ids(await s.listIssueRowsWhere({ ...LIVE, state: 'closed' }), tag)).toEqual([iss(3)])
      expect(
        ids(await s.listIssueRowsWhere({ ...LIVE, label: true }, { label: 'bug' }), tag),
      ).toEqual([iss(1)])
      // `ui` is a label only A holds.
      expect(
        ids(await s.listIssueRowsWhere({ ...LIVE, label: true }, { label: 'ui' }), tag),
      ).toEqual(tag === 'a' ? [iss(1)] : [])
      expect(
        ids(
          await s.listIssueRowsWhere({ ...LIVE, parents: 1 }, { parents: [iss(1), only(o)] }),
          tag,
        ),
      ).toEqual([iss(2), iss(3)])
      expect(
        ids(await s.listIssueRowsWhere({ ...LIVE, ids: 1 }, { ids: [iss(5), only(o)] }), tag),
      ).toEqual([iss(5)])
      expect(ids(await s.listIssueRowsWhere({ ...LIVE, topLevel: true }), tag)).toEqual([
        iss(1),
        iss(5),
      ])

      const groups = await s.countIssueGroups(LIVE)
      expect(groups.reduce((n, g) => n + g.n, 0)).toBe(4)
      expect(new Set(groups.map((g) => g.assignee))).toEqual(new Set([owner(tag)]))
      expect(await s.issueStatTotals(LIVE)).toEqual({ total: 4, closed: 1, ready: 3, blocked: 0 })
      expect((await s.deferralsIn(LIVE)).map((d) => d.id)).toEqual([iss(1)])

      expect(ids(await s.sortScope({ parentId: iss(1) }), tag)).toEqual([iss(2), iss(3)])
      expect(ids(await s.sortScope({ repoId: REPO }), tag)).toEqual([iss(1), iss(5)])
      expect(ids(await s.sortScope({ repoId: REPO, unpinnedFor: owner(tag) }), tag)).toEqual([
        iss(1),
        iss(5),
      ])

      expect([...(await s.labelsOfIssues([iss(1), only(o)])).entries()]).toEqual([
        [iss(1), labelsOf(tag)],
      ])
      expect((await s.depsFromIssues([iss(2), only(o)])).map((d) => d.toId).sort()).toEqual([
        iss(1),
        iss(3),
      ])
      expect((await s.depsToIssues([iss(3), only(o)])).map((d) => d.fromId)).toEqual([iss(2)])
      expect([...(await s.commentCountsOfIssues([iss(1), only(o)])).entries()]).toEqual([
        [iss(1), 1],
      ])
    }
  })

  it('answers the label, dependency, comment, history and mail reads with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [tag, at] of pairs) {
      const s = stores[at].issues
      const atOf = AT_OF[tag]

      const vocabulary = await s.listLabels()
      expect(vocabulary.map((l) => l.name)).toEqual(labelsOf(tag))
      expect([...(await s.findLabels(['bug', 'ui'])).keys()]).toEqual(labelsOf(tag))
      const own = vocabulary.map((l) => l.id)
      const theirs = (await stores[at === 0 ? 1 : 0].issues.listLabels()).map((l) => l.id)
      expect(await s.issueIdsOfLabels([...own, ...theirs])).toEqual([iss(1)])
      expect(await s.getIssueLabels(iss(1))).toEqual(labelsOf(tag))

      expect((await s.listIssueDeps(iss(2))).map((d) => d.toId).sort()).toEqual([iss(1), iss(3)])
      expect((await s.listAllIssueDeps()).map((d) => d.fromId)).toEqual([iss(2), iss(2)])
      expect((await s.listDependents(iss(3))).map((d) => d.fromId)).toEqual([iss(2)])

      const comments = await s.listIssueComments(iss(1))
      expect(comments.map((c) => [c.id, c.body])).toEqual([[comment(1), `${tag} needle one`]])
      expect((await s.getIssueComment(comment(1)))?.body).toBe(`${tag} needle one`)
      expect(await s.countIssueComments(iss(1))).toBe(1)
      expect([...(await s.countIssueCommentsByIssue()).entries()].sort()).toEqual([
        [iss(1), 1],
        [iss(2), 1],
      ])
      const found = await s.searchIssueComments('needle', null)
      expect(found.map((c) => c.issueId).sort()).toEqual([iss(1), iss(2)])
      onlyOwn(found, tag)
      onlyOwn(await s.searchIssueComments('needle', 1), tag)

      const history = await s.listIssueTextRevisions(iss(1), 'description')
      expect(history.map((r) => r.body)).toEqual([`${tag} text first`])
      expect(await s.hasIssueTextRevisions(iss(1), 'description')).toBe(true)
      expect(await s.hasIssueTextRevisions(iss(5), 'description')).toBe(false)
      expect((await s.getIssueTextRevision(history[0]!.id))?.body).toBe(`${tag} text first`)
      // A revision's id is the table's own number, so the other workspace's is an id only it
      // holds.
      const theirHistory = await stores[at === 0 ? 1 : 0].issues.listIssueTextRevisions(
        iss(1),
        'description',
      )
      expect(theirHistory[0]!.id).not.toBe(history[0]!.id)
      expect(await s.getIssueTextRevision(theirHistory[0]!.id)).toBeUndefined()

      expect((await s.getIssueMessage(message(1)))?.body).toBe(`${tag} mail 1`)
      const mail = await s.listIssueMessages(iss(1))
      expect(mail.map((m) => [m.id, m.body])).toEqual([
        [message(1), `${tag} mail 1`],
        [message(2), `${tag} mail 2`],
      ])
      expect(idsOf(await s.listIssueMessages(iss(1), { status: 'unread' }), tag)).toEqual([
        message(2),
      ])
      expect(await s.countUnreadIssueMessages(iss(1))).toBe(1)
      const readAt = await s.listIssueMessageReadAt(ALICE)
      expect(Object.keys(readAt)).toEqual([message(1)])
      onlyOwn(readAt, tag)
      expect(JSON.stringify(readAt)).toContain(atOf)
    }
  })

  it('answers the marker reads with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [tag, at] of pairs) {
      const s = stores[at].issues
      const atOf = AT_OF[tag]
      const everyone = await s.listIssueUserStateRows()
      expect(everyone.map((r) => r.userId).sort()).toEqual([ALICE, BOB].sort())
      onlyOwn(everyone, tag)
      expect((await s.listIssueUserStateRows(iss(1))).map((r) => r.userId)).toEqual([ALICE])
      expect((await s.getIssueUserState(ALICE, iss(1)))?.readAt).toBe(atOf)
      expect((await s.loadIssueUserState(ALICE, iss(1)))?.readAt).toBe(atOf)
      const states = await s.loadIssueUserStates(ALICE, [iss(1), only(other(tag))])
      expect(states.get(iss(1))?.readAt).toBe(atOf)
      expect(states.get(only(other(tag)))).toBeUndefined()
      // The answer is keyed by issue: one pair per issue.
      const ofPairs = await s.loadIssueUserStatesOfPairs([
        { userId: BOB, issueId: iss(2) },
        { userId: ALICE, issueId: only(other(tag)) },
      ])
      expect([...ofPairs.values()].filter(Boolean).map((v) => v?.tuckedAt)).toEqual([atOf])
    }
  })

  it('answers the panel and git state reads with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [tag, at] of pairs) {
      const panel = stores[at].issues.panel
      const git = stores[at].issues.gitStates
      const o = other(tag)

      expect(await panel.hasId('issuePanelTodo', todo(1))).toBe(true)
      expect(await panel.hasId('issuePanelTodo', todo(2))).toBe(false)
      for (const [kind, own] of [
        ['issuePanelTodo', todo(1)],
        ['issuePanelArtifact', artifact(1)],
        ['issuePanelDeferred', deferred(1)],
        ['issuePanelState', iss(1)],
      ] as const) {
        expect(idsOf(await panel.getMany(kind, [own, only(o)]), tag)).toEqual([own])
        const forIssues = await panel.forIssues(kind, [iss(1), only(o)])
        expect(idsOf(forIssues, tag)).toEqual([own])
        expect(JSON.stringify(forIssues)).not.toContain('workspace')
        const paged: { id: string }[] = []
        for await (const page of panel.pages(kind, 1)) paged.push(...page)
        expect(idsOf(paged, tag)).toEqual([own])
      }
      const read = await panel.readMany([iss(1), only(o)])
      expect(read.get(iss(1))?.panel.todos.map((t) => t.text)).toEqual([`${tag} todo`])
      expect(read.get(only(o))).toEqual({
        panel: { todos: [], artifacts: [], deferred: [] },
        state: undefined,
      })
      expect((await panel.read(iss(1))).todos.map((t) => t.text)).toEqual([`${tag} todo`])
      expect((await panel.read(iss(1))).artifacts.map((t) => t.path)).toEqual([
        `${tag}-artifact.png`,
      ])
      expect((await panel.state(iss(1)))?.text).toBe(`${tag} state`)
      // The next position follows its own items: A's at 0, B's at 1.
      for (const kind of ['issuePanelTodo', 'issuePanelArtifact', 'issuePanelDeferred'] as const) {
        expect(await panel.next(kind, iss(1))).toBe(position(tag) + 1)
      }

      const states = await git.getMany([iss(2), only(o)])
      expect([...states.keys()]).toEqual([iss(2)])
      expect(states.get(iss(2))?.branch).toBe(`${tag}-issue-branch`)
      expect((await git.get(iss(2)))?.branch).toBe(`${tag}-issue-branch`)
      const paged: { id: string }[] = []
      for await (const page of git.pages(1)) paged.push(...page)
      expect(idsOf(paged, tag)).toEqual([iss(2)])
    }
  })
})

describe('issue numbers count per workspace and repository', () => {
  it('allocates the next number from its own workspace only', async () => {
    const [a, b] = await twoSeeded()
    // The same repository in both, five issues each.
    expect(await a.issues.nextIssueSeq(REPO)).toBe(6)
    expect(await b.issues.nextIssueSeq(REPO)).toBe(6)
    await b.issues.upsertIssue(scope, issue('b', 6, { seq: 6 }))
    expect(await b.issues.nextIssueSeq(REPO)).toBe(7)
    expect(await a.issues.nextIssueSeq(REPO)).toBe(6)
    // A repository only B holds starts at 1 in A.
    await b.issues.upsertIssue(
      scope,
      issue('b', 7, { id: only('b'), repoId: asRepoId('only-b-repo'), seq: 1 }),
    )
    expect(await a.issues.nextIssueSeq(asRepoId('only-b-repo'))).toBe(1)
    expect(await b.issues.nextIssueSeq(asRepoId('only-b-repo'))).toBe(2)
  })

  it('renumbers and re-keys only its own workspace', async () => {
    const [a, b] = await twoSeeded()
    expect(await a.issues.renumberCollidingIssueSeqs()).toBe(0)
    // A path only B holds issues under: A holds nothing there.
    await b.issues.upsertIssue(scope, issue('b', 6, { id: only('b'), repoPath: '/only-b' }))
    const withOnly = rowsOf(a, 'b')
    await a.issues.assignRepoIdToIssuesUnder(asRepoId('merged'), '/only-b')
    expect(rowsOf(a, 'b')).toEqual(withOnly)
    // The root both hold: A's rows take the repository, B's keep theirs.
    await a.issues.assignRepoIdToIssuesUnder(asRepoId('merged'), ROOT)
    expect((await a.issues.getIssue(iss(1)))?.repoId).toBe('merged')
    expect((await b.issues.getIssue(iss(1)))?.repoId).toBe(REPO)
    expect(await a.issues.nextIssueSeq(asRepoId('merged'))).toBe(6)
    expect(await b.issues.nextIssueSeq(asRepoId('merged'))).toBe(1)
    expect(rowsOf(a, 'b')).toEqual(withOnly)
  })
})

describe("a write in one workspace leaves the other's rows unchanged", () => {
  it('finds nothing to change when aimed at ids only the other workspace holds', async () => {
    const [a, b] = await twoSeeded()
    const s = a.issues
    // B's issue 2 waits in review, A's of the same id does not, so only the workspace term
    // fences A's transition off B's row.
    await b.issues.upsertIssue(scope, issue('b', 2, { stage: 'review', revision: 2 }))
    // Ids only B holds: an issue with a dependency, comments, mail, markers and panel items.
    const ONLY = only('b')
    const ONLY_2 = asIssueId('only-b-2')
    await b.issues.upsertIssue(scope, issue('b', 6, { id: ONLY, seq: 6 }))
    await b.issues.upsertIssue(scope, issue('b', 7, { id: ONLY_2, seq: 7, parentId: ONLY }))
    await b.issues.addIssueDep(ONLY_2, ONLY)
    for (const n of [1, 2]) {
      await b.issues.addIssueComment({
        id: `only-b-comment-${n}`,
        issueId: ONLY,
        author: BOB,
        body: `b only comment ${n}`,
        createdAt: AT_OF.b,
      })
      await b.issues.addIssueMessage({
        id: `only-b-mail-${n}`,
        issueId: ONLY,
        fromAuthor: BOB,
        body: `b only mail ${n}`,
        createdAt: AT_OF.b,
        status: 'unread',
        claimedBy: null,
        claimedAt: null,
      })
    }
    await b.issues.setIssueUserState(scope, ALICE, ONLY, { readAt: AT_OF.b })
    const onlyItem = (kind: string) => asIssuePanelItemId(`only-b-${kind}`)
    await b.issues.panel.save(scope, 'issuePanelTodo', {
      id: onlyItem('todo'),
      issueId: ONLY,
      position: 0,
      text: 'b only todo',
      done: false,
    })
    await b.issues.panel.save(scope, 'issuePanelArtifact', {
      id: onlyItem('artifact'),
      issueId: ONLY,
      position: 0,
      path: 'b-only.png',
      addedAt: AT_OF.b,
    })
    await b.issues.panel.save(scope, 'issuePanelDeferred', {
      id: onlyItem('deferred'),
      issueId: ONLY,
      position: 0,
      text: 'b only deferred',
      addedAt: AT_OF.b,
    })
    const before = rowsOf(a, 'b')

    await expect(s.transitionShippingStage(iss(2), 'review', 'shipping', LATER)).rejects.toThrow(
      /fence failed/,
    )
    await s.deleteIssue(ONLY)
    await s.removeIssueDep(ONLY_2, ONLY, 'blocked-by')
    await s.editIssueComment({
      id: 'only-b-comment-1',
      body: 'overwritten',
      editedAt: LATER,
      editedBy: ALICE,
      editedOnBehalfOf: null,
    })
    await s.deleteIssueComment('only-b-comment-2')
    await s.markIssueMessagesRead(null, ONLY, ['only-b-mail-2'], LATER)
    expect(await s.claimIssueMessage('only-b-mail-2', 'a-claimer', LATER)).toBe(false)
    await s.purgeIssueUserState(ONLY)
    await s.deleteIssueMessagesForIssue(ONLY)
    await s.deleteIssueChildRows(ONLY)
    await s.deleteIssueChildRows(ONLY_2)
    await s.panel.remove(scope, 'issuePanelTodo', ONLY, onlyItem('todo'))
    await s.panel.remove(scope, 'issuePanelArtifact', ONLY, onlyItem('artifact'))
    await s.panel.remove(scope, 'issuePanelDeferred', ONLY, onlyItem('deferred'))
    expect(await s.panel.clearTodos(scope, ONLY)).toEqual([])
    expect(await s.panel.toggle(scope, ONLY, onlyItem('todo'), true)).toBeUndefined()

    expect(rowsOf(a, 'b')).toEqual(before)
    expect((await a.issues.getIssue(iss(2)))?.stage).toBe('in_progress')
  })

  it('deleting an issue clears exactly the references to it, in its own workspace only (the same ids in both)', async () => {
    // `same-6` is pointed at by `same-7` (parent, superseded by, duplicate of); `same-8` points
    // at the workspace's issue 1, which nothing deletes. On SQLite a trigger clears the
    // references, on Postgres the keys' ON DELETE SET NULL (column); both keep workspace_id.
    const same = (n: number) => asIssueId(`same-${n}`)
    const [a, b] = await twoSeeded()
    for (const [store, tag] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      await store.issues.upsertIssue(scope, issue(tag, 6, { id: same(6) }))
      await store.issues.upsertIssue(
        scope,
        issue(tag, 7, {
          id: same(7),
          parentId: same(6),
          supersededBy: same(6),
          duplicateOf: same(6),
        }),
      )
      await store.issues.upsertIssue(scope, issue(tag, 8, { id: same(8), parentId: iss(1) }))
    }
    const refs = async (store: SessionStore, n: number) => {
      const row = await store.issues.getIssue(same(n))
      return (
        row && {
          parentId: row.parentId,
          supersededBy: row.supersededBy,
          duplicateOf: row.duplicateOf,
        }
      )
    }
    const before = rowsOf(b, 'b')

    await a.issues.deleteIssue(same(6))

    expect(await a.issues.getIssue(same(6))).toBeNull()
    expect(await refs(a, 7)).toEqual({ parentId: null, supersededBy: null, duplicateOf: null })
    expect(await refs(a, 8)).toEqual({
      parentId: iss(1),
      supersededBy: null,
      duplicateOf: null,
    })
    // B's issue of the same id, and the references to it, are where they were.
    expect((await b.issues.getIssue(same(6)))?.title).toBe('b issue 6')
    expect(await refs(b, 7)).toEqual({
      parentId: same(6),
      supersededBy: same(6),
      duplicateOf: same(6),
    })
    expect(rowsOf(b, 'b')).toEqual(before)
  })

  it('changes only its own rows when writing the ids both hold', async () => {
    const [a, b] = await twoSeeded()
    const s = a.issues
    const before = rowsOf(a, 'b')

    await s.upsertIssue(scope, issue('a', 1, { title: 'a renamed', revision: 2 }))
    await s.upsertIssue(scope, issue('a', 2, { stage: 'review', revision: 2 }))
    const shipped = await s.transitionShippingStage(iss(2), 'review', 'shipping', LATER)
    expect(shipped.stage).toBe('shipping')
    await s.defineLabel({ name: 'bug', color: 'violet' })
    await s.setIssueLabels(iss(2), ['ui'])
    await s.removeIssueDep(iss(2), iss(3))
    await s.addIssueDep(iss(5), iss(1))
    await s.editIssueComment({
      id: comment(1),
      body: 'a edited',
      editedAt: LATER,
      editedBy: ALICE,
      editedOnBehalfOf: null,
    })
    await s.deleteIssueComment(comment(2))
    await s.markIssueMessagesRead(ALICE, iss(1), [message(2)], LATER)
    expect(await s.claimIssueMessage(message(1), 'a-claimer', LATER)).toBe(true)
    await s.setIssueUserState(scope, ALICE, iss(1), { tuckedAt: LATER })
    expect(await s.allocateSessionLetter(iss(1))).toBe('B')
    await s.panel.save(scope, 'issuePanelTodo', {
      id: todo(2),
      issueId: iss(1),
      position: 1,
      text: 'a second todo',
      done: false,
    })
    const toggled = (await s.panel.toggle(scope, iss(1), todo(1), true)) as
      | IssuePanelTodoWire
      | undefined
    expect(toggled).toEqual({
      id: todo(1),
      issueId: iss(1),
      position: 0,
      text: 'a todo',
      done: true,
    })
    expect((await s.panel.clearTodos(scope, iss(1))).sort()).toEqual([todo(1), todo(2)])
    await s.panel.remove(scope, 'issuePanelArtifact', iss(1), artifact(1))
    await s.gitStates.set(scope, iss(2), {
      updatedAt: LATER,
      branch: 'a-moved',
      shared: false,
      dirtyFiles: 9,
    })
    await s.purgeIssueUserState(iss(2))
    await s.deleteIssueMessagesForIssue(iss(1))
    await s.deleteIssueChildRows(iss(1))
    await s.deleteIssue(iss(3))
    expect(await s.hasIssue(iss(3))).toBe(false)

    expect(rowsOf(a, 'b')).toEqual(before)
    // B still reads everything it wrote, at the same ids.
    expect(await b.issues.getIssueLabels(iss(1))).toEqual(labelsOf('b'))
    expect((await b.issues.getIssue(iss(1)))?.title).toBe('b issue 1')
    expect((await b.issues.getIssue(iss(3)))?.title).toBe('b issue 3')
    expect((await b.issues.getIssueComment(comment(2)))?.body).toBe('b needle two')
    expect((await b.issues.panel.read(iss(1))).todos.map((t) => [t.text, t.done])).toEqual([
      ['b todo', false],
    ])
    expect((await b.issues.gitStates.get(iss(2)))?.branch).toBe('b-issue-branch')
    expect(await b.issues.allocateSessionLetter(iss(1))).toBe('B')
  })

  it('prunes only its own orphan letters', async () => {
    const [a] = await twoSeeded()
    // An orphan of the same id in each workspace: a counter whose issue is gone.
    for (const tag of TAGS) {
      rawDb(a)
        .prepare(
          'INSERT INTO issue_ref_letters (workspace_id, issue_id, next_index) VALUES (?, ?, 3)',
        )
        .run(WS[tag], 'iss-gone')
    }
    const before = rowsOf(a, 'b')
    // A's own counter survives: its issue is A's. B's counters, the orphan included, are B's.
    expect(await a.issues.pruneOrphanRefLetters()).toBe(1)
    expect(rowsOf(a, 'b')).toEqual(before)
    expect(
      rawDb(a).prepare("SELECT issue_id FROM issue_ref_letters WHERE workspace_id = 'ws_a'").all(),
    ).toEqual([{ issue_id: iss(1) }])
  })

  it('backfills the legacy worktrees of its own workspace, on its own host', async () => {
    const [a, b] = await twoSeeded()
    rawDb(a).prepare("DELETE FROM meta WHERE key = 'legacy_worktree_machine_ids_v1'").run()
    // A machine only B holds is no host of A's.
    insertMachine(b, 'b', 'only-b-machine')
    const before = rowsOf(a, 'b')
    expect(
      await a.issues.backfillLegacyWorktreeMachineIds(asMachineId('only-b-machine')),
    ).toBeUndefined()
    // The machine both hold: A's issue 5 gets it, B's of the same id does not.
    expect(await a.issues.backfillLegacyWorktreeMachineIds(MACHINE)).toEqual({
      hostMachineId: MACHINE,
      backfilled: 1,
      skipped: 0,
    })
    expect((await a.issues.getIssue(iss(5)))?.machineId).toBe(MACHINE)
    expect(rowsOf(a, 'b')).toEqual(before)
    expect((await b.issues.getIssue(iss(5)))?.machineId).toBeNull()
  })
})

/**
 * THE SAME ID UPSERTED FIRST IN THE OTHER WORKSPACE (POD-7024): every ON CONFLICT target leads with workspace_id,
 * so an upsert in A of an id B already holds makes A its own row, B's row stays byte for byte
 * as it was, and A's second upsert of the id updates A's row only.
 */
describe('the same id in both workspaces, upserted through the repository (POD-7024)', () => {
  it("makes a second row, leaves the other workspace's as it was, and updates only its own", async () => {
    const rowsIn = (store: SessionStore, ws: string) =>
      rawDb(store)
        .prepare('SELECT * FROM issues WHERE workspace_id = ? AND id = ? ORDER BY rowid')
        .all(ws, SAME)
    const SAME = asIssueId('same-issue')
    const [a, b] = await twoSeeded()
    await b.issues.upsertIssue(scope, issue('b', 6, { id: SAME }))
    const before = rowsIn(b, WS.b)
    await a.issues.upsertIssue(scope, issue('a', 6, { id: SAME }))
    expect(rowsIn(a, WS.a)).toHaveLength(1)
    expect(rowsIn(b, WS.b)).toEqual(before)
    await a.issues.upsertIssue(scope, issue('a', 6, { id: SAME, title: 'a retitled', revision: 2 }))
    expect((await a.issues.getIssue(SAME))?.title).toBe('a retitled')
    expect((await b.issues.getIssue(SAME))?.title).toBe('b issue 6')
    expect(rowsIn(b, WS.b)).toEqual(before)
  })
})
