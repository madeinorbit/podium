/**
 * ISSUES ARE A WORKSPACE'S (POD-6959 design 2.4, 2.5; task POD-7016).
 *
 * Two workspaces over one database (`openWorkspaceStores`), each seeded through its own
 * repositories with its own issues, labels, dependencies, comments, text history, mail,
 * markers, session letters, panel records and git states.
 * The ids differ between the workspaces, so a read or write aimed at the other workspace's ids
 * has ids only that workspace holds to miss. Since the key migration (POD-7024) every key
 * leads with workspace_id and the same id is two rows; the cases that hold the same ids in
 * both are marked below, and the rest of the conversion is POD-7025's.
 *
 * For every repository method of the group (issues.ts with its listings, the panel and the git
 * states):
 *   - a read answers only its own workspace's rows;
 *   - an update, delete or upsert in one workspace leaves the other's rows unchanged, including
 *     a write in A addressed at B's own ids, which must find nothing to change;
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
  type MachineId,
  type RepoId,
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
const AT = '2026-11-17T10:00:00.000Z'
const LATER = '2026-11-17T11:00:00.000Z'
const scope = fixtureWriteScope()

const other = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
const user = (tag: Tag, name = 'alice'): UserId => asUserId(`user:${tag}-${name}`)
const iss = (tag: Tag, n: number): IssueId => asIssueId(`${tag}-iss-${n}`)
const repo = (tag: Tag): RepoId => asRepoId(`${tag}-repo`)
const root = (tag: Tag) => `/repo-${tag}`
const machine = (tag: Tag): MachineId => asMachineId(`${tag}-machine`)
const label = (tag: Tag, name: string) => `${tag}-${name}`
const comment = (tag: Tag, n: number) => `${tag}-comment-${n}`
const message = (tag: Tag, n: number) => `${tag}-mail-${n}`
const todo = (tag: Tag, n: number) => asIssuePanelItemId(`${tag}-todo-${n}`)
const artifact = (tag: Tag, n: number) => asIssuePanelItemId(`${tag}-artifact-${n}`)
const deferred = (tag: Tag, n: number) => asIssuePanelItemId(`${tag}-deferred-${n}`)

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

/** Every string in `value` that names a seeded thing starts with the workspace's tag. */
function onlyOwn(value: unknown, tag: Tag): void {
  const text = JSON.stringify(value)
  expect(text).not.toMatch(
    new RegExp(
      `\\b${other(tag)}-(iss-|repo|machine|alice|bob|bug|ui|comment|mail|todo|artifact|deferred|issue|text)|"${other(tag)} `,
    ),
  )
}

/**
 * One workspace's issues, in its own repository `<tag>-repo` at `/repo-<tag>`:
 *   1 parent, open, top level, labels bug+ui, deferred;
 *   2 child of 1, blocked by 3, with a worktree on the machine;
 *   3 child of 1, done;
 *   4 top level, deleted;
 *   5 top level, a legacy worktree with no machine.
 */
function issue(tag: Tag, n: number, patch: Partial<IssueRow> = {}): IssueRow {
  return issueRowFixture({
    id: iss(tag, n),
    ownerUserId: user(tag),
    createdByActor: user(tag),
    createdByOnBehalfOf: user(tag),
    repoPath: root(tag),
    repoId: repo(tag),
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

async function seed(store: SessionStore, tag: Tag): Promise<void> {
  const s = store.issues
  const raw = rawDb(store)
  raw
    .prepare(
      `INSERT INTO machines (workspace_id, id, name, hostname, token_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(WS[tag], machine(tag), `${tag} machine`, `${tag}-host`, `${tag}-token`, AT, AT)
  await s.upsertIssue(scope, issue(tag, 1, { deferUntil: LATER, sortKey: 'm' }))
  await s.upsertIssue(
    scope,
    issue(tag, 2, {
      parentId: iss(tag, 1),
      stage: 'in_progress',
      worktreePath: `${root(tag)}/.worktrees/two`,
      machineId: machine(tag),
    }),
  )
  await s.upsertIssue(scope, issue(tag, 3, { parentId: iss(tag, 1), stage: 'done' }))
  await s.upsertIssue(scope, issue(tag, 4, { deletedAt: AT }))
  await s.upsertIssue(scope, issue(tag, 5, { worktreePath: `${root(tag)}/.worktrees/five` }))

  await s.setIssueLabels(iss(tag, 1), [label(tag, 'bug'), label(tag, 'ui')])
  await s.addIssueDep(iss(tag, 2), iss(tag, 3))
  await s.addIssueDep(iss(tag, 2), iss(tag, 1), 'related')
  await s.addIssueComment({
    id: comment(tag, 1),
    issueId: iss(tag, 1),
    author: user(tag),
    body: `${tag} needle one`,
    createdAt: AT,
  })
  await s.addIssueComment({
    id: comment(tag, 2),
    issueId: iss(tag, 2),
    author: user(tag),
    body: `${tag} needle two`,
    createdAt: LATER,
  })
  await s.appendIssueTextRevision({
    issueId: iss(tag, 1),
    field: 'description',
    body: `${tag} text first`,
    source: 'create',
    restoredFrom: null,
    issueRevision: 1,
    actor: user(tag),
    onBehalfOf: user(tag),
    createdAt: AT,
  })
  for (const n of [1, 2]) {
    await s.addIssueMessage({
      id: message(tag, n),
      issueId: iss(tag, 1),
      fromAuthor: user(tag),
      body: `${tag} mail ${n}`,
      createdAt: n === 1 ? AT : LATER,
      status: 'unread',
      claimedBy: null,
      claimedAt: null,
    })
  }
  await s.markIssueMessagesRead(user(tag), iss(tag, 1), [message(tag, 1)], AT)
  await s.setIssueUserState(scope, user(tag), iss(tag, 1), { readAt: AT })
  await s.setIssueUserState(scope, user(tag, 'bob'), iss(tag, 2), { tuckedAt: AT })
  expect(await s.allocateSessionLetter(iss(tag, 1))).toBe('A')

  const panel = s.panel
  await panel.save(scope, 'issuePanelTodo', {
    id: todo(tag, 1),
    issueId: iss(tag, 1),
    position: 0,
    text: `${tag} todo`,
    done: false,
  })
  await panel.save(scope, 'issuePanelArtifact', {
    id: artifact(tag, 1),
    issueId: iss(tag, 1),
    position: 0,
    path: `${tag}-artifact.png`,
    addedAt: AT,
  })
  await panel.save(scope, 'issuePanelDeferred', {
    id: deferred(tag, 1),
    issueId: iss(tag, 1),
    position: 0,
    text: `${tag} deferred`,
    addedAt: AT,
  })
  await panel.save(scope, 'issuePanelState', {
    id: iss(tag, 1),
    text: `${tag} state`,
    updatedAt: AT,
  })
  await s.gitStates.set(scope, iss(tag, 2), {
    updatedAt: AT,
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

const ids = (rows: Iterable<{ id: string }>) => [...rows].map((row) => row.id).sort()
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
    for (const [tag, at] of pairs) {
      const s = stores[at].issues
      const o = other(tag)
      const all = [1, 2, 3, 4, 5].map((n) => iss(tag, n)).sort()
      const live = [1, 2, 3, 5].map((n) => iss(tag, n)).sort()

      expect((await s.getIssue(iss(tag, 1)))?.id).toBe(iss(tag, 1))
      expect(await s.getIssue(iss(o, 1))).toBeNull()
      expect((await s.loadIssue(iss(tag, 2)))?.id).toBe(iss(tag, 2))
      expect(await s.loadIssue(iss(o, 2))).toBeUndefined()
      expect([...(await s.loadIssues([iss(tag, 1), iss(o, 1)])).keys()]).toEqual([iss(tag, 1)])
      expect([...(await s.getIssues([iss(tag, 1), iss(o, 1)])).keys()]).toEqual([iss(tag, 1)])
      expect((await s.getIssueLive(iss(tag, 1)))?.id).toBe(iss(tag, 1))
      expect(await s.getIssueLive(iss(o, 1))).toBeNull()
      expect(await s.hasIssue(iss(tag, 1))).toBe(true)
      expect(await s.hasIssue(iss(o, 1))).toBe(false)

      expect(ids(await s.listIssueRows())).toEqual(all)
      const pages: string[] = []
      for await (const page of s.issueRowPages(2)) pages.push(...page.map((row) => row.id))
      expect(pages.sort()).toEqual(all)
      expect((await s.listIssueParentEdges()).map((e) => e.id).sort()).toEqual(live)

      const refs = await s.issueRefsAtSeqs([1, 2])
      expect([...refs.values()].flat().map((r) => r.id)).toEqual([iss(tag, 1), iss(tag, 2)])
      expect((await s.issueRefsAt(1)).map((r) => r.id)).toEqual([iss(tag, 1)])
      expect((await s.issueRefsAt(1, repo(tag))).map((r) => r.id)).toEqual([iss(tag, 1)])
      expect(await s.issueRefsAt(1, repo(o))).toEqual([])

      const closure = await s.closureOf([iss(tag, 3), iss(o, 3)])
      expect([...closure.keys()]).toEqual([iss(tag, 3)])
      expect(
        [...(await s.closedIssueIdsAmong([iss(tag, 3), iss(tag, 4), iss(o, 3)]))].sort(),
      ).toEqual([iss(tag, 3), iss(tag, 4)])
      expect(ids(await s.liveChildrenOf([iss(tag, 1), iss(o, 1)]))).toEqual([
        iss(tag, 2),
        iss(tag, 3),
      ])

      const onMachines = await s.liveWorktreeIssuesOnMachines([machine(tag), machine(o)])
      expect(ids(onMachines.get(machine(tag)) ?? [])).toEqual([iss(tag, 2)])
      expect(onMachines.get(machine(o))).toEqual([])
      expect(ids(await s.worktreeOwnerCandidates([`${root(tag)}/.worktrees/two/src`]))).toEqual([
        iss(tag, 2),
      ])
      expect(await s.worktreeOwnerCandidates([`${root(o)}/.worktrees/two/src`])).toEqual([])
      expect(await s.issuesMissingRepoId()).toBe(0)
    }
  })

  it('answers the listing reads with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [tag, at] of pairs) {
      const s = stores[at].issues
      const o = other(tag)
      const live = [1, 2, 3, 5].map((n) => iss(tag, n)).sort()

      expect(ids(await s.listIssueRowsWhere(LIVE))).toEqual(live)
      expect(
        ids(await s.listIssueRowsWhere({ ...LIVE, repo: true }, { repoId: repo(tag) })),
      ).toEqual(live)
      expect(await s.listIssueRowsWhere({ ...LIVE, repo: true }, { repoId: repo(o) })).toEqual([])
      expect(ids(await s.listIssueRowsWhere({ ...LIVE, state: 'blocked' }))).toEqual([])
      expect(ids(await s.listIssueRowsWhere({ ...LIVE, state: 'closed' }))).toEqual([iss(tag, 3)])
      expect(
        ids(await s.listIssueRowsWhere({ ...LIVE, label: true }, { label: label(tag, 'bug') })),
      ).toEqual([iss(tag, 1)])
      expect(
        await s.listIssueRowsWhere({ ...LIVE, label: true }, { label: label(o, 'bug') }),
      ).toEqual([])
      expect(
        ids(
          await s.listIssueRowsWhere(
            { ...LIVE, parents: 1 },
            { parents: [iss(tag, 1), iss(o, 1)] },
          ),
        ),
      ).toEqual([iss(tag, 2), iss(tag, 3)])
      expect(
        ids(await s.listIssueRowsWhere({ ...LIVE, ids: 1 }, { ids: [iss(tag, 5), iss(o, 5)] })),
      ).toEqual([iss(tag, 5)])
      expect(ids(await s.listIssueRowsWhere({ ...LIVE, topLevel: true }))).toEqual([
        iss(tag, 1),
        iss(tag, 5),
      ])

      const groups = await s.countIssueGroups(LIVE)
      expect(groups.reduce((n, g) => n + g.n, 0)).toBe(4)
      expect(new Set(groups.map((g) => g.assignee))).toEqual(new Set([user(tag)]))
      expect(await s.issueStatTotals(LIVE)).toEqual({ total: 4, closed: 1, ready: 3, blocked: 0 })
      expect((await s.deferralsIn(LIVE)).map((d) => d.id)).toEqual([iss(tag, 1)])

      expect(ids(await s.sortScope({ parentId: iss(tag, 1) }))).toEqual([iss(tag, 2), iss(tag, 3)])
      expect(await s.sortScope({ parentId: iss(o, 1) })).toEqual([])
      expect(ids(await s.sortScope({ repoId: repo(tag) }))).toEqual([iss(tag, 1), iss(tag, 5)])
      expect(await s.sortScope({ repoId: repo(o) })).toEqual([])
      expect(ids(await s.sortScope({ repoId: repo(tag), unpinnedFor: user(tag) }))).toEqual([
        iss(tag, 1),
        iss(tag, 5),
      ])

      expect([...(await s.labelsOfIssues([iss(tag, 1), iss(o, 1)])).entries()]).toEqual([
        [iss(tag, 1), [label(tag, 'bug'), label(tag, 'ui')]],
      ])
      expect((await s.depsFromIssues([iss(tag, 2), iss(o, 2)])).map((d) => d.toId).sort()).toEqual([
        iss(tag, 1),
        iss(tag, 3),
      ])
      expect((await s.depsToIssues([iss(tag, 3), iss(o, 3)])).map((d) => d.fromId)).toEqual([
        iss(tag, 2),
      ])
      expect([...(await s.commentCountsOfIssues([iss(tag, 1), iss(o, 1)])).entries()]).toEqual([
        [iss(tag, 1), 1],
      ])
    }
  })

  it('answers the label, dependency, comment, history and mail reads with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [tag, at] of pairs) {
      const s = stores[at].issues
      const o = other(tag)

      const vocabulary = await s.listLabels()
      expect(vocabulary.map((l) => l.name)).toEqual([label(tag, 'bug'), label(tag, 'ui')])
      expect([...(await s.findLabels([label(tag, 'bug'), label(o, 'bug')])).keys()]).toEqual([
        label(tag, 'bug'),
      ])
      const own = vocabulary.map((l) => l.id)
      const theirs = (await stores[at === 0 ? 1 : 0].issues.listLabels()).map((l) => l.id)
      expect(await s.issueIdsOfLabels([...own, ...theirs])).toEqual([iss(tag, 1)])
      expect(await s.getIssueLabels(iss(tag, 1))).toEqual([label(tag, 'bug'), label(tag, 'ui')])
      expect(await s.getIssueLabels(iss(o, 1))).toEqual([])

      expect((await s.listIssueDeps(iss(tag, 2))).map((d) => d.toId).sort()).toEqual([
        iss(tag, 1),
        iss(tag, 3),
      ])
      expect(await s.listIssueDeps(iss(o, 2))).toEqual([])
      expect((await s.listAllIssueDeps()).map((d) => d.fromId)).toEqual([iss(tag, 2), iss(tag, 2)])
      expect((await s.listDependents(iss(tag, 3))).map((d) => d.fromId)).toEqual([iss(tag, 2)])
      expect(await s.listDependents(iss(o, 3))).toEqual([])

      expect(ids(await s.listIssueComments(iss(tag, 1)))).toEqual([comment(tag, 1)])
      expect(await s.listIssueComments(iss(o, 1))).toEqual([])
      expect((await s.getIssueComment(comment(tag, 1)))?.id).toBe(comment(tag, 1))
      expect(await s.getIssueComment(comment(o, 1))).toBeUndefined()
      expect(await s.countIssueComments(iss(tag, 1))).toBe(1)
      expect(await s.countIssueComments(iss(o, 1))).toBe(0)
      expect([...(await s.countIssueCommentsByIssue()).keys()].sort()).toEqual([
        iss(tag, 1),
        iss(tag, 2),
      ])
      const found = await s.searchIssueComments('needle', null)
      expect(found.map((c) => c.issueId).sort()).toEqual([iss(tag, 1), iss(tag, 2)])
      onlyOwn(await s.searchIssueComments('needle', 1), tag)

      const history = await s.listIssueTextRevisions(iss(tag, 1), 'description')
      expect(history.map((r) => r.body)).toEqual([`${tag} text first`])
      expect(await s.listIssueTextRevisions(iss(o, 1), 'description')).toEqual([])
      expect(await s.hasIssueTextRevisions(iss(tag, 1), 'description')).toBe(true)
      expect(await s.hasIssueTextRevisions(iss(o, 1), 'description')).toBe(false)
      expect((await s.getIssueTextRevision(history[0]!.id))?.body).toBe(`${tag} text first`)
      const theirHistory = await stores[at === 0 ? 1 : 0].issues.listIssueTextRevisions(
        iss(o, 1),
        'description',
      )
      expect(await s.getIssueTextRevision(theirHistory[0]!.id)).toBeUndefined()

      expect((await s.getIssueMessage(message(tag, 1)))?.id).toBe(message(tag, 1))
      expect(await s.getIssueMessage(message(o, 1))).toBeNull()
      expect(ids(await s.listIssueMessages(iss(tag, 1)))).toEqual([
        message(tag, 1),
        message(tag, 2),
      ])
      expect(ids(await s.listIssueMessages(iss(tag, 1), { status: 'unread' }))).toEqual([
        message(tag, 2),
      ])
      expect(await s.listIssueMessages(iss(o, 1))).toEqual([])
      expect(await s.countUnreadIssueMessages(iss(tag, 1))).toBe(1)
      expect(await s.countUnreadIssueMessages(iss(o, 1))).toBe(0)
      expect(Object.keys(await s.listIssueMessageReadAt(user(tag)))).toEqual([message(tag, 1)])
      expect(await s.listIssueMessageReadAt(user(o))).toEqual({})
    }
  })

  it('answers the marker reads with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [tag, at] of pairs) {
      const s = stores[at].issues
      const o = other(tag)
      const everyone = await s.listIssueUserStateRows()
      expect(everyone.map((r) => r.userId).sort()).toEqual([user(tag), user(tag, 'bob')])
      expect((await s.listIssueUserStateRows(iss(tag, 1))).map((r) => r.userId)).toEqual([
        user(tag),
      ])
      expect(await s.listIssueUserStateRows(iss(o, 1))).toEqual([])
      expect((await s.getIssueUserState(user(tag), iss(tag, 1)))?.readAt).toBe(AT)
      expect(await s.getIssueUserState(user(o), iss(o, 1))).toBeUndefined()
      expect((await s.loadIssueUserState(user(tag), iss(tag, 1)))?.readAt).toBe(AT)
      expect(await s.loadIssueUserState(user(o), iss(o, 1))).toBeUndefined()
      const states = await s.loadIssueUserStates(user(tag), [iss(tag, 1), iss(o, 1)])
      expect(states.get(iss(tag, 1))?.readAt).toBe(AT)
      expect(states.get(iss(o, 1))).toBeUndefined()
      const ofPairs = await s.loadIssueUserStatesOfPairs([
        { userId: user(tag, 'bob'), issueId: iss(tag, 2) },
        { userId: user(o, 'bob'), issueId: iss(o, 2) },
      ])
      expect([...ofPairs.values()].filter(Boolean).map((v) => v?.tuckedAt)).toEqual([AT])
    }
  })

  it('answers the panel and git state reads with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [tag, at] of pairs) {
      const panel = stores[at].issues.panel
      const git = stores[at].issues.gitStates
      const o = other(tag)

      expect(await panel.hasId('issuePanelTodo', todo(tag, 1))).toBe(true)
      expect(await panel.hasId('issuePanelTodo', todo(o, 1))).toBe(false)
      expect(await panel.hasId('issuePanelArtifact', artifact(o, 1))).toBe(false)
      expect(await panel.hasId('issuePanelDeferred', deferred(o, 1))).toBe(false)
      for (const [kind, own, theirs] of [
        ['issuePanelTodo', todo(tag, 1), todo(o, 1)],
        ['issuePanelArtifact', artifact(tag, 1), artifact(o, 1)],
        ['issuePanelDeferred', deferred(tag, 1), deferred(o, 1)],
        ['issuePanelState', iss(tag, 1), iss(o, 1)],
      ] as const) {
        expect(ids(await panel.getMany(kind, [own, theirs]))).toEqual([own])
        const forIssues = await panel.forIssues(kind, [iss(tag, 1), iss(o, 1)])
        expect(ids(forIssues)).toEqual([own])
        expect(JSON.stringify(forIssues)).not.toContain('workspace')
        const paged: string[] = []
        for await (const page of panel.pages(kind, 1)) paged.push(...page.map((r) => r.id))
        expect(paged).toEqual([own])
      }
      const read = await panel.readMany([iss(tag, 1), iss(o, 1)])
      expect(read.get(iss(o, 1))).toEqual({
        panel: { todos: [], artifacts: [], deferred: [] },
        state: undefined,
      })
      expect((await panel.read(iss(tag, 1))).todos.map((t) => t.text)).toEqual([`${tag} todo`])
      expect((await panel.state(iss(tag, 1)))?.text).toBe(`${tag} state`)
      expect(await panel.state(iss(o, 1))).toBeUndefined()
      expect(await panel.next('issuePanelTodo', iss(tag, 1))).toBe(1)
      expect(await panel.next('issuePanelTodo', iss(o, 1))).toBe(0)
      expect(await panel.next('issuePanelArtifact', iss(o, 1))).toBe(0)
      expect(await panel.next('issuePanelDeferred', iss(o, 1))).toBe(0)

      expect([...(await git.getMany([iss(tag, 2), iss(o, 2)])).keys()]).toEqual([iss(tag, 2)])
      expect((await git.get(iss(tag, 2)))?.branch).toBe(`${tag}-issue-branch`)
      expect(await git.get(iss(o, 2))).toBeUndefined()
      const paged: string[] = []
      for await (const page of git.pages(1)) paged.push(...page.map((r) => r.id))
      expect(paged).toEqual([iss(tag, 2)])
    }
  })
})

describe('issue numbers count per workspace and repository', () => {
  it('allocates the next number from its own workspace only', async () => {
    const [a, b] = await twoSeeded()
    expect(await a.issues.nextIssueSeq(repo('a'))).toBe(6)
    // B holds no issue of A's repository, so its count of it starts at 1.
    expect(await b.issues.nextIssueSeq(repo('a'))).toBe(1)
    await b.issues.upsertIssue(scope, issue('b', 6, { repoId: repo('b'), seq: 6 }))
    expect(await b.issues.nextIssueSeq(repo('b'))).toBe(7)
    expect(await a.issues.nextIssueSeq(repo('a'))).toBe(6)
  })

  it('renumbers and re-keys only its own workspace', async () => {
    const [a, b] = await twoSeeded()
    const before = rowsOf(a, 'b')
    expect(await a.issues.renumberCollidingIssueSeqs()).toBe(0)
    // A path under B's root: A holds nothing there, and B's rows keep their repository.
    await a.issues.assignRepoIdToIssuesUnder(asRepoId('a-merged'), root('b'))
    expect(rowsOf(a, 'b')).toEqual(before)
    await a.issues.assignRepoIdToIssuesUnder(asRepoId('a-merged'), root('a'))
    expect((await a.issues.getIssue(iss('a', 1)))?.repoId).toBe('a-merged')
    expect(await a.issues.nextIssueSeq(asRepoId('a-merged'))).toBe(6)
    expect(await b.issues.nextIssueSeq(asRepoId('a-merged'))).toBe(1)
    expect(rowsOf(a, 'b')).toEqual(before)
  })
})

describe("a write in one workspace leaves the other's rows unchanged", () => {
  it("finds nothing to change when aimed at the other workspace's ids", async () => {
    const [a, b] = await twoSeeded()
    const s = a.issues
    // B's issue 2 waits in review, so only the workspace term fences A's transition off it.
    await b.issues.upsertIssue(scope, issue('b', 2, { stage: 'review', revision: 2 }))
    const before = rowsOf(a, 'b')

    await expect(
      s.transitionShippingStage(iss('b', 2), 'review', 'shipping', LATER),
    ).rejects.toThrow(/fence failed/)
    await s.deleteIssue(iss('b', 1))
    await s.removeIssueDep(iss('b', 2), iss('b', 3), 'blocked-by')
    await s.removeIssueDep(iss('b', 2), iss('b', 1))
    await s.editIssueComment({
      id: comment('b', 1),
      body: 'overwritten',
      editedAt: LATER,
      editedBy: user('a'),
      editedOnBehalfOf: null,
    })
    await s.deleteIssueComment(comment('b', 2))
    await s.markIssueMessagesRead(null, iss('b', 1), [message('b', 2)], LATER)
    expect(await s.claimIssueMessage(message('b', 2), 'a-claimer', LATER)).toBe(false)
    await s.purgeIssueUserState(iss('b', 1))
    await s.deleteIssueMessagesForIssue(iss('b', 1))
    await s.deleteIssueChildRows(iss('b', 1))
    await s.deleteIssueChildRows(iss('b', 2))
    await s.panel.remove(scope, 'issuePanelTodo', iss('b', 1), todo('b', 1))
    await s.panel.remove(scope, 'issuePanelArtifact', iss('b', 1), artifact('b', 1))
    await s.panel.remove(scope, 'issuePanelDeferred', iss('b', 1), deferred('b', 1))
    expect(await s.panel.clearTodos(scope, iss('b', 1))).toEqual([])
    expect(await s.panel.toggle(scope, iss('b', 1), todo('b', 1), true)).toBeUndefined()

    expect(rowsOf(a, 'b')).toEqual(before)
  })

  it('deleting an issue clears exactly the references to it, in its own workspace only (the same ids in both)', async () => {
    // THE SAME IDS IN BOTH WORKSPACES (POD-7024): `same-6` is pointed at by `same-7` (parent,
    // superseded by, duplicate of); `same-8` points at the workspace's issue 1, which nothing
    // deletes. On SQLite a trigger clears the references, on Postgres the keys' ON DELETE SET
    // NULL (column); both keep workspace_id.
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
      await store.issues.upsertIssue(scope, issue(tag, 8, { id: same(8), parentId: iss(tag, 1) }))
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
      parentId: iss('a', 1),
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

  it('changes only its own rows when writing its own', async () => {
    const [a, b] = await twoSeeded()
    const s = a.issues
    const before = rowsOf(a, 'b')

    await s.upsertIssue(scope, issue('a', 1, { title: 'a renamed', revision: 2 }))
    await s.upsertIssue(scope, issue('a', 2, { stage: 'review', revision: 2 }))
    const shipped = await s.transitionShippingStage(iss('a', 2), 'review', 'shipping', LATER)
    expect(shipped.stage).toBe('shipping')
    await s.defineLabel({ name: label('a', 'bug'), color: 'violet' })
    await s.setIssueLabels(iss('a', 2), [label('a', 'ui')])
    await s.removeIssueDep(iss('a', 2), iss('a', 3))
    await s.addIssueDep(iss('a', 5), iss('a', 1))
    await s.editIssueComment({
      id: comment('a', 1),
      body: 'a edited',
      editedAt: LATER,
      editedBy: user('a'),
      editedOnBehalfOf: null,
    })
    await s.deleteIssueComment(comment('a', 2))
    await s.markIssueMessagesRead(user('a'), iss('a', 1), [message('a', 2)], LATER)
    expect(await s.claimIssueMessage(message('a', 1), 'a-claimer', LATER)).toBe(true)
    await s.setIssueUserState(scope, user('a'), iss('a', 1), { tuckedAt: LATER })
    expect(await s.allocateSessionLetter(iss('a', 1))).toBe('B')
    await s.panel.save(scope, 'issuePanelTodo', {
      id: todo('a', 2),
      issueId: iss('a', 1),
      position: 1,
      text: 'a second todo',
      done: false,
    })
    const toggled = (await s.panel.toggle(scope, iss('a', 1), todo('a', 1), true)) as
      | IssuePanelTodoWire
      | undefined
    expect(toggled).toEqual({
      id: todo('a', 1),
      issueId: iss('a', 1),
      position: 0,
      text: 'a todo',
      done: true,
    })
    expect((await s.panel.clearTodos(scope, iss('a', 1))).sort()).toEqual([
      todo('a', 1),
      todo('a', 2),
    ])
    await s.panel.remove(scope, 'issuePanelArtifact', iss('a', 1), artifact('a', 1))
    await s.gitStates.set(scope, iss('a', 2), {
      updatedAt: LATER,
      branch: 'a-moved',
      shared: false,
      dirtyFiles: 9,
    })
    await s.purgeIssueUserState(iss('a', 2))
    await s.deleteIssueMessagesForIssue(iss('a', 1))
    await s.deleteIssueChildRows(iss('a', 1))
    await s.deleteIssue(iss('a', 3))
    expect(await s.hasIssue(iss('a', 3))).toBe(false)

    expect(rowsOf(a, 'b')).toEqual(before)
    // B still reads everything it wrote.
    expect(await b.issues.getIssueLabels(iss('b', 1))).toEqual([
      label('b', 'bug'),
      label('b', 'ui'),
    ])
    expect((await b.issues.getIssue(iss('b', 1)))?.title).toBe('b issue 1')
  })

  it('prunes only its own orphan letters', async () => {
    const [a] = await twoSeeded()
    // An orphan in each workspace: a counter whose issue is gone.
    for (const tag of TAGS) {
      rawDb(a)
        .prepare(
          'INSERT INTO issue_ref_letters (workspace_id, issue_id, next_index) VALUES (?, ?, 3)',
        )
        .run(WS[tag], `${tag}-iss-gone`)
    }
    const before = rowsOf(a, 'b')
    // A's own counter survives: its issue is A's. B's counters, the orphan included, are B's.
    expect(await a.issues.pruneOrphanRefLetters()).toBe(1)
    expect(rowsOf(a, 'b')).toEqual(before)
    expect(
      rawDb(a).prepare("SELECT issue_id FROM issue_ref_letters WHERE workspace_id = 'ws_a'").all(),
    ).toEqual([{ issue_id: iss('a', 1) }])
  })

  it('backfills the legacy worktrees of its own workspace, on its own host', async () => {
    const [a, b] = await twoSeeded()
    rawDb(a).prepare("DELETE FROM meta WHERE key = 'legacy_worktree_machine_ids_v1'").run()
    const before = rowsOf(a, 'b')
    // B's machine is no host of A's.
    expect(await a.issues.backfillLegacyWorktreeMachineIds(machine('b'))).toBeUndefined()
    expect(await a.issues.backfillLegacyWorktreeMachineIds(machine('a'))).toEqual({
      hostMachineId: machine('a'),
      backfilled: 1,
      skipped: 0,
    })
    expect((await a.issues.getIssue(iss('a', 5)))?.machineId).toBe(machine('a'))
    expect(rowsOf(a, 'b')).toEqual(before)
    expect((await b.issues.getIssue(iss('b', 5)))?.machineId).toBeNull()
  })
})

/**
 * THE SAME ID IN BOTH WORKSPACES (POD-7024): every ON CONFLICT target leads with workspace_id,
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
