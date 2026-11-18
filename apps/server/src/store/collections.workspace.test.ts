/**
 * THE COLLECTION FETCH READS ONE WORKSPACE [POD-7118, POD-7085].
 *
 * Two workspaces in one database of the run's engine, holding the same session and
 * issue ids with different content. Each workspace's `CollectionsRepository` answers
 * every rule from its own rows only: the row itself, the union behind the per-person
 * session state, and both recursive walks (a rule's `descendantsOf` and the ancestors of
 * a tree) never step into the other workspace, though every id they meet exists there.
 */

import { asIssueId, asWorkspaceId, type IssueId } from '@podium/model'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { resolveRule } from '../sync/collection-shapes'
import { storeSql } from '../test-support/store-sql'
import {
  ALICE,
  only,
  owner,
  scope,
  seed,
  type Tag,
  WS,
} from '../test-support/workspace-seeds/sessions'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import { CollectionsRepository } from './collections'
import { workspaceQueries } from './executor/sync-drizzle'

const NOW = Date.parse('2026-11-18T00:00:00.000Z')
const ROOT_ISSUE = asIssueId('iss-root')
const KID = asIssueId('iss-kid')
const B_KID = asIssueId('iss-bkid')

let stores: readonly SessionStore[] = []
let repos: Record<Tag, CollectionsRepository>

beforeAll(async () => {
  repos = await open()
})

afterAll(async () => {
  await stores[0]?.close()
})

/** An issue of `tag` under `parent`, raw: the tree is all this needs of it. */
async function issue(
  store: SessionStore,
  tag: Tag,
  id: IssueId,
  seq: number,
  parent: IssueId | null,
) {
  await storeSql(store).run(
    sql`INSERT INTO issues (workspace_id, id, owner_user_id, created_by_actor, repo_path, repo_id, seq, title,
          stage, default_agent, parent_id, created_at, updated_at)
        VALUES (${WS[tag]}, ${id}, ${owner(tag)}, ${owner(tag)}, '/repo', 'repo-1', ${seq}, ${id},
                'backlog', 'codex', ${parent}, '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:00.000Z')`,
  )
}

async function open(): Promise<Record<Tag, CollectionsRepository>> {
  stores = await openWorkspaceStores([WS.a, WS.b])
  const [a, b] = stores as [SessionStore, SessionStore]
  for (const [store, tag] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    await seed(store, tag)
  }
  // An offer on a's own session only: b's s1 offer is the one both seeds make.
  await a.sessions.setOffer(scope, only('a'), {
    message: 'a only offer',
    actions: [{ label: 'Go', prompt: 'go' }],
    createdAt: '2026-11-17T10:00:00.000Z',
  })
  // The same ids, linked differently: in a the kid is the root's child; in b it is
  // top-level and another issue is.
  await issue(a, 'a', ROOT_ISSUE, 20, null)
  await issue(a, 'a', KID, 21, ROOT_ISSUE)
  await issue(b, 'b', ROOT_ISSUE, 20, null)
  await issue(b, 'b', KID, 21, null)
  await issue(b, 'b', B_KID, 22, ROOT_ISSUE)
  const repository = (store: SessionStore, tag: Tag) =>
    new CollectionsRepository(workspaceQueries(store.database.queries, asWorkspaceId(WS[tag])))
  return { a: repository(a, 'a'), b: repository(b, 'b') }
}

const ids = (rows: readonly (readonly unknown[])[]) => rows.map((row) => String(row[0])).sort()

describe('the collection fetch reads one workspace (POD-7118)', () => {
  it("answers a rule over the row from the workspace's own rows", async () => {
    const live = resolveRule('session.live')
    for (const tag of ['a', 'b'] as const) {
      // s1, s2 and s5 are live in both; s3 is hibernated, s4 tombstoned.
      expect(ids(await repos[tag].select(live, {}, NOW)), tag).toEqual(
        ['s1', 's2', 's5', only(tag)].sort(),
      )
    }
  })

  // The asking rule reads the offer and the checkpoints on Postgres and the derived
  // column on SQLite (POD-7104); either way, only the workspace's own.
  it("answers who is asking from the workspace's own offers", async () => {
    const asking = resolveRule('session.asking')
    expect(ids(await repos.a.select(asking, {}, NOW))).toEqual(['s1', only('a')].sort())
    expect(ids(await repos.b.select(asking, {}, NOW))).toEqual(['s1'])
  })

  it("reads the per-person session state's union in the workspace only", async () => {
    const rule = resolveRule('sessionUserState.ofSession')
    const pairs = async (tag: Tag, sessionId: string) =>
      (await repos[tag].select(rule, { sessionId }, NOW)).map((row) => `${row[0]}/${row[1]}`)
    for (const tag of ['a', 'b'] as const) {
      const theirs = only(tag === 'a' ? 'b' : 'a')
      // Alice read her `only` session; Bob snoozed it: both arms of the union.
      expect((await pairs(tag, only(tag))).sort(), tag).toEqual(
        [`${ALICE}/${only(tag)}`, `${owner('b')}/${only(tag)}`].sort(),
      )
      expect(await pairs(tag, theirs), tag).toEqual([])
    }
  })

  it("walks a tree down and up through the workspace's own parent links", async () => {
    const tree = resolveRule('issueProjection.tree')
    expect(ids(await repos.a.select(tree, { root: ROOT_ISSUE }, NOW))).toEqual([KID, ROOT_ISSUE])
    expect(ids(await repos.b.select(tree, { root: ROOT_ISSUE }, NOW))).toEqual([B_KID, ROOT_ISSUE])
    expect(await repos.a.ancestors([KID])).toEqual([ROOT_ISSUE])
    expect(await repos.b.ancestors([KID])).toEqual([])
    expect(await repos.b.ancestors([B_KID])).toEqual([ROOT_ISSUE])
  })
})
