/**
 * THE SAME-ID SEED OF CONVERSATIONS AND SEARCH, shared by its two-workspace test
 * (`store/conversations/conversations.workspace.test.ts`) and the completeness test
 * (`store/workspace-isolation.test.ts`, POD-7025). Moved here from that test unchanged: both
 * workspaces hold the same ids and natural keys, with content of their own (see the test's
 * header).
 */

import { asMachineId, type ConversationId, type MachineId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { expect } from 'vitest'
import type { ConversationIndexRow } from '../../store/types'
import type { ConversationStoreSlice } from '../conversation-store-slice'
import { testStoreEngine } from '../pg-test-database'

export const ON_PG = testStoreEngine() === 'pg'
export type SessionStore = ConversationStoreSlice

export type Tag = 'a' | 'b'
export const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
export const AT = '2026-11-17T10:00:00.000Z'
export const scope = fixtureWriteScope()

export const MACHINE: MachineId = asMachineId('machine-1')
/** A native id: the conversation id and the segment's native id, the same in both. */
export const nat = (n: number) => `native-${n}`
/** A segment's lake path: content of the segment row, so it differs per workspace. */
export const lakePath = (tag: Tag, n: number) => `/lake/${tag}/${n}.jsonl`
export const PROJECT = '/repo'
/** The bytes a segment reports, has mirrored, had mirrored when it rotated, and has indexed. */
export const reported = (tag: Tag, n: number) => n * 100 + (tag === 'a' ? 0 : 10)
export const mirrored = (tag: Tag) => (tag === 'a' ? 40 : 45)
export const archived = (tag: Tag) => (tag === 'a' ? 60 : 65)
export const indexed = (tag: Tag) => (tag === 'a' ? 20 : 25)
/** A native id only `tag`'s workspace holds. */
export const only = (tag: Tag) => `only-${tag}`

/**
 * The tables this group owns, read raw per workspace in key order, for "unchanged"
 * comparisons. `transcript_rows` is the search rows' workspace record: SQLite's key table,
 * Postgres's `transcript_text`.
 */
export const TABLES = {
  conversations: 'SELECT * FROM conversations WHERE workspace_id = $ws ORDER BY id',
  conversation_identities:
    'SELECT * FROM conversation_identities WHERE workspace_id = $ws ORDER BY podium_id',
  conversation_segments:
    'SELECT * FROM conversation_segments WHERE workspace_id = $ws ORDER BY machine_id, native_id',
  conversation_segment_incarnations:
    'SELECT * FROM conversation_segment_incarnations WHERE workspace_id = $ws ORDER BY machine_id, native_id, sequence',
  transcript_rows: ON_PG
    ? 'SELECT id, workspace_id, machine_id, native_id, content FROM transcript_text WHERE workspace_id = $ws ORDER BY id'
    : 'SELECT * FROM transcript_fts_keys WHERE workspace_id = $ws ORDER BY fts_rowid',
} as const

/** `text` with its one `$ws` bound to `value`. */
export const bound = (text: string, value: string) => {
  const [before, after] = text.split('$ws') as [string, string]
  return sql`${sql.raw(before)}${value}${sql.raw(after)}`
}

export async function rowsOf(store: SessionStore, tag: Tag): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const [table, text] of Object.entries(TABLES)) {
    out[table] = await store.all(bound(text, WS[tag]))
  }
  return out
}

/**
 * Every search row of `tag`'s workspace, its content included: a delete in the other workspace
 * keeps them. The machine is the same in both, so the workspace's key (SQLite) or the row's
 * own column (Postgres) is what says whose a row is.
 */
export const ftsRowsOf = async (store: SessionStore, tag: Tag) =>
  await store.all(
    ON_PG
      ? sql`SELECT id, content FROM transcript_text WHERE workspace_id = ${WS[tag]} ORDER BY id`
      : sql`SELECT f.rowid, f.content FROM transcript_fts f JOIN transcript_fts_keys k ON k.fts_rowid = f.rowid WHERE k.workspace_id = ${WS[tag]} ORDER BY f.rowid`,
  )

export function conversation(tag: Tag, n: number, patch: Partial<ConversationIndexRow> = {}) {
  return {
    id: nat(n),
    agentKind: 'claude-code',
    providerId: 'claude-code',
    title: `shared ${tag} title ${n}`,
    projectPath: PROJECT,
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    updatedAt: `2026-11-0${n}T00:00:00.000Z`,
    messageCount: n,
    machineId: MACHINE,
    ...patch,
  }
}

export interface Seeded {
  /** The podium id of conversation 1 (segments 1 and 3) and of conversation 2 (its child). */
  readonly root: ConversationId
  readonly child: ConversationId
}

/**
 * One workspace's segment `native`, through its own repositories, with a lake path, a mirror
 * cursor, two incarnations (one retired) and transcript rows.
 */
export async function seedSegment(
  store: SessionStore,
  tag: Tag,
  native: string,
  path: string,
): Promise<ConversationId> {
  const { registry, mirror, transcriptIndex } = store.conversations
  const m = MACHINE
  const id = await registry.ensure({
    machineId: m,
    nativeId: native,
    providerId: 'claude-code',
    path,
    sizeBytes: reported(tag, 1),
  })
  expect(await mirror.setMirrorCursor(m, native, 0, archived(tag), AT)).toBe(true)
  await mirror.startIncarnation(m, native, { device: 'd1', inode: `${tag}-i1` }, AT)
  expect(
    await mirror.rotateIncarnation(
      m,
      native,
      { sequence: 1, device: 'd1', inode: `${tag}-i1` },
      { device: 'd1', inode: `${tag}-i2` },
      archived(tag),
      AT,
    ),
  ).toBe(true)
  // The rotation reset the cursor; mirror and index again.
  expect(await mirror.setMirrorCursor(m, native, 0, mirrored(tag), AT)).toBe(true)
  await transcriptIndex.append(
    m,
    native,
    [{ content: `needle shared ${tag} one`, itemUuid: `${tag}-u1` }, { content: 'needle two' }],
    indexed(tag),
  )
  return id
}

/**
 * One workspace's rows, through its own repositories: conversations 1 and 2 (2 a child of 1's
 * identity), segments 1 and 2 with lake paths, segment 3 rolled onto conversation 1, a mirror
 * cursor and two incarnations of segment 1 (one retired), and transcript rows of segment 1.
 */
export async function seed(store: SessionStore, tag: Tag): Promise<Seeded> {
  const { index, registry } = store.conversations
  const m = MACHINE
  await index.upsert(scope, [conversation(tag, 1), conversation(tag, 2)])
  await index.setMeta(scope, nat(1), { name: `shared ${tag} name`, summary: `${tag} summary` })
  const root = await seedSegment(store, tag, nat(1), lakePath(tag, 1))
  const child = await registry.ensure({
    machineId: m,
    nativeId: nat(2),
    providerId: 'claude-code',
    parentPodiumId: root,
    path: lakePath(tag, 2),
    sizeBytes: reported(tag, 2),
  })
  await registry.linkSegment({
    machineId: m,
    newNativeId: nat(3),
    priorNativeId: nat(1),
    providerId: 'claude-code',
  })
  return { root, child }
}
