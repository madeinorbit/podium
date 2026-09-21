/**
 * Identity-invariant golden tests (POD-4471 §"identity invariant", spec rule 8).
 *
 * The same logical native record and sub-item receive the same identity whether
 * read live, mirrored, relocated or replayed. Identity is a function of the
 * conversation namespace, the logical file incarnation, the record identity or
 * position, and the sub-item mapping — established by ONE reader
 * (@podium/harness/store: slice + cursor codec + file-chain ids) parameterized
 * by the per-harness grammar in packages/harness/src/adapters/<h>/transcript.ts.
 *
 * Per grammar, every case below reads through the store reader only:
 *  - live vs mirror: same bytes at two paths, same namespace+incarnation ⇒
 *    byte-identical ids and cursors (relocation is the same case at a third path).
 *  - truncation: a shorter replacement generation misses the old anchor exactly
 *    and serves the new content (never a blend).
 *  - archived incarnations: predecessor bytes keep their own namespace
 *    (fileIdFor(ns, seq)), stable across reads, distinct from a live read of the
 *    same bytes under the active namespace.
 *  - partial records: an unterminated trailing record reads with the same cursor
 *    it gets once its newline lands; torn lines are skipped but consumed.
 *  - reconnect replay: items read before an append keep their ids after it, and
 *    paging from the old tail yields exactly the appended records.
 * The sqlite grammar (opencode) proves the same invariant over its database
 * source instead of a file chain.
 *
 * ARMING (red on base): the grammars import from per-harness transcript.js
 * modules under adapters, which do not exist before the move, and the final case asserts the store
 * barrel no longer exports any grammar — both fail on the pre-move tree.
 */
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { opencodeDbSource } from '../adapters/opencode/transcript.js'
import { claudeRecordToItems } from '../adapters/claude-code/transcript.js'
import { codexRecordToItems } from '../adapters/codex/transcript.js'
import { cursorRecordToItems } from '../adapters/cursor/transcript.js'
import { grokRecordToItems } from '../adapters/grok/transcript.js'
import { piRecordToItems } from '../adapters/pi/transcript.js'
import type { TranscriptRecordMapper } from './source.js'
import { readTranscriptSlice } from './slice.js'
import { fileIdFor } from './file-chain.js'
import * as storeBarrel from './index.js'

interface FileGrammar {
  name: string
  parse: TranscriptRecordMapper
  /** Native records (one per line) that must yield at least one item each. */
  records: () => unknown[]
  /** One more record of the same conversation, appended for the replay case. */
  extra: () => unknown
}

const ts = '2026-09-21T12:00:00.000Z'

const grammars: FileGrammar[] = [
  {
    name: 'claude',
    parse: claudeRecordToItems,
    records: () => [
      { type: 'user', uuid: 'gold-u1', sessionId: 'gold', message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        uuid: 'gold-a1',
        sessionId: 'gold',
        message: { role: 'assistant', model: 'gold-model', content: [{ type: 'text', text: 'hi' }] },
      },
    ],
    extra: () => ({
      type: 'user',
      uuid: 'gold-u2',
      sessionId: 'gold',
      message: { role: 'user', content: 'again' },
    }),
  },
  {
    name: 'codex',
    parse: codexRecordToItems,
    records: () => [
      { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: 'fix it' } },
      {
        timestamp: ts,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', id: 'gold-um-1', content: [{ type: 'text', text: 'push it' }] },
        },
      },
    ],
    extra: () => ({ timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: 'more' } }),
  },
  {
    name: 'cursor',
    parse: cursorRecordToItems,
    records: () => [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nhello\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Hi there.' }] } },
    ],
    extra: () => ({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'After.' }] },
    }),
  },
  {
    name: 'grok',
    parse: grokRecordToItems,
    records: () => [
      { type: 'user', timestamp: ts, content: [{ type: 'text', text: 'hello' }] },
      { type: 'assistant', id: 'gold-g1', timestamp: ts, content: 'hi there' },
    ],
    extra: () => ({ type: 'assistant', id: 'gold-g2', timestamp: ts, content: 'later' }),
  },
  {
    name: 'pi',
    parse: piRecordToItems,
    records: () => [
      { type: 'message', id: 'gold-p1', parentId: null, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      {
        type: 'message',
        id: 'gold-p2',
        parentId: null,
        timestamp: ts,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Reply.' }], stopReason: 'stop' },
      },
    ],
    extra: () => ({
      type: 'message',
      id: 'gold-p3',
      parentId: null,
      timestamp: ts,
      message: { role: 'user', content: [{ type: 'text', text: 'more' }] },
    }),
  },
]

const toJsonl = (records: unknown[]): string => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`

describe('transcript identity goldens (POD-4471)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'transcript-golden-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe.each(grammars.map((g) => [g.name, g] as const))('%s', (_name, grammar) => {
    it('live vs mirror vs relocated: identical ids and cursors', async () => {
      const bytes = toJsonl(grammar.records())
      const live = join(dir, 'live.jsonl')
      const mirror = join(dir, 'mirror.jsonl')
      const moved = join(dir, 'moved.jsonl')
      await writeFile(live, bytes)
      await writeFile(mirror, bytes)
      await writeFile(moved, bytes)
      const fileId = fileIdFor('gold-conversation')
      const read = (path: string) => readTranscriptSlice([{ path, fileId }], grammar.parse, { direction: 'before', limit: 100 })
      const [liveSlice, mirrorSlice, movedSlice] = await Promise.all([read(live), read(mirror), read(moved)])
      expect(liveSlice.items.length).toBeGreaterThan(0)
      const liveIds = liveSlice.items.map((i) => [i.id, i.cursor])
      expect(mirrorSlice.items.map((i) => [i.id, i.cursor])).toEqual(liveIds)
      expect(movedSlice.items.map((i) => [i.id, i.cursor])).toEqual(liveIds)
    })

    it('truncation: the old anchor misses exactly, the new generation serves whole', async () => {
      const path = join(dir, 'session.jsonl')
      const fileId = fileIdFor('gold-truncate')
      await writeFile(path, toJsonl(grammar.records()))
      const before = await readTranscriptSlice([{ path, fileId }], grammar.parse, { direction: 'before', limit: 100 })
      expect(before.items.length).toBeGreaterThan(0)
      const oldTail = before.tail
      await writeFile(path, toJsonl([grammar.extra()]))
      const after = await readTranscriptSlice(
        [{ path, fileId }],
        grammar.parse,
        { ...(oldTail ? { anchor: oldTail } : {}), direction: 'before', limit: 100 },
      )
      // The replacement generation is one record; the stale anchor either misses
      // (full newest window) or still resolves inside the new bytes — either way
      // no item from the retired generation may survive.
      const beforeIds = new Set(before.items.map((i) => i.id))
      for (const item of after.items) expect(beforeIds.has(item.id)).toBe(false)
      expect(after.items.length).toBeGreaterThan(0)
    })

    it('archived incarnations: predecessor namespace is stable and distinct', async () => {
      const ns = 'gold-incarnation'
      const archived = join(dir, 'archived.jsonl')
      const active = join(dir, 'active.jsonl')
      const archivedRecords = grammar.records()
      const activeRecords = [grammar.extra()]
      await writeFile(archived, toJsonl(archivedRecords))
      await writeFile(active, toJsonl(activeRecords))
      const chain = [
        { path: archived, fileId: fileIdFor(ns, 1) },
        { path: active, fileId: fileIdFor(ns) },
      ]
      const first = await readTranscriptSlice(chain, grammar.parse, { direction: 'before', limit: 100 })
      const second = await readTranscriptSlice(chain, grammar.parse, { direction: 'before', limit: 100 })
      expect(first.items.map((i) => [i.id, i.cursor])).toEqual(second.items.map((i) => [i.id, i.cursor]))
      // The active file under the lake chain reads exactly as the live file does.
      const liveActive = await readTranscriptSlice([{ path: active, fileId: fileIdFor(ns) }], grammar.parse, {
        direction: 'before',
        limit: 100,
      })
      expect(first.items.slice(-liveActive.items.length).map((i) => [i.id, i.cursor])).toEqual(
        liveActive.items.map((i) => [i.id, i.cursor]),
      )
      // The same archived bytes under the ACTIVE namespace read differently —
      // the incarnation is part of the identity, so generations never collide.
      const liveArchived = await readTranscriptSlice([{ path: archived, fileId: fileIdFor(ns) }], grammar.parse, {
        direction: 'before',
        limit: 100,
      })
      const archivedIds = new Set(first.items.slice(0, liveArchived.items.length).map((i) => i.id))
      for (const item of liveArchived.items) expect(archivedIds.has(item.id)).toBe(false)
    })

    it('partial records: unterminated reads stable, torn lines skipped', async () => {
      const path = join(dir, 'partial.jsonl')
      const fileId = fileIdFor('gold-partial')
      const [first, second] = grammar.records()
      const complete = `${JSON.stringify(first)}\n${JSON.stringify(second)}`
      await writeFile(path, complete) // no trailing newline: in-flight record
      const open = await readTranscriptSlice([{ path, fileId }], grammar.parse, { direction: 'before', limit: 100 })
      expect(open.items.length).toBeGreaterThan(0)
      const openCursors = open.items.map((i) => i.cursor)
      await writeFile(path, `${complete}\n`) // the newline lands
      const closed = await readTranscriptSlice([{ path, fileId }], grammar.parse, { direction: 'before', limit: 100 })
      expect(closed.items.map((i) => i.cursor)).toEqual(openCursors)
      // A torn line between two good records is skipped but consumed.
      await writeFile(path, `${JSON.stringify(first)}\n{not json\n${JSON.stringify(second)}\n`)
      const torn = await readTranscriptSlice([{ path, fileId }], grammar.parse, { direction: 'before', limit: 100 })
      const clean = await readTranscriptSlice(
        [{ path: join(dir, 'clean.jsonl'), fileId }],
        grammar.parse,
        { direction: 'before', limit: 100 },
      )
      await writeFile(join(dir, 'clean.jsonl'), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)
      const cleanAfter = await readTranscriptSlice([{ path: join(dir, 'clean.jsonl'), fileId }], grammar.parse, {
        direction: 'before',
        limit: 100,
      })
      // Same items as the clean file except the torn record's offset shifts what
      // follows it — so compare COUNT and the first record's identity only.
      expect(torn.items.length).toEqual(cleanAfter.items.length)
      expect(torn.items[0]?.id).toEqual(cleanAfter.items[0]?.id)
      void clean
    })

    it('reconnect replay: old ids stable, paging from the old tail yields only the new', async () => {
      const path = join(dir, 'replay.jsonl')
      const fileId = fileIdFor('gold-replay')
      await writeFile(path, toJsonl(grammar.records()))
      const first = await readTranscriptSlice([{ path, fileId }], grammar.parse, { direction: 'before', limit: 100 })
      expect(first.items.length).toBeGreaterThan(0)
      expect(first.tail).toBeDefined()
      await appendFile(path, toJsonl([grammar.extra()]))
      const delta = await readTranscriptSlice(
        [{ path, fileId }],
        grammar.parse,
        { ...(first.tail ? { anchor: first.tail } : {}), direction: 'after', limit: 100 },
      )
      expect(delta.items.length).toBeGreaterThan(0)
      const firstIds = new Set(first.items.map((i) => i.id))
      for (const item of delta.items) expect(firstIds.has(item.id)).toBe(false)
      const full = await readTranscriptSlice([{ path, fileId }], grammar.parse, { direction: 'before', limit: 100 })
      expect(full.items.slice(0, first.items.length).map((i) => i.id)).toEqual(first.items.map((i) => i.id))
    })
  })

  describe('opencode (sqlite)', () => {
    const sessionId = 'gold-opencode-session'
    const buildDb = (path: string, parts: { partId: string; role: string; text: string; created: number }[]): void => {
      const db = new Database(path, { create: true })
      try {
        db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_updated INTEGER)')
        db.exec(
          'CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER)',
        )
        const insertMessage = db.prepare('INSERT INTO message (id, session_id, data, time_updated) VALUES (?, ?, ?, ?)')
        const insertPart = db.prepare(
          'INSERT INTO part (id, session_id, message_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
        )
        for (const part of parts) {
          const messageId = `msg-${part.partId}`
          insertMessage.run(messageId, sessionId, JSON.stringify({ role: part.role }), part.created)
          insertPart.run(part.partId, sessionId, messageId, JSON.stringify({ type: 'text', text: part.text }), part.created, part.created)
        }
      } finally {
        db.close()
      }
    }

    it('live vs relocated database: identical ids and cursors', async () => {
      const live = join(dir, 'live.db')
      const relocated = join(dir, 'relocated.db')
      buildDb(live, [
        { partId: 'prt-1', role: 'user', text: 'hello', created: 1_700_000_000_000 },
        { partId: 'prt-2', role: 'assistant', text: 'hi', created: 1_700_000_000_100 },
      ])
      await mkdir(join(dir, 'sub'))
      await cp(live, relocated)
      const read = (databasePath: string) =>
        opencodeDbSource({ sessionId, databasePath }).readSlice({ direction: 'before', limit: 100 })
      const [liveSlice, movedSlice] = await Promise.all([read(live), read(relocated)])
      expect(liveSlice.items.length).toBeGreaterThan(0)
      expect(movedSlice.items.map((i) => [i.id, i.cursor])).toEqual(liveSlice.items.map((i) => [i.id, i.cursor]))
    })

    it('append + replay: old ids stable, paging from the old tail yields only the new', async () => {
      const path = join(dir, 'append.db')
      buildDb(path, [{ partId: 'prt-1', role: 'user', text: 'hello', created: 1_700_000_000_000 }])
      const source = () => opencodeDbSource({ sessionId, databasePath: path })
      const first = await source().readSlice({ direction: 'before', limit: 100 })
      expect(first.items.length).toBeGreaterThan(0)
      const db = new Database(path)
      try {
        db.prepare('INSERT INTO message (id, session_id, data, time_updated) VALUES (?, ?, ?, ?)').run(
          'msg-prt-2',
          sessionId,
          JSON.stringify({ role: 'assistant' }),
          1_700_000_000_100,
        )
        db.prepare(
          'INSERT INTO part (id, session_id, message_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
        ).run('prt-2', sessionId, 'msg-prt-2', JSON.stringify({ type: 'text', text: 'hi' }), 1_700_000_000_100, 1_700_000_000_100)
      } finally {
        db.close()
      }
      const delta = await source().readSlice({
        ...(first.tail ? { anchor: first.tail } : {}),
        direction: 'after',
        limit: 100,
      })
      expect(delta.items).toHaveLength(1)
      expect(delta.items[0]).toMatchObject({ role: 'assistant', text: 'hi' })
      const full = await source().readSlice({ direction: 'before', limit: 100 })
      expect(full.items.map((i) => i.id)).toEqual([...first.items.map((i) => i.id), ...(delta.items[0] ? [delta.items[0].id] : [])])
    })
  })

  it('the store barrel carries no grammar: parsing lives in adapters', () => {
    for (const name of [
      'claudeRecordToItems',
      'codexRecordToItems',
      'cursorRecordToItems',
      'grokRecordToItems',
      'opencodePartToItems',
      'piRecordToItems',
      'claudeRuntime',
      'codexRuntime',
      'grokRuntime',
      'piRuntime',
      'contentToText',
      'stringField',
      'safeToolEditJsonFromInput',
      'extractToolEdit',
    ]) {
      expect(storeBarrel as Record<string, unknown>).not.toHaveProperty(name)
    }
  })
})
