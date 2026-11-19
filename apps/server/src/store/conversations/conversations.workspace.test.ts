/**
 * CONVERSATIONS AND SEARCH ARE A WORKSPACE'S (POD-6959 design 2.4, 2.5; task POD-7022), ON
 * BOTH ENGINES (POD-6990).
 *
 * Two workspaces over one database (`openConversationStoreSlices`: SQLite on the store
 * shard, Postgres on the `server-store-pg` lane), each seeded through its own
 * repositories with its own conversations, registry identities and segments, mirror cursors and
 * incarnations, and transcript search rows.
 * Both workspaces hold the SAME ids and natural keys (POD-7025): the same machine, native ids
 * (conversation and segment) and project. Every key leads with workspace_id (POD-7024), so the
 * same id is two rows, told apart only by the workspace. The content differs (titles, curated
 * meta, lake paths, reported sizes, cursors, inodes, transcript text), and podium ids are
 * minted, so a read that crossed over would answer the other workspace's content. Where a
 * case needs an id the other workspace does not hold, it plants one only the other holds
 * (`only-<tag>`).
 *
 * For every repository method of `store/conversations/*`:
 *   - a read answers only its own workspace's rows;
 *   - an update, delete or upsert in one workspace leaves the other's rows unchanged, both for
 *     the ids the two share and for ids only the other holds, which must find nothing to change.
 *
 * On SQLite the transcript search rows are `transcript_fts`, held to a workspace through the key
 * table `transcript_fts_keys`; on Postgres they are `transcript_text`, held to it by the row's own
 * `workspace_id` (`store/conversations/search-pg.ts`). The same cases hold both.
 *
 * SQLite only, because Postgres has no key table and every row carries its workspace: a
 * transcript row whose segment no workspace holds is the self-hosted workspace's (only its
 * search finds it), and the key table's open path (a `transcript_fts_keys` from before the
 * workspace column is made again with it, and its rows are keyed again to the workspace whose
 * segment they belong to). That open path is the one case whose two workspaces cannot share a
 * segment: a key row from before the column names only (machine, native id), so a segment both
 * hold could be either's. There B's rows are of a segment only B holds.
 */

import { asMachineId } from '@podium/model'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import { openConversationStoreSlices } from '../../test-support/conversation-store-slice'
import {
  AT,
  archived,
  conversation,
  ftsRowsOf,
  indexed,
  lakePath,
  MACHINE,
  mirrored,
  nat,
  ON_PG,
  only,
  PROJECT,
  reported,
  rowsOf,
  type Seeded,
  type SessionStore,
  scope,
  seed,
  seedSegment,
  type Tag,
  WS,
} from '../../test-support/workspace-seeds/conversations'

let stores: { a: SessionStore; b: SessionStore }
let seeded: Record<Tag, Seeded>

beforeEach(async () => {
  const [a, b] = await openConversationStoreSlices([WS.a, WS.b])
  stores = { a, b }
  for (const store of [a, b]) await store.conversations.ensureFts(true)
  seeded = { a: await seed(a, 'a'), b: await seed(b, 'b') }
})

afterEach(async () => {
  await stores?.a.close()
})

/** No content of the other workspace anywhere in `value`. */
function onlyOwn(value: unknown, tag: Tag): void {
  const other = tag === 'a' ? 'b' : 'a'
  const text = JSON.stringify(value)
  expect(text).not.toMatch(new RegExp(` ${other} |\\b${other}-|/${other}/|only-${other}`))
}

describe('POD-7022 — conversations and search are a workspace’s', () => {
  it('seeds both workspaces with their own rows', async () => {
    for (const tag of ['a', 'b'] as const) {
      const rows = await rowsOf(stores[tag], tag)
      expect(rows.conversations).toHaveLength(2)
      expect(rows.conversation_identities).toHaveLength(2)
      expect(rows.conversation_segments).toHaveLength(3)
      expect(rows.conversation_segment_incarnations).toHaveLength(2)
      expect(rows.transcript_rows).toHaveLength(2)
      onlyOwn(rows, tag)
    }
  })

  describe('the conversation index', () => {
    it('reads records, pages, curated meta and searches only its own workspace', async () => {
      for (const tag of ['a', 'b'] as const) {
        const { index } = stores[tag].conversations
        const ids = [nat(1), nat(2), only('a'), only('b')]
        const titles = (rows: { id: string; title?: string | null }[]) =>
          rows.map((row) => [row.id, row.title]).sort()
        const own = [1, 2].map((n) => [nat(n), `shared ${tag} title ${n}`])

        const entries = await index.recordEntries(ids)
        expect(titles(entries.map((entry) => entry.value))).toEqual(own)
        expect(entries.every((entry) => entry.machineId === MACHINE)).toBe(true)
        // The record names its podium id through the joined segment, and never the workspace.
        const first = entries.find((entry) => entry.value.id === nat(1))!
        expect(first.value.podiumId).toBe(seeded[tag].root)
        expect(first.value).not.toHaveProperty('workspaceId')
        expect(titles(await index.records(ids))).toEqual(own)

        const pages: { id: string; title?: string | null }[] = []
        for await (const page of index.recordPages(1)) pages.push(...page)
        expect(titles(pages)).toEqual(own)

        expect(Object.fromEntries(await index.curatedMetaOf(ids))).toEqual({
          [nat(1)]: { name: `shared ${tag} name`, summary: `${tag} summary` },
        })

        // FTS (search on) and LIKE (search off) both stay in the workspace.
        const fts = await index.search({ query: 'shared' })
        expect(titles(fts)).toEqual(own)
        expect(
          titles(await index.searchCandidates({ query: 'shared', projectPath: PROJECT })),
        ).toEqual(own)

        const recent = await index.search({})
        expect(recent.map((row) => row.id)).toEqual([nat(2), nat(1)])
        onlyOwn(recent, tag)
        const page = await index.recentPage({
          limit: 10,
          after: { updatedAt: '2099-01-01T00:00:00.000Z', id: 'zzz' },
        })
        expect(page.map((row) => row.id)).toEqual([nat(2), nat(1)])
        onlyOwn(page, tag)
        const inProject = await index.recentPage({ limit: 10, projectPath: PROJECT })
        expect(inProject.map((r) => r.id)).toEqual([nat(2), nat(1)])
        onlyOwn(inProject, tag)
      }

      // Search off: the LIKE fallback.
      await stores.a.conversations.index.disableFts()
      const like = await stores.a.conversations.index.search({ query: 'shared' })
      expect(like.map((row) => row.id)).toEqual([nat(2), nat(1)])
      onlyOwn(like, 'a')
    })

    it('an upsert, a delete and a meta write in A leave B unchanged', async () => {
      const { index } = stores.a.conversations
      // Conversations only B holds.
      await stores.b.conversations.index.upsert(scope, [
        conversation('b', 5, { id: `${only('b')}-1` }),
        conversation('b', 6, { id: `${only('b')}-2` }),
      ])
      const before = await rowsOf(stores.b, 'b')

      // The ids both hold: A's rows only.
      await index.upsert(scope, [conversation('a', 1, { title: 'retitled' }), conversation('a', 4)])
      await index.setMeta(scope, nat(2), { name: 'a renamed' })
      // A's delete and meta write aimed at ids only B holds find nothing of A's to change.
      expect(await index.delete(scope, MACHINE, [`${only('b')}-1`, `${only('b')}-2`])).toEqual([])
      await expect(index.setMeta(scope, `${only('b')}-1`, { name: 'stolen' })).rejects.toThrow(
        /has not been reported/,
      )
      expect(await index.delete(scope, MACHINE, [nat(4)])).toEqual([nat(4)])

      expect(await rowsOf(stores.b, 'b')).toEqual(before)
      expect((await index.records([nat(1)]))[0]?.title).toBe('retitled')
      expect((await index.curatedMetaOf([nat(2)])).get(nat(2))).toEqual({ name: 'a renamed' })
      expect((await stores.b.conversations.index.records([nat(1)]))[0]?.title).toBe(
        'shared b title 1',
      )
    })
  })

  describe('the conversation registry', () => {
    it('reads identities, segments and paths only from its own workspace', async () => {
      // A segment only each workspace holds.
      for (const tag of ['a', 'b'] as const) {
        await stores[tag].conversations.registry.ensure({
          machineId: MACHINE,
          nativeId: only(tag),
          providerId: 'claude-code',
          path: `/lake/${tag}/only.jsonl`,
          sizeBytes: 1,
        })
      }
      for (const tag of ['a', 'b'] as const) {
        const { registry } = stores[tag].conversations
        const other = tag === 'a' ? 'b' : 'a'
        const m = MACHINE
        const { root, child } = seeded[tag]
        const foreign = seeded[other]

        // Podium ids are minted, so the same native id answers each workspace's own.
        expect(await registry.podiumId(m, nat(1))).toBe(root)
        expect(await registry.podiumId(m, only(other))).toBeUndefined()
        expect(Object.fromEntries(await registry.podiumIds(m, [nat(1), nat(2)]))).toEqual({
          [nat(1)]: root,
          [nat(2)]: child,
        })
        expect((await registry.podiumIds(m, [only(other)])).size).toBe(0)

        // Lake paths are each segment's own content: the other's path is one only it holds.
        expect([
          ...(await registry.segmentsByPaths(m, [lakePath(tag, 1), lakePath(other, 1)])).keys(),
        ]).toEqual([lakePath(tag, 1)])

        expect(Object.fromEntries(await registry.parentPodiumIds([child, foreign.child]))).toEqual({
          [child]: root,
        })
        expect(
          Object.fromEntries(await registry.nativeIdsByPodiumIds([root, foreign.root])),
        ).toEqual({
          [root]: [nat(1), nat(3)],
        })
        expect(Object.fromEntries(await registry.pathsByNativeIds(m, [nat(1), nat(2)]))).toEqual({
          [nat(1)]: lakePath(tag, 1),
          [nat(2)]: lakePath(tag, 2),
        })
        expect((await registry.pathsByNativeIds(m, [only(other)])).size).toBe(0)
        expect(await registry.segmentPath(m, nat(2))).toBe(lakePath(tag, 2))
        expect(await registry.segmentPath(m, only(other))).toBeUndefined()

        const siblings = [
          { machineId: m, nativeId: nat(1) },
          { machineId: m, nativeId: nat(3) },
        ]
        expect(await registry.siblingSegments(m, nat(3))).toEqual(siblings)
        expect(await registry.siblingSegments(m, only(other))).toEqual([])
        expect(
          await registry.siblingSegmentsMany([
            { machineId: m, nativeId: nat(1) },
            { machineId: m, nativeId: only(other) },
          ]),
        ).toEqual([siblings, []])
      }
    })

    it('ensure, ensureMany and linkSegment in A leave B unchanged', async () => {
      const { registry } = stores.a.conversations
      const m = MACHINE
      const before = await rowsOf(stores.b, 'b')

      // Existing rows: adopt a parent and refresh a file, one at a time and many at once.
      const third = await registry.ensure({ machineId: m, nativeId: nat(5), providerId: 'p' })
      await registry.ensure({
        machineId: m,
        nativeId: nat(5),
        providerId: 'p',
        parentPodiumId: seeded.a.root,
        path: '/lake/a/5.jsonl',
        sizeBytes: 5,
      })
      // Segment 2 is one both hold: A refreshes its own.
      const many = await registry.ensureMany(m, [
        { nativeId: nat(2), providerId: 'p', path: '/lake/a/2b.jsonl', sizeBytes: 9 },
        { nativeId: nat(6), providerId: 'p', parentPodiumId: seeded.a.root },
        { nativeId: nat(5), providerId: 'p', parentPodiumId: seeded.a.child },
      ])
      expect(many.get(nat(5))).toBe(third)
      await registry.linkSegment({
        machineId: m,
        newNativeId: nat(7),
        priorNativeId: nat(6),
        providerId: 'p',
      })

      expect(await rowsOf(stores.b, 'b')).toEqual(before)
      expect(await registry.segmentPath(m, nat(2))).toBe('/lake/a/2b.jsonl')
      expect(await stores.b.conversations.registry.segmentPath(m, nat(2))).toBe(lakePath('b', 2))
      expect((await registry.parentPodiumIds([third])).get(third)).toBe(seeded.a.root)
      expect(await registry.siblingSegments(m, nat(7))).toEqual([
        { machineId: m, nativeId: nat(6) },
        { machineId: m, nativeId: nat(7) },
      ])
    })
  })

  describe('the transcript mirror', () => {
    it('reads cursors, incarnations and the lake conversion pages only from its own workspace', async () => {
      for (const tag of ['a', 'b'] as const) {
        const { mirror } = stores[tag].conversations
        const m = MACHINE

        // No ORDER BY: Postgres may return them in either order.
        expect((await mirror.segmentsToMirror(m)).map((row) => row.nativeId).sort()).toEqual([
          nat(1),
          nat(2),
        ])
        onlyOwn(await mirror.segmentsToMirror(m), tag)
        // No ORDER BY: Postgres may return them in either order.
        expect((await mirror.segmentsToMirrorDirty(m)).map((row) => row.nativeId).sort()).toEqual([
          nat(1),
          nat(2),
        ])

        expect(await mirror.reportedBytes(m, nat(2))).toBe(reported(tag, 2))
        expect(await mirror.mirrorCursor(m, nat(1))).toBe(mirrored(tag))

        expect(await mirror.activeIncarnation(m, nat(1))).toEqual({
          sequence: 2,
          device: 'd1',
          inode: `${tag}-i2`,
        })
        expect((await mirror.incarnations(m, nat(1))).map((row) => row.inode)).toEqual([
          `${tag}-i1`,
          `${tag}-i2`,
        ])

        const segment = {
          machineId: m,
          nativeId: nat(1),
          mirroredBytes: mirrored(tag),
          activeSequence: 2,
        }
        expect(await mirror.lakeConversionSegments(undefined, 10)).toEqual([segment])
        expect(
          await mirror.lakeConversionSegments({ machineId: asMachineId(''), nativeId: '' }, 10),
        ).toEqual([segment])
        const archive = {
          machineId: m,
          nativeId: nat(1),
          sequence: 1,
          mirroredBytes: archived(tag),
        }
        expect(await mirror.lakeConversionArchived(undefined, 10)).toEqual([archive])
        expect(
          await mirror.lakeConversionArchived(
            { machineId: asMachineId(''), nativeId: '', sequence: 0 },
            10,
          ),
        ).toEqual([archive])
      }
    })

    it('cursor writes and rotations in A leave B unchanged, aimed at a segment only B holds or at the ones both hold', async () => {
      const { mirror } = stores.a.conversations
      const m = MACHINE
      // A segment only B holds, mirrored and rotated as the shared ones are.
      await seedSegment(stores.b, 'b', only('b'), '/lake/b/only.jsonl')
      const before = await rowsOf(stores.b, 'b')

      await mirror.setReportedBytes(m, only('b'), 999)
      expect(await mirror.setMirrorCursor(m, only('b'), mirrored('b'), 99, AT)).toBe(false)
      expect(
        await mirror.rotateIncarnation(
          m,
          only('b'),
          { sequence: 2, device: 'd1', inode: 'b-i2' },
          { device: 'd1', inode: 'stolen' },
          mirrored('b'),
          AT,
        ),
      ).toBe(false)
      expect(await rowsOf(stores.b, 'b')).toEqual(before)

      // A's own writes of the segments both hold land, and B still holds what it held.
      await mirror.setReportedBytes(m, nat(2), 250)
      expect(await mirror.setMirrorCursor(m, nat(1), mirrored('a'), 80, AT)).toBe(true)
      await mirror.startIncarnation(m, nat(2), { device: 'd2', inode: 'a-j1' }, AT)
      expect(
        await mirror.rotateIncarnation(
          m,
          nat(2),
          { sequence: 1, device: 'd2', inode: 'a-j1' },
          { device: 'd2', inode: 'a-j2' },
          10,
          AT,
        ),
      ).toBe(true)
      expect(await mirror.reportedBytes(m, nat(2))).toBe(250)
      expect(await rowsOf(stores.b, 'b')).toEqual(before)
      expect(await stores.b.conversations.mirror.mirrorCursor(m, nat(1))).toBe(mirrored('b'))
    })
  })

  describe('the transcript index', () => {
    it('reads cursors, rows and search matches only from its own workspace', async () => {
      for (const tag of ['a', 'b'] as const) {
        const { transcriptIndex } = stores[tag].conversations
        const m = MACHINE

        expect(await transcriptIndex.segmentsToIndex(m)).toEqual([
          { nativeId: nat(1), mirroredBytes: mirrored(tag), indexedBytes: indexed(tag) },
        ])
        expect(await transcriptIndex.indexedCursor(m, nat(1))).toBe(indexed(tag))

        expect((await transcriptIndex.rows(m, nat(1))).map((row) => row.content)).toEqual([
          `needle shared ${tag} one`,
          'needle two',
        ])

        // Both workspaces hold "needle two" in the same segment: a match is only ever this
        // workspace's row.
        const matches = await transcriptIndex.searchCandidates('needle')
        expect(matches).toHaveLength(2)
        for (const match of matches) {
          expect(match.machineId).toBe(m)
          expect(match.nativeId).toBe(nat(1))
          expect(match.podiumId).toBe(seeded[tag].root)
          expect(match.title).toBe(`shared ${tag} name`)
        }
      }
    })

    it('an append, a drop and a reset in A leave B unchanged, aimed at a segment only B holds or at the ones both hold', async () => {
      const { transcriptIndex } = stores.a.conversations
      const m = MACHINE
      // A segment only B holds, with its transcript rows.
      await seedSegment(stores.b, 'b', only('b'), '/lake/b/only.jsonl')
      const before = await rowsOf(stores.b, 'b')
      const bFts = await ftsRowsOf(stores.b, 'b')

      await transcriptIndex.drop(m, only('b'))
      expect(
        await transcriptIndex.resetMissingLake(m, only('b'), {
          mirroredBytes: mirrored('b'),
          indexedBytes: indexed('b'),
        }),
      ).toBe(false)
      expect(await rowsOf(stores.b, 'b')).toEqual(before)
      expect(await ftsRowsOf(stores.b, 'b')).toEqual(bFts)

      // The segments both hold: A's rows only.
      await transcriptIndex.append(m, nat(2), [{ content: 'needle three' }], 5)
      await transcriptIndex.drop(m, nat(1))
      expect(await transcriptIndex.rows(m, nat(1))).toEqual([])
      expect(
        await transcriptIndex.resetMissingLake(m, nat(2), {
          mirroredBytes: 0,
          indexedBytes: 5,
        }),
      ).toBe(true)
      expect(await transcriptIndex.rows(m, nat(2))).toEqual([])
      expect(await stores.a.conversations.transcriptIndex.searchCandidates('needle')).toEqual([])

      expect(await rowsOf(stores.b, 'b')).toEqual(before)
      expect(await ftsRowsOf(stores.b, 'b')).toEqual(bFts)
      expect(await stores.b.conversations.transcriptIndex.searchCandidates('needle')).toHaveLength(
        4,
      )
      expect(
        (await stores.b.conversations.transcriptIndex.rows(m, nat(1))).map((row) => row.content),
      ).toEqual(['needle shared b one', 'needle two'])
    })
  })

  describe.skipIf(ON_PG)(
    'the search key table’s workspace column (SQLite: Postgres has no key table)',
    () => {
      /** Put the key table back in its shape from before the column, keeping its rows. */
      async function oldKeyTable(store: SessionStore): Promise<void> {
        for (const statement of [
          'CREATE TABLE keys_before AS SELECT fts_rowid, machine_id, native_id FROM transcript_fts_keys',
          'DROP TABLE transcript_fts_keys',
          `CREATE TABLE transcript_fts_keys (
          fts_rowid INTEGER PRIMARY KEY, machine_id TEXT NOT NULL, native_id TEXT NOT NULL)`,
          'INSERT INTO transcript_fts_keys SELECT * FROM keys_before',
          'DROP TABLE keys_before',
          'CREATE INDEX idx_transcript_fts_keys_segment ON transcript_fts_keys (machine_id, native_id)',
        ]) {
          await store.run(sql.raw(statement))
        }
      }

      const workspaceColumn = async (store: SessionStore) =>
        await store.all(
          sql.raw(
            `SELECT "notnull" AS not_null FROM pragma_table_info('transcript_fts_keys') WHERE name = 'workspace_id'`,
          ),
        )

      it('is made with the table, non-null', async () => {
        expect(await workspaceColumn(stores.a)).toEqual([{ not_null: 1 }])
      })

      it('is made again with it when the index opens, and each workspace keys its own segments’ rows', async () => {
        // A key row from before the column names only (machine, native id): a segment both
        // workspaces hold could be either's. So B's rows here are of a segment only B holds.
        await stores.b.conversations.transcriptIndex.drop(MACHINE, nat(1))
        await seedSegment(stores.b, 'b', only('b'), '/lake/b/only.jsonl')
        const segmentOf = (tag: Tag) => (tag === 'a' ? nat(1) : only('b'))
        await oldKeyTable(stores.a)
        expect(await workspaceColumn(stores.a)).toEqual([])
        const contents = async (tag: Tag) =>
          (await stores[tag].conversations.transcriptIndex.rows(MACHINE, segmentOf(tag))).map(
            (row) => row.content,
          )

        await stores.a.conversations.transcriptIndex.enableFts()
        expect(await workspaceColumn(stores.a)).toEqual([{ not_null: 1 }])
        expect(await contents('a')).toEqual(['needle shared a one', 'needle two'])
        // B's rows are not A's: they wait, unkeyed, for B's own open.
        expect(await contents('b')).toEqual([])
        expect(
          await stores.a.all(sql`SELECT DISTINCT workspace_id AS ws FROM transcript_fts_keys`),
        ).toEqual([{ ws: WS.a }])

        await stores.b.conversations.transcriptIndex.enableFts()
        expect(await contents('b')).toEqual(['needle shared b one', 'needle two'])
        expect(await contents('a')).toEqual(['needle shared a one', 'needle two'])
        expect((await rowsOf(stores.a, 'a')).transcript_rows).toHaveLength(2)
        expect((await rowsOf(stores.b, 'b')).transcript_rows).toHaveLength(2)
        expect(
          await stores.b.conversations.transcriptIndex.searchCandidates('shared'),
        ).toHaveLength(1)
      })
    },
  )

  describe.skipIf(ON_PG)(
    'a transcript row whose segment no workspace holds (SQLite: a Postgres row carries its workspace)',
    () => {
      it('is the self-hosted workspace’s: its search finds it, no other workspace’s does', async () => {
        const [local, other] = await openConversationStoreSlices([
          SELF_HOSTED_WORKSPACE_ID,
          'ws_other',
        ])
        try {
          for (const store of [local, other]) await store.conversations.ensureFts(true)
          // A row with no segment row anywhere, as an older build left it: no key.
          await local.run(
            sql`INSERT INTO transcript_fts (content, machine_id, native_id) VALUES (${'orphan needle'}, ${'gone-machine'}, ${'gone-native'})`,
          )

          // The other workspace opens first and keys nothing it does not own.
          await other.conversations.transcriptIndex.enableFts()
          expect(await other.conversations.transcriptIndex.searchCandidates('orphan')).toEqual([])
          await local.conversations.transcriptIndex.enableFts()

          const found = await local.conversations.transcriptIndex.searchCandidates('orphan')
          expect(found.map((match) => [match.machineId, match.nativeId, match.podiumId])).toEqual([
            ['gone-machine', 'gone-native', undefined],
          ])
          expect(
            await local.conversations.transcriptIndex.rows(
              asMachineId('gone-machine'),
              'gone-native',
            ),
          ).toEqual([{ content: 'orphan needle' }])
          expect(await other.conversations.transcriptIndex.searchCandidates('orphan')).toEqual([])
          expect(
            await other.conversations.transcriptIndex.rows(
              asMachineId('gone-machine'),
              'gone-native',
            ),
          ).toEqual([])
          expect(
            await local.all(sql`SELECT DISTINCT workspace_id AS ws FROM transcript_fts_keys`),
          ).toEqual([{ ws: SELF_HOSTED_WORKSPACE_ID }])
        } finally {
          await local.close()
        }
      })
    },
  )
})

/**
 * THE SAME ID UPSERTED FIRST IN THE OTHER WORKSPACE (POD-7024): every ON CONFLICT target leads with workspace_id,
 * so an upsert in A of an id B already holds makes A its own row, B's row stays byte for byte
 * as it was, and A's second upsert of the id updates A's row only.
 */
describe('the same id in both workspaces, upserted through the repository (POD-7024)', () => {
  it("makes a second row, leaves the other workspace's as it was, and updates only its own", async () => {
    const SAME = 'same-conversation'
    const rowsIn = async (store: SessionStore, ws: string) =>
      await store.all<Record<string, unknown>>(
        sql`SELECT * FROM conversations WHERE workspace_id = ${ws} AND id = ${SAME}`,
      )
    const { a, b } = stores
    await b.conversations.index.upsert(scope, [conversation('b', 7, { id: SAME })])
    const before = await rowsIn(b, WS.b)
    expect(before).toHaveLength(1)
    await a.conversations.index.upsert(scope, [conversation('a', 7, { id: SAME })])
    expect(await rowsIn(a, WS.a)).toHaveLength(1)
    expect(await rowsIn(b, WS.b)).toEqual(before)
    await a.conversations.index.upsert(scope, [
      conversation('a', 7, { id: SAME, title: 'a retitled' }),
    ])
    expect(await rowsIn(a, WS.a)).toEqual([expect.objectContaining({ title: 'a retitled' })])
    expect(await rowsIn(b, WS.b)).toEqual(before)
  })
})
