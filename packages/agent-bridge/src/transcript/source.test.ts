import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/protocol'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { decodeCursor } from './cursor-codec.js'
import type { ChainEntry } from './file-chain.js'
import { fileIdFor } from './file-chain.js'
import {
  fileChainSource,
  opencodeDbSource,
  stampOpencodeItems,
  transcriptSourceFor,
} from './source.js'

// ---------------------------------------------------------------------------
// File-chain source fixtures (mirrors slice.test.ts twoFiles()).
// ---------------------------------------------------------------------------

const rec = (uuid: string, type: string, text: string) =>
  JSON.stringify({
    uuid,
    type,
    message: { role: type, content: [{ type: 'text', text }] },
    timestamp: '2026-06-22T00:00:00Z',
  })

interface TestRecord {
  uuid: string
  type: string
  message: { content: { text: string }[] }
}

const idxToItems = (r: unknown): TranscriptItem[] => {
  const t = r as TestRecord
  return [
    { id: t.uuid, role: t.type, text: t.message.content[0]?.text },
  ] as unknown as TranscriptItem[]
}

/** Two chained JSONL files: f1 holds items 0..4, f2 holds items 5..9. */
async function twoFiles(): Promise<{ chain: ChainEntry[]; toItems: typeof idxToItems }> {
  const dir = await mkdtemp(join(tmpdir(), 'src-chain-'))
  const f1 = join(dir, 'a.jsonl')
  const f2 = join(dir, 'b.jsonl')
  const lines1 = [0, 1, 2, 3, 4].map((i) => rec(`u${i}`, 'user', String(i)))
  const lines2 = [5, 6, 7, 8, 9].map((i) => rec(`u${i}`, 'user', String(i)))
  await writeFile(f1, `${lines1.join('\n')}\n`)
  await writeFile(f2, `${lines2.join('\n')}\n`)
  const chain: ChainEntry[] = [
    { path: f1, fileId: fileIdFor(f1) },
    { path: f2, fileId: fileIdFor(f2) },
  ]
  return { chain, toItems: idxToItems }
}

describe('fileChainSource', () => {
  it('delegates a no-anchor before read to the chain reader (newest limit + hasMore)', async () => {
    const { chain, toItems } = await twoFiles()
    const src = fileChainSource(chain, toItems)
    const r = await src.readSlice({ direction: 'before', limit: 3 })
    expect(r.items.map((i) => i.text)).toEqual(['7', '8', '9'])
    expect(r.hasMore).toBe(true)
    expect(r.head).toBe(r.items[0]?.cursor)
    expect(r.tail).toBe(r.items.at(-1)?.cursor)
  })

  it('pages before an anchor across the file boundary (same as readTranscriptSlice)', async () => {
    const { chain, toItems } = await twoFiles()
    const src = fileChainSource(chain, toItems)
    const first = await src.readSlice({ direction: 'before', limit: 3 }) // 7,8,9
    const older = await src.readSlice({ anchor: first.head, direction: 'before', limit: 3 })
    expect(older.items.map((i) => i.text)).toEqual(['4', '5', '6'])
    expect(older.hasMore).toBe(true)
  })

  it('empty chain → empty result', async () => {
    const src = fileChainSource([], idxToItems)
    const r = await src.readSlice({ direction: 'before', limit: 5 })
    expect(r.items).toEqual([])
    expect(r.hasMore).toBe(false)
    expect(r.head).toBeUndefined()
    expect(r.tail).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// opencode DB source fixtures.
// ---------------------------------------------------------------------------

type TestDatabase = {
  exec(sql: string): void
  prepare(sql: string): { run(...args: unknown[]): unknown }
  close(): void
}
type DatabaseSyncConstructor = new (path: string) => TestDatabase

let DatabaseSync: DatabaseSyncConstructor | undefined

beforeAll(async () => {
  try {
    DatabaseSync = (await import('node:sqlite')).DatabaseSync as DatabaseSyncConstructor
  } catch {
    DatabaseSync = undefined
  }
})

const OPENCODE_SCHEMA = {
  session: `CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'proj',
    parent_id TEXT,
    slug TEXT NOT NULL DEFAULT 'slug',
    directory TEXT NOT NULL,
    title TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1',
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    revert TEXT,
    permission TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER,
    workspace_id TEXT,
    path TEXT,
    agent TEXT,
    model TEXT,
    cost REAL NOT NULL DEFAULT 0,
    tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write INTEGER NOT NULL DEFAULT 0,
    metadata TEXT
  )`,
  message: `CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
  part: `CREATE TABLE part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
}

interface SeedPart {
  partId: string
  messageId: string
  role: 'user' | 'assistant'
  /** part `data` JSON object */
  part: Record<string, unknown>
  timeUpdated: number
}

/** Build a temp opencode home with one session and a list of parts, in the order
 *  given. Each part rides its own message row (role lives on the message). */
async function seedOpencode(sessionId: string, parts: SeedPart[]): Promise<{ homeDir: string }> {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable')
  const homeDir = await mkdtemp(join(tmpdir(), 'src-oc-home-'))
  const root = join(homeDir, '.local', 'share', 'opencode')
  await mkdir(root, { recursive: true })
  const db = new DatabaseSync(join(root, 'opencode.db'))
  db.exec(OPENCODE_SCHEMA.session)
  db.exec(OPENCODE_SCHEMA.message)
  db.exec(OPENCODE_SCHEMA.part)
  db.prepare(
    `INSERT INTO session (id, directory, title, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, '/repo/oc', 't', 1, 2)
  const seenMessages = new Set<string>()
  const insMsg = db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const insPart = db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const p of parts) {
    if (!seenMessages.has(p.messageId)) {
      seenMessages.add(p.messageId)
      insMsg.run(
        p.messageId,
        sessionId,
        p.timeUpdated,
        p.timeUpdated,
        JSON.stringify({ role: p.role }),
      )
    }
    insPart.run(
      p.partId,
      p.messageId,
      sessionId,
      p.timeUpdated,
      p.timeUpdated,
      JSON.stringify(p.part),
    )
  }
  db.close()
  return { homeDir }
}

/** A text part. */
function textPart(
  partId: string,
  messageId: string,
  role: 'user' | 'assistant',
  text: string,
  timeUpdated: number,
): SeedPart {
  return { partId, messageId, role, timeUpdated, part: { type: 'text', text } }
}

describe('opencodeDbSource', () => {
  it('returns empty when the DB cannot be opened', async () => {
    const src = opencodeDbSource({ sessionId: 'nope', homeDir: '/no/such/dir' })
    const r = await src.readSlice({ direction: 'before', limit: 5 })
    expect(r.items).toEqual([])
    expect(r.hasMore).toBe(false)
  })

  it('no-anchor before returns the newest `limit` items with hasMore', async () => {
    if (!DatabaseSync) return
    const sid = 'ses_a'
    // 5 text parts at increasing time_updated.
    const parts = [0, 1, 2, 3, 4].map((i) =>
      textPart(`prt-${i}`, `msg-${i}`, i % 2 === 0 ? 'user' : 'assistant', `m${i}`, 100 + i),
    )
    const { homeDir } = await seedOpencode(sid, parts)
    const src = opencodeDbSource({ sessionId: sid, homeDir })
    const r = await src.readSlice({ direction: 'before', limit: 3 })
    expect(r.items.map((i) => i.text)).toEqual(['m2', 'm3', 'm4'])
    expect(r.hasMore).toBe(true)
  })

  it('cursors decode to {fileId: opencode:<sid>, offset: timeUpdated, uuid: partId, sub}', async () => {
    if (!DatabaseSync) return
    const sid = 'ses_b'
    const parts = [textPart('prt-x', 'msg-x', 'user', 'hello', 555)]
    const { homeDir } = await seedOpencode(sid, parts)
    const src = opencodeDbSource({ sessionId: sid, homeDir })
    const r = await src.readSlice({ direction: 'before', limit: 5 })
    const item = r.items[0]
    expect(item).toBeDefined()
    const c = decodeCursor(item?.cursor ?? '')
    expect(c).not.toBeNull()
    expect(c?.fileId).toBe(`opencode:${sid}`)
    expect(c?.offset).toBe(555)
    expect(c?.uuid).toBe('prt-x')
    expect(c?.sub).toBe(0)
  })

  it('before-anchor pages the previous window with no gap/overlap', async () => {
    if (!DatabaseSync) return
    const sid = 'ses_c'
    const parts = [0, 1, 2, 3, 4, 5].map((i) =>
      textPart(`prt-${i}`, `msg-${i}`, 'user', `m${i}`, 100 + i),
    )
    const { homeDir } = await seedOpencode(sid, parts)
    const src = opencodeDbSource({ sessionId: sid, homeDir })
    const first = await src.readSlice({ direction: 'before', limit: 2 }) // m4, m5
    expect(first.items.map((i) => i.text)).toEqual(['m4', 'm5'])
    const older = await src.readSlice({ anchor: first.head, direction: 'before', limit: 2 })
    expect(older.items.map((i) => i.text)).toEqual(['m2', 'm3'])
    expect(older.hasMore).toBe(true)
  })

  it('after-anchor catches up newer items with correct hasMore', async () => {
    if (!DatabaseSync) return
    const sid = 'ses_d'
    const parts = [0, 1, 2, 3, 4, 5].map((i) =>
      textPart(`prt-${i}`, `msg-${i}`, 'user', `m${i}`, 100 + i),
    )
    const { homeDir } = await seedOpencode(sid, parts)
    const src = opencodeDbSource({ sessionId: sid, homeDir })
    const all = await src.readSlice({ direction: 'before', limit: 10 })
    const m2 = all.items.find((i) => i.text === 'm2')
    expect(m2).toBeDefined()
    // items after m2: m3, m4, m5 → limit 2 → [m3, m4], hasMore true (m5 follows)
    const after = await src.readSlice({ anchor: m2?.cursor, direction: 'after', limit: 2 })
    expect(after.items.map((i) => i.text)).toEqual(['m3', 'm4'])
    expect(after.hasMore).toBe(true)
    // anchor on m3: m4, m5 follow → limit 2 → [m4, m5], hasMore false (exact tail)
    const m3 = all.items.find((i) => i.text === 'm3')
    const after2 = await src.readSlice({ anchor: m3?.cursor, direction: 'after', limit: 2 })
    expect(after2.items.map((i) => i.text)).toEqual(['m4', 'm5'])
    expect(after2.hasMore).toBe(false)
  })

  it('hasMore is false at the head of the session', async () => {
    if (!DatabaseSync) return
    const sid = 'ses_e'
    const parts = [0, 1, 2].map((i) => textPart(`prt-${i}`, `msg-${i}`, 'user', `m${i}`, 100 + i))
    const { homeDir } = await seedOpencode(sid, parts)
    const src = opencodeDbSource({ sessionId: sid, homeDir })
    const r = await src.readSlice({ direction: 'before', limit: 100 })
    expect(r.items.map((i) => i.text)).toEqual(['m0', 'm1', 'm2'])
    expect(r.hasMore).toBe(false)
  })

  it('a tool part yields 2 items (sub 0=call, 1=result) and pages correctly mid-part', async () => {
    if (!DatabaseSync) return
    const sid = 'ses_f'
    const toolPart: SeedPart = {
      partId: 'prt-tool',
      messageId: 'msg-tool',
      role: 'assistant',
      timeUpdated: 200,
      part: {
        type: 'tool',
        tool: 'Bash',
        callID: 'call_1',
        state: { input: { command: 'ls' }, output: 'file.txt' },
      },
    }
    // surround the tool part with a before-text and an after-text part.
    const parts = [
      textPart('prt-before', 'msg-before', 'user', 'run it', 199),
      toolPart,
      textPart('prt-after', 'msg-after', 'assistant', 'done', 201),
    ]
    const { homeDir } = await seedOpencode(sid, parts)
    const src = opencodeDbSource({ sessionId: sid, homeDir })
    const all = await src.readSlice({ direction: 'before', limit: 10 })
    // 4 items: text, tool-call, tool-result, text
    expect(all.items.length).toBe(4)
    const call = all.items[1]
    const result = all.items[2]
    expect(call).toBeDefined()
    expect(result).toBeDefined()
    const cCall = decodeCursor(call?.cursor ?? '')
    const cResult = decodeCursor(result?.cursor ?? '')
    expect(cCall?.uuid).toBe('prt-tool')
    expect(cCall?.sub).toBe(0)
    expect(cResult?.uuid).toBe('prt-tool')
    expect(cResult?.sub).toBe(1)
    // Page after the tool-CALL item (sub 0 mid-part): must return the tool-RESULT
    // (sub 1) next, then the trailing text — i.e. the intra-part sub ordering holds.
    const after = await src.readSlice({ anchor: call?.cursor, direction: 'after', limit: 1 })
    expect(after.items.length).toBe(1)
    expect(decodeCursor(after.items[0]?.cursor ?? '')?.sub).toBe(1)
    expect(after.hasMore).toBe(true)
  })

  it('disambiguates same-timeUpdated parts by partId (full-cursor anchor match)', async () => {
    if (!DatabaseSync) return
    const sid = 'ses_g'
    // Three parts share the SAME time_updated; order is by (time_updated, id).
    const parts = [
      textPart('prt-a', 'msg-1', 'user', 'first', 300),
      textPart('prt-b', 'msg-1', 'user', 'second', 300),
      textPart('prt-c', 'msg-1', 'user', 'third', 300),
    ]
    const { homeDir } = await seedOpencode(sid, parts)
    const src = opencodeDbSource({ sessionId: sid, homeDir })
    const all = await src.readSlice({ direction: 'before', limit: 10 })
    expect(all.items.map((i) => i.text)).toEqual(['first', 'second', 'third'])
    // Anchor on the MIDDLE part (same offset as its neighbours). Drift-matching on
    // {offset,sub} alone would be ambiguous; the full {offset,uuid,sub} must pick
    // exactly prt-b, so before→[first], after→[third].
    const second = all.items[1]
    const before = await src.readSlice({ anchor: second?.cursor, direction: 'before', limit: 10 })
    expect(before.items.map((i) => i.text)).toEqual(['first'])
    const after = await src.readSlice({ anchor: second?.cursor, direction: 'after', limit: 10 })
    expect(after.items.map((i) => i.text)).toEqual(['third'])
  })
})

describe('stampOpencodeItems (shared by live observer + DB read)', () => {
  it('stamps rows with the same cursors opencodeDbSource produces (live↔read interop)', async () => {
    if (!DatabaseSync) return
    const sid = 'ses_stamp'
    const parts = [0, 1, 2].map((i) =>
      textPart(`prt-${i}`, `msg-${i}`, i % 2 === 0 ? 'user' : 'assistant', `m${i}`, 500 + i),
    )
    const { homeDir } = await seedOpencode(sid, parts)
    const { openOpencodeDb, loadOpencodeTranscriptTail } = await import('../opencode/db.js')
    const db = openOpencodeDb(homeDir)
    if (!db) throw new Error('db open failed')
    const rows = loadOpencodeTranscriptTail(db, sid)
    db.close()
    // Stamping the raw rows (the live-observer path) yields items cursor-identical
    // to what the on-demand read source returns (the read path).
    const stamped = stampOpencodeItems(rows, sid)
    const read = await opencodeDbSource({ sessionId: sid, homeDir }).readSlice({
      direction: 'before',
      limit: 100,
    })
    expect(stamped.map((i) => i.cursor)).toEqual(read.items.map((i) => i.cursor))
    expect(stamped.map((i) => i.text)).toEqual(['m0', 'm1', 'm2'])
    // Cursor namespace is derived from the sessionId.
    expect(decodeCursor(stamped[0]?.cursor ?? '')?.fileId).toBe(`opencode:${sid}`)
  })

  it('returns [] for no rows', () => {
    expect(stampOpencodeItems([], 'ses_empty')).toEqual([])
  })
})

describe('transcriptSourceFor', () => {
  afterEach(() => {
    delete process.env.HOME
  })

  it('routes agentKind opencode to the DB source (reads items through it)', async () => {
    if (!DatabaseSync) return
    const sid = 'ses_route'
    const parts = [textPart('prt-r', 'msg-r', 'user', 'routed', 400)]
    const { homeDir } = await seedOpencode(sid, parts)
    const src = await transcriptSourceFor({
      agentKind: 'opencode',
      cwd: '/repo/oc',
      resumeValue: sid,
      homeDir,
    })
    const r = await src.readSlice({ direction: 'before', limit: 5 })
    expect(r.items.map((i) => i.text)).toEqual(['routed'])
    expect(decodeCursor(r.items[0]?.cursor ?? '')?.fileId).toBe(`opencode:${sid}`)
  })

  it('opencode with no resumeValue yields an empty source', async () => {
    const src = await transcriptSourceFor({ agentKind: 'opencode', cwd: '/repo/oc' })
    const r = await src.readSlice({ direction: 'before', limit: 5 })
    expect(r.items).toEqual([])
    expect(r.hasMore).toBe(false)
  })

  it('routes a file-based harness (claude-code) to a file-chain source', async () => {
    const { chain } = await twoFiles()
    // Point a claude bucket at our two files by resolving through a temp home.
    // Simpler: assert routing by reading a grok one-file chain we control via home.
    const home = await mkdtemp(join(tmpdir(), 'src-route-claude-'))
    const bucketDir = join(
      home,
      '.claude',
      'projects',
      // claudeProjectSlug('/repo/x') — replicate the slug shape: leading dash, slashes→dashes.
      '-repo-x',
    )
    await mkdir(bucketDir, { recursive: true })
    // Reuse the same JSONL content as twoFiles' second file.
    await writeFile(
      join(bucketDir, 'conv.jsonl'),
      `${[5, 6, 7, 8, 9].map((i) => rec(`u${i}`, 'user', String(i))).join('\n')}\n`,
    )
    const src = await transcriptSourceFor({
      agentKind: 'claude-code',
      cwd: '/repo/x',
      homeDir: home,
    })
    const r = await src.readSlice({ direction: 'before', limit: 3 })
    // claudeRecordToItems maps these synthetic records; assert it is NOT the opencode
    // source by checking the cursor fileId is the file-hash id, not 'opencode:...'.
    expect(r.items.length).toBeGreaterThan(0)
    const fid = decodeCursor(r.items[0]?.cursor ?? '')?.fileId
    expect(fid).not.toMatch(/^opencode:/)
    void chain
  })
})
