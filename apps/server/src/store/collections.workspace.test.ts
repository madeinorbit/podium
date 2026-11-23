/**
 * THE COLLECTION FETCH READS ONE WORKSPACE [POD-7118, POD-7085].
 *
 * Two workspaces in one database of the run's engine, holding the same session and
 * issue ids with different content. Each workspace's `CollectionsRepository` answers
 * every rule from its own rows only: the row itself, the union behind the per-person
 * session state, and both recursive walks (a rule's `descendantsOf` and the ancestors of
 * a tree) never step into the other workspace, though every id they meet exists there.
 */

import {
  type AgentRuntimeState,
  asIssueId,
  asSessionId,
  asWorkspaceId,
  type IssueId,
} from '@podium/model'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { resolveRule } from '../sync/collection-shapes'
import { storeSql } from '../test-support/store-sql'
import {
  ALICE,
  heldBy,
  iss,
  only,
  owner,
  scope,
  seed,
  session,
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
  it('pages record keys in its workspace without duplicates or keys from another', async () => {
    const walk = async (tag: Tag) => {
      const out: string[] = []
      let after = ''
      for (;;) {
        const page = await repos[tag].keyPage('issueProjection', after, 1)
        const [key] = page
        if (key === undefined) return out
        expect(page).toHaveLength(1)
        expect(key > after).toBe(true)
        out.push(key)
        after = key
      }
    }
    expect(await walk('a')).toEqual([iss(1), iss(2), heldBy('a'), KID, ROOT_ISSUE].sort())
    expect(await walk('b')).toEqual([iss(1), iss(2), heldBy('b'), B_KID, KID, ROOT_ISSUE].sort())
  })

  it("answers a rule over the row from the workspace's own rows", async () => {
    const live = resolveRule('session.live')
    for (const tag of ['a', 'b'] as const) {
      // s1, s2 and s5 are live in both; s3 is hibernated, s4 tombstoned.
      expect(ids(await repos[tag].select(live, {}, NOW)), tag).toEqual(
        ['s1', 's2', 's5', only(tag)].sort(),
      )
    }
  })

  // Both engines read the maintained column, held to the workspace.
  it("answers who is asking from the workspace's own offers", async () => {
    const asking = resolveRule('session.asking')
    expect(ids(await repos.a.select(asking, {}, NOW))).toEqual(['s1', only('a')].sort())
    expect(ids(await repos.b.select(asking, {}, NOW))).toEqual(['s1'])
  })

  it('keeps asking and its noIssue shape isolated while same-id inputs change in either workspace', async () => {
    const id = asSessionId('asking-shared')
    const state = (phase: AgentRuntimeState['phase']): AgentRuntimeState => ({
      phase,
      since: '2026-01-01T00:00:00.000Z',
      nativeSubagentCount: 0,
    })
    const row = (tag: Tag, phase: AgentRuntimeState['phase']) =>
      session(tag, 9, {
        id,
        durableLabel: id,
        status: 'exited',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        agentState: state(phase),
      })
    const check = async (expected: Record<Tag, boolean>) => {
      for (const [index, tag] of (['a', 'b'] as const).entries()) {
        const store = stores[index]!
        const flag = await storeSql(store).get<{ asks: number }>(
          sql`SELECT CAST(asks_user AS integer) AS asks FROM sessions WHERE workspace_id = ${WS[tag]} AND id = ${id}`,
        )
        expect(flag?.asks, `${tag} flag`).toBe(expected[tag] ? 1 : 0)
        for (const rule of ['session.asking', 'session.noIssue']) {
          expect(
            ids(await repos[tag].select(resolveRule(rule), {}, NOW)).includes(id),
            `${tag} ${rule}`,
          ).toBe(expected[tag])
        }
      }
    }
    for (const [index, tag] of (['a', 'b'] as const).entries()) {
      await stores[index]!.sessions.upsertSession(scope, row(tag, 'working'))
    }
    try {
      for (const [index, tag] of (['a', 'b'] as const).entries()) {
        const store = stores[index]!
        const expected = { a: false, b: false, [tag]: true }
        await store.sessions.upsertSession(scope, row(tag, 'needs_user'))
        await check(expected)
        await store.events.saveRuntimeEventCheckpoint({
          sessionId: id,
          observerGeneration: 1,
          cursor: { segmentId: 's', components: { file: 1 } },
          turnEpoch: 1,
          closedTurnEpoch: null,
          updatedAt: '2026-11-17T10:00:00.000Z',
          turnState: state('working'),
        })
        await check({ a: false, b: false })
        await store.sessions.setOffer(scope, id, {
          message: 'Ready',
          actions: [],
          createdAt: '2026-11-17T10:00:00.000Z',
        })
        await check(expected)
        await store.sessions.clearOffer(scope, id)
        await check({ a: false, b: false })
      }
    } finally {
      for (const store of stores) await store.sessions.purgeSession(scope, id)
    }
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
