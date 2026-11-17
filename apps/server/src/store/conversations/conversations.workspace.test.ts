/**
 * CONVERSATIONS AND SEARCH ARE A WORKSPACE'S (POD-6959 design 2.4, 2.5; task POD-7022).
 *
 * Two workspaces over one database (`openWorkspaceStores`), each seeded through its own
 * repositories with its own conversations, registry identities and segments, mirror cursors and
 * incarnations, and transcript search rows. The ids differ between the workspaces: until the key
 * migration (C1, POD-7024) no unique constraint includes `workspace_id`, so the same id in both
 * would collide on the old key. The searchable words are the SAME in both, so a search that
 * reached the other workspace's full-text rows would find them.
 *
 * For every repository method of `store/conversations/*`:
 *   - a read answers only its own workspace's rows;
 *   - an update, delete or upsert in one workspace leaves the other's rows unchanged, including
 *     a write in A addressed at B's own ids, which must find nothing to change.
 *
 * A transcript row whose segment no workspace holds is the self-hosted workspace's: only its
 * search finds it.
 *
 * And the search key table's open path: a `transcript_fts_keys` from before the workspace column
 * is made again with it, and its rows are keyed again to the workspace whose segment they
 * belong to.
 */

import { asMachineId, type ConversationId, type MachineId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import type { SessionStore } from '../../store'
import { openWorkspaceStores } from '../../test-support/workspace-stores'
import type { ConversationIndexRow } from '../types'

type Tag = 'a' | 'b'
const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
const AT = '2026-11-17T10:00:00.000Z'
const scope = fixtureWriteScope()

const machine = (tag: Tag): MachineId => asMachineId(`${tag}-machine`)
/** A native id of `tag`'s workspace: the conversation id and the segment's native id. */
const nat = (tag: Tag, n: number) => `${tag}-native-${n}`
const lakePath = (tag: Tag, n: number) => `/lake/${tag}/${n}.jsonl`
const project = (tag: Tag) => `/repo-${tag}`

interface RawDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
  exec(sql: string): void
}
const rawDb = (store: SessionStore): RawDb => (store as unknown as { db: RawDb }).db

/** The tables this group owns, read raw per workspace, for "unchanged" comparisons. */
const TABLES = [
  'conversations',
  'conversation_identities',
  'conversation_segments',
  'conversation_segment_incarnations',
  'transcript_fts_keys',
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

/** Every FTS row of `tag`'s machine, keyed or not: a delete in the other workspace keeps them. */
const ftsRowsOf = (store: SessionStore, tag: Tag) =>
  rawDb(store)
    .prepare('SELECT rowid, content FROM transcript_fts WHERE machine_id = ? ORDER BY rowid')
    .all(machine(tag))

function conversation(tag: Tag, n: number, patch: Partial<ConversationIndexRow> = {}) {
  return {
    id: nat(tag, n),
    agentKind: 'claude-code',
    providerId: 'claude-code',
    title: `shared ${tag} title ${n}`,
    projectPath: project(tag),
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    updatedAt: `2026-11-0${n}T00:00:00.000Z`,
    messageCount: n,
    machineId: machine(tag),
    ...patch,
  }
}

interface Seeded {
  /** The podium id of conversation 1 (segments 1 and 3) and of conversation 2 (its child). */
  readonly root: ConversationId
  readonly child: ConversationId
}

/**
 * One workspace's rows, through its own repositories: conversations 1 and 2 (2 a child of 1's
 * identity), segments 1 and 2 with lake paths, segment 3 rolled onto conversation 1, a mirror
 * cursor and two incarnations of segment 1 (one retired), and transcript rows of segment 1.
 */
async function seed(store: SessionStore, tag: Tag): Promise<Seeded> {
  const { index, registry, mirror, transcriptIndex } = store.conversations
  const m = machine(tag)
  await index.upsert(scope, [conversation(tag, 1), conversation(tag, 2)])
  await index.setMeta(scope, nat(tag, 1), { name: `shared ${tag} name`, summary: `${tag} summary` })
  const root = await registry.ensure({
    machineId: m,
    nativeId: nat(tag, 1),
    providerId: 'claude-code',
    path: lakePath(tag, 1),
    sizeBytes: 100,
  })
  const child = await registry.ensure({
    machineId: m,
    nativeId: nat(tag, 2),
    providerId: 'claude-code',
    parentPodiumId: root,
    path: lakePath(tag, 2),
    sizeBytes: 200,
  })
  await registry.linkSegment({
    machineId: m,
    newNativeId: nat(tag, 3),
    priorNativeId: nat(tag, 1),
    providerId: 'claude-code',
  })
  expect(await mirror.setMirrorCursor(m, nat(tag, 1), 0, 60, AT)).toBe(true)
  await mirror.startIncarnation(m, nat(tag, 1), { device: 'd1', inode: `${tag}-i1` }, AT)
  expect(
    await mirror.rotateIncarnation(
      m,
      nat(tag, 1),
      { sequence: 1, device: 'd1', inode: `${tag}-i1` },
      { device: 'd1', inode: `${tag}-i2` },
      60,
      AT,
    ),
  ).toBe(true)
  // The rotation reset the cursor; mirror and index again.
  expect(await mirror.setMirrorCursor(m, nat(tag, 1), 0, 40, AT)).toBe(true)
  await transcriptIndex.append(
    m,
    nat(tag, 1),
    [{ content: `needle shared ${tag} one`, itemUuid: `${tag}-u1` }, { content: 'needle two' }],
    20,
  )
  return { root, child }
}

let stores: { a: SessionStore; b: SessionStore }
let seeded: Record<Tag, Seeded>

beforeEach(async () => {
  const [a, b] = await openWorkspaceStores([WS.a, WS.b], { path: ':memory:' })
  stores = { a, b }
  for (const store of [a, b]) await store.conversations.ensureFts(true)
  seeded = { a: await seed(a, 'a'), b: await seed(b, 'b') }
})

afterEach(async () => {
  await stores?.a.close()
})

describe('POD-7022 — conversations and search are a workspace’s', () => {
  it('seeds both workspaces with their own rows', () => {
    for (const tag of ['a', 'b'] as const) {
      const rows = rowsOf(stores[tag], tag)
      expect(rows.conversations).toHaveLength(2)
      expect(rows.conversation_identities).toHaveLength(2)
      expect(rows.conversation_segments).toHaveLength(3)
      expect(rows.conversation_segment_incarnations).toHaveLength(2)
      expect(rows.transcript_fts_keys).toHaveLength(2)
    }
  })

  describe('the conversation index', () => {
    it('reads records, pages, curated meta and searches only its own workspace', async () => {
      for (const tag of ['a', 'b'] as const) {
        const { index } = stores[tag].conversations
        const other = tag === 'a' ? 'b' : 'a'
        const ids = [nat(tag, 1), nat(tag, 2), nat(other, 1), nat(other, 2)]

        const entries = await index.recordEntries(ids)
        expect(entries.map((entry) => entry.value.id).sort()).toEqual([nat(tag, 1), nat(tag, 2)])
        expect(entries.every((entry) => entry.machineId === machine(tag))).toBe(true)
        // The record names its podium id through the joined segment, and never the workspace.
        const first = entries.find((entry) => entry.value.id === nat(tag, 1))!
        expect(first.value.podiumId).toBe(seeded[tag].root)
        expect(first.value).not.toHaveProperty('workspaceId')
        expect((await index.records(ids)).map((record) => record.id).sort()).toEqual([
          nat(tag, 1),
          nat(tag, 2),
        ])

        const pages: string[] = []
        for await (const page of index.recordPages(1)) pages.push(...page.map((r) => r.id))
        expect(pages).toEqual([nat(tag, 1), nat(tag, 2)])

        expect(Object.fromEntries(await index.curatedMetaOf(ids))).toEqual({
          [nat(tag, 1)]: { name: `shared ${tag} name`, summary: `${tag} summary` },
        })

        // FTS (search on) and LIKE (search off) both stay in the workspace.
        const fts = await index.search({ query: 'shared' })
        expect(fts.map((row) => row.id).sort()).toEqual([nat(tag, 1), nat(tag, 2)])
        expect(
          (await index.searchCandidates({ query: 'shared', projectPath: project(other) })).map(
            (row) => row.id,
          ),
        ).toEqual([])

        const recent = await index.search({})
        expect(recent.map((row) => row.id)).toEqual([nat(tag, 2), nat(tag, 1)])
        const page = await index.recentPage({
          limit: 10,
          after: { updatedAt: '2099-01-01T00:00:00.000Z', id: 'zzz' },
        })
        expect(page.map((row) => row.id)).toEqual([nat(tag, 2), nat(tag, 1)])
        expect(
          (await index.recentPage({ limit: 10, projectPath: project(tag) })).map((r) => r.id),
        ).toEqual([nat(tag, 2), nat(tag, 1)])
      }

      // Search off: the LIKE fallback.
      await stores.a.conversations.index.disableFts()
      expect(
        (await stores.a.conversations.index.search({ query: 'shared' })).map((row) => row.id),
      ).toEqual([nat('a', 2), nat('a', 1)])
    })

    it('an upsert, a delete and a meta write in A leave B unchanged', async () => {
      const { index } = stores.a.conversations
      const before = rowsOf(stores.b, 'b')

      await index.upsert(scope, [conversation('a', 1, { title: 'retitled' }), conversation('a', 4)])
      await index.setMeta(scope, nat('a', 2), { name: 'a renamed' })
      // A's delete and meta write aimed at B's ids find nothing of A's to change.
      expect(await index.delete(scope, machine('b'), [nat('b', 1), nat('b', 2)])).toEqual([])
      await expect(index.setMeta(scope, nat('b', 1), { name: 'stolen' })).rejects.toThrow(
        /has not been reported/,
      )
      expect(await index.delete(scope, machine('a'), [nat('a', 4)])).toEqual([nat('a', 4)])

      expect(rowsOf(stores.b, 'b')).toEqual(before)
      expect((await index.records([nat('a', 1)]))[0]?.title).toBe('retitled')
      expect((await index.curatedMetaOf([nat('a', 2)])).get(nat('a', 2))).toEqual({
        name: 'a renamed',
      })
    })
  })

  describe('the conversation registry', () => {
    it('reads identities, segments and paths only from its own workspace', async () => {
      for (const tag of ['a', 'b'] as const) {
        const { registry } = stores[tag].conversations
        const other = tag === 'a' ? 'b' : 'a'
        const m = machine(tag)
        const { root, child } = seeded[tag]
        const foreign = seeded[other]

        expect(await registry.podiumId(m, nat(tag, 1))).toBe(root)
        expect(await registry.podiumId(machine(other), nat(other, 1))).toBeUndefined()
        expect(Object.fromEntries(await registry.podiumIds(m, [nat(tag, 1), nat(tag, 2)]))).toEqual(
          {
            [nat(tag, 1)]: root,
            [nat(tag, 2)]: child,
          },
        )
        expect((await registry.podiumIds(machine(other), [nat(other, 1)])).size).toBe(0)

        expect([
          ...(await registry.segmentsByPaths(m, [lakePath(tag, 1), lakePath(other, 1)])).keys(),
        ]).toEqual([lakePath(tag, 1)])
        expect((await registry.segmentsByPaths(machine(other), [lakePath(other, 1)])).size).toBe(0)

        expect(Object.fromEntries(await registry.parentPodiumIds([child, foreign.child]))).toEqual({
          [child]: root,
        })
        expect(
          Object.fromEntries(await registry.nativeIdsByPodiumIds([root, foreign.root])),
        ).toEqual({
          [root]: [nat(tag, 1), nat(tag, 3)],
        })
        expect(
          Object.fromEntries(await registry.pathsByNativeIds(m, [nat(tag, 1), nat(tag, 2)])),
        ).toEqual({
          [nat(tag, 1)]: lakePath(tag, 1),
          [nat(tag, 2)]: lakePath(tag, 2),
        })
        expect((await registry.pathsByNativeIds(machine(other), [nat(other, 1)])).size).toBe(0)
        expect(await registry.segmentPath(m, nat(tag, 2))).toBe(lakePath(tag, 2))
        expect(await registry.segmentPath(machine(other), nat(other, 2))).toBeUndefined()

        const siblings = [
          { machineId: m, nativeId: nat(tag, 1) },
          { machineId: m, nativeId: nat(tag, 3) },
        ]
        expect(await registry.siblingSegments(m, nat(tag, 3))).toEqual(siblings)
        expect(await registry.siblingSegments(machine(other), nat(other, 1))).toEqual([])
        expect(
          await registry.siblingSegmentsMany([
            { machineId: m, nativeId: nat(tag, 1) },
            { machineId: machine(other), nativeId: nat(other, 1) },
          ]),
        ).toEqual([siblings, []])
      }
    })

    it('ensure, ensureMany and linkSegment in A leave B unchanged', async () => {
      const { registry } = stores.a.conversations
      const m = machine('a')
      const before = rowsOf(stores.b, 'b')

      // Existing rows: adopt a parent and refresh a file, one at a time and many at once.
      const third = await registry.ensure({ machineId: m, nativeId: nat('a', 5), providerId: 'p' })
      await registry.ensure({
        machineId: m,
        nativeId: nat('a', 5),
        providerId: 'p',
        parentPodiumId: seeded.a.root,
        path: '/lake/a/5.jsonl',
        sizeBytes: 5,
      })
      const many = await registry.ensureMany(m, [
        { nativeId: nat('a', 2), providerId: 'p', path: '/lake/a/2b.jsonl', sizeBytes: 9 },
        { nativeId: nat('a', 6), providerId: 'p', parentPodiumId: seeded.a.root },
        { nativeId: nat('a', 5), providerId: 'p', parentPodiumId: seeded.a.child },
      ])
      expect(many.get(nat('a', 5))).toBe(third)
      await registry.linkSegment({
        machineId: m,
        newNativeId: nat('a', 7),
        priorNativeId: nat('a', 6),
        providerId: 'p',
      })

      expect(rowsOf(stores.b, 'b')).toEqual(before)
      expect(await registry.segmentPath(m, nat('a', 2))).toBe('/lake/a/2b.jsonl')
      expect((await registry.parentPodiumIds([third])).get(third)).toBe(seeded.a.root)
      expect(await registry.siblingSegments(m, nat('a', 7))).toEqual([
        { machineId: m, nativeId: nat('a', 6) },
        { machineId: m, nativeId: nat('a', 7) },
      ])
    })
  })

  describe('the transcript mirror', () => {
    it('reads cursors, incarnations and the lake conversion pages only from its own workspace', async () => {
      for (const tag of ['a', 'b'] as const) {
        const { mirror } = stores[tag].conversations
        const other = tag === 'a' ? 'b' : 'a'
        const m = machine(tag)

        expect((await mirror.segmentsToMirror(m)).map((row) => row.nativeId)).toEqual([
          nat(tag, 1),
          nat(tag, 2),
        ])
        expect(await mirror.segmentsToMirror(machine(other))).toEqual([])
        expect((await mirror.segmentsToMirrorDirty(m)).map((row) => row.nativeId)).toEqual([
          nat(tag, 1),
          nat(tag, 2),
        ])
        expect(await mirror.segmentsToMirrorDirty(machine(other))).toEqual([])

        expect(await mirror.reportedBytes(m, nat(tag, 2))).toBe(200)
        expect(await mirror.reportedBytes(machine(other), nat(other, 2))).toBeUndefined()
        expect(await mirror.mirrorCursor(m, nat(tag, 1))).toBe(40)
        expect(await mirror.mirrorCursor(machine(other), nat(other, 1))).toBe(0)

        expect(await mirror.activeIncarnation(m, nat(tag, 1))).toEqual({
          sequence: 2,
          device: 'd1',
          inode: `${tag}-i2`,
        })
        expect(await mirror.activeIncarnation(machine(other), nat(other, 1))).toBeUndefined()
        expect((await mirror.incarnations(m, nat(tag, 1))).map((row) => row.inode)).toEqual([
          `${tag}-i1`,
          `${tag}-i2`,
        ])
        expect(await mirror.incarnations(machine(other), nat(other, 1))).toEqual([])

        expect(await mirror.lakeConversionSegments(undefined, 10)).toEqual([
          { machineId: m, nativeId: nat(tag, 1), mirroredBytes: 40, activeSequence: 2 },
        ])
        expect(
          await mirror.lakeConversionSegments({ machineId: asMachineId(''), nativeId: '' }, 10),
        ).toEqual([{ machineId: m, nativeId: nat(tag, 1), mirroredBytes: 40, activeSequence: 2 }])
        expect(await mirror.lakeConversionArchived(undefined, 10)).toEqual([
          { machineId: m, nativeId: nat(tag, 1), sequence: 1, mirroredBytes: 60 },
        ])
        expect(
          await mirror.lakeConversionArchived(
            { machineId: asMachineId(''), nativeId: '', sequence: 0 },
            10,
          ),
        ).toEqual([{ machineId: m, nativeId: nat(tag, 1), sequence: 1, mirroredBytes: 60 }])
      }
    })

    it('cursor writes and rotations in A leave B unchanged, even aimed at B’s segments', async () => {
      const { mirror } = stores.a.conversations
      const before = rowsOf(stores.b, 'b')
      const mb = machine('b')

      await mirror.setReportedBytes(mb, nat('b', 2), 999)
      expect(await mirror.setMirrorCursor(mb, nat('b', 1), 40, 99, AT)).toBe(false)
      expect(
        await mirror.rotateIncarnation(
          mb,
          nat('b', 1),
          { sequence: 2, device: 'd1', inode: 'b-i2' },
          { device: 'd1', inode: 'stolen' },
          40,
          AT,
        ),
      ).toBe(false)
      expect(rowsOf(stores.b, 'b')).toEqual(before)

      // A's own writes land, and B still holds what it held.
      const m = machine('a')
      await mirror.setReportedBytes(m, nat('a', 2), 250)
      expect(await mirror.setMirrorCursor(m, nat('a', 1), 40, 80, AT)).toBe(true)
      await mirror.startIncarnation(m, nat('a', 2), { device: 'd2', inode: 'a-j1' }, AT)
      expect(
        await mirror.rotateIncarnation(
          m,
          nat('a', 2),
          { sequence: 1, device: 'd2', inode: 'a-j1' },
          { device: 'd2', inode: 'a-j2' },
          10,
          AT,
        ),
      ).toBe(true)
      expect(await mirror.reportedBytes(m, nat('a', 2))).toBe(250)
      expect(rowsOf(stores.b, 'b')).toEqual(before)
    })
  })

  describe('the transcript index', () => {
    it('reads cursors, rows and search matches only from its own workspace', async () => {
      for (const tag of ['a', 'b'] as const) {
        const { transcriptIndex } = stores[tag].conversations
        const other = tag === 'a' ? 'b' : 'a'
        const m = machine(tag)

        expect(await transcriptIndex.segmentsToIndex(m)).toEqual([
          { nativeId: nat(tag, 1), mirroredBytes: 40, indexedBytes: 20 },
        ])
        expect(await transcriptIndex.segmentsToIndex(machine(other))).toEqual([])
        expect(await transcriptIndex.indexedCursor(m, nat(tag, 1))).toBe(20)
        expect(await transcriptIndex.indexedCursor(machine(other), nat(other, 1))).toBe(0)

        expect((await transcriptIndex.rows(m, nat(tag, 1))).map((row) => row.content)).toEqual([
          `needle shared ${tag} one`,
          'needle two',
        ])
        expect(await transcriptIndex.rows(machine(other), nat(other, 1))).toEqual([])

        // Both workspaces hold "needle two": a match is only ever this workspace's row.
        const matches = await transcriptIndex.searchCandidates('needle')
        expect(matches).toHaveLength(2)
        for (const match of matches) {
          expect(match.machineId).toBe(m)
          expect(match.nativeId).toBe(nat(tag, 1))
          expect(match.podiumId).toBe(seeded[tag].root)
          expect(match.title).toBe(`shared ${tag} name`)
        }
      }
    })

    it('an append, a drop and a reset in A leave B unchanged, even aimed at B’s segments', async () => {
      const { transcriptIndex } = stores.a.conversations
      const before = rowsOf(stores.b, 'b')
      const bFts = ftsRowsOf(stores.b, 'b')
      const mb = machine('b')

      await transcriptIndex.drop(mb, nat('b', 1))
      expect(
        await transcriptIndex.resetMissingLake(mb, nat('b', 1), {
          mirroredBytes: 40,
          indexedBytes: 20,
        }),
      ).toBe(false)
      expect(rowsOf(stores.b, 'b')).toEqual(before)
      expect(ftsRowsOf(stores.b, 'b')).toEqual(bFts)

      const m = machine('a')
      await transcriptIndex.append(m, nat('a', 2), [{ content: 'needle three' }], 5)
      await transcriptIndex.drop(m, nat('a', 1))
      expect(await transcriptIndex.rows(m, nat('a', 1))).toEqual([])
      expect(
        await transcriptIndex.resetMissingLake(m, nat('a', 2), {
          mirroredBytes: 0,
          indexedBytes: 5,
        }),
      ).toBe(true)
      expect(await transcriptIndex.rows(m, nat('a', 2))).toEqual([])
      expect(await stores.a.conversations.transcriptIndex.searchCandidates('needle')).toEqual([])

      expect(rowsOf(stores.b, 'b')).toEqual(before)
      expect(ftsRowsOf(stores.b, 'b')).toEqual(bFts)
      expect(await stores.b.conversations.transcriptIndex.searchCandidates('needle')).toHaveLength(
        2,
      )
    })
  })

  describe('the search key table’s workspace column', () => {
    /** Put the key table back in its shape from before the column, keeping its rows. */
    function oldKeyTable(store: SessionStore): void {
      rawDb(store).exec(`
        CREATE TABLE keys_before AS SELECT fts_rowid, machine_id, native_id FROM transcript_fts_keys;
        DROP TABLE transcript_fts_keys;
        CREATE TABLE transcript_fts_keys (
          fts_rowid INTEGER PRIMARY KEY, machine_id TEXT NOT NULL, native_id TEXT NOT NULL);
        INSERT INTO transcript_fts_keys SELECT * FROM keys_before;
        DROP TABLE keys_before;
        CREATE INDEX idx_transcript_fts_keys_segment ON transcript_fts_keys (machine_id, native_id);`)
    }

    const workspaceColumn = (store: SessionStore) =>
      rawDb(store)
        .prepare(
          `SELECT "notnull" AS not_null FROM pragma_table_info('transcript_fts_keys') WHERE name = 'workspace_id'`,
        )
        .all()

    it('is made with the table, non-null', () => {
      expect(workspaceColumn(stores.a)).toEqual([{ not_null: 1 }])
    })

    it('is made again with it when the index opens, and each workspace keys its own segments’ rows', async () => {
      oldKeyTable(stores.a)
      expect(workspaceColumn(stores.a)).toEqual([])
      const contents = async (tag: Tag) =>
        (await stores[tag].conversations.transcriptIndex.rows(machine(tag), nat(tag, 1))).map(
          (row) => row.content,
        )

      await stores.a.conversations.transcriptIndex.enableFts()
      expect(workspaceColumn(stores.a)).toEqual([{ not_null: 1 }])
      expect(await contents('a')).toEqual(['needle shared a one', 'needle two'])
      // B's rows are not A's: they wait, unkeyed, for B's own open.
      expect(await contents('b')).toEqual([])
      expect(
        rawDb(stores.a)
          .prepare('SELECT DISTINCT workspace_id AS ws FROM transcript_fts_keys')
          .all(),
      ).toEqual([{ ws: WS.a }])

      await stores.b.conversations.transcriptIndex.enableFts()
      expect(await contents('b')).toEqual(['needle shared b one', 'needle two'])
      expect(await contents('a')).toEqual(['needle shared a one', 'needle two'])
      expect(rowsOf(stores.a, 'a').transcript_fts_keys).toHaveLength(2)
      expect(rowsOf(stores.b, 'b').transcript_fts_keys).toHaveLength(2)
      expect(await stores.b.conversations.transcriptIndex.searchCandidates('shared')).toHaveLength(
        1,
      )
    })
  })

  describe('a transcript row whose segment no workspace holds', () => {
    it('is the self-hosted workspace’s: its search finds it, no other workspace’s does', async () => {
      const [local, other] = await openWorkspaceStores([SELF_HOSTED_WORKSPACE_ID, 'ws_other'], {
        path: ':memory:',
      })
      try {
        for (const store of [local, other]) await store.conversations.ensureFts(true)
        // A row with no segment row anywhere, as an older build left it: no key.
        rawDb(local)
          .prepare('INSERT INTO transcript_fts (content, machine_id, native_id) VALUES (?, ?, ?)')
          .run('orphan needle', 'gone-machine', 'gone-native')

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
          rawDb(local).prepare('SELECT DISTINCT workspace_id AS ws FROM transcript_fts_keys').all(),
        ).toEqual([{ ws: SELF_HOSTED_WORKSPACE_ID }])
      } finally {
        await local.close()
      }
    })
  })
})
