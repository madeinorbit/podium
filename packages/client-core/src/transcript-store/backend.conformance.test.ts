import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SqlDatabaseLike } from '@podium/sync/adapters/mobile-sqlite'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, describe, expect, it } from 'vitest'
import type { StoredTranscriptMessage, TranscriptStoreBackend } from './backend'
import { openIndexedDbTranscriptBackend } from './indexeddb'
import { createMemoryTranscriptBackend } from './memory'
import { openSqliteTranscriptBackend } from './sqlite'

/** A real SQLite engine (bun:sqlite under the repo lane, node:sqlite otherwise) — never a fake. */
async function sqliteEngine(): Promise<(file: string) => SqlDatabaseLike> {
  for (const [specifier, name] of [
    ['bun:sqlite', 'Database'],
    ['node:sqlite', 'DatabaseSync'],
  ] as const) {
    try {
      const module = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>
      const Database = module[name] as (new (file: string) => SqlDatabaseLike) | undefined
      if (typeof Database === 'function') return (file) => new Database(file)
    } catch {
      // try the next engine
    }
  }
  throw new Error('no real SQLite engine in this runtime')
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const backends: [string, () => Promise<TranscriptStoreBackend>][] = [
  ['memory', async () => createMemoryTranscriptBackend()],
  [
    'indexeddb',
    () =>
      openIndexedDbTranscriptBackend({
        factory: new IDBFactory() as never,
        keyRange: IDBKeyRange as never,
        databaseName: 'podium-transcripts:test',
      }),
  ],
  [
    'sqlite',
    async () => {
      const open = await sqliteEngine()
      const directory = mkdtempSync(join(tmpdir(), 'podium-transcripts-'))
      cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
      const file = join(directory, 'transcripts.db')
      return openSqliteTranscriptBackend({
        open: () => open(file),
        deleteDatabase: () => rmSync(file, { force: true }),
      })
    },
  ],
]

const row = (id: string, seq: number, text = id): StoredTranscriptMessage => ({
  id,
  seq,
  json: JSON.stringify({ id, role: 'assistant', text }),
})

describe.each(backends)('transcript backend conformance: %s', (_name, open) => {
  it('keeps exact counts, bytes and newest order across upserts, removes and ranges', async () => {
    const backend = await open()
    const a = row('a', 0)
    const b = row('b', 1024)
    const c = row('c', 2048)
    let chat = await backend.commit('chat', { upsert: [a, b, c], openedAt: 5, savedAt: 6 })
    expect(chat).toEqual({
      chat: 'chat',
      openedAt: 5,
      savedAt: 6,
      newestSeq: 2048,
      count: 3,
      bytes: a.json.length + b.json.length + c.json.length,
    })
    // Rewriting a row replaces it: one row per message id.
    const longer = row('c', 2048, 'c, now finished streaming')
    chat = await backend.commit('chat', { upsert: [longer] })
    expect(chat.count).toBe(3)
    expect(chat.bytes).toBe(a.json.length + b.json.length + longer.json.length)
    expect(chat.openedAt).toBe(5)
    chat = await backend.commit('chat', { remove: ['c'] })
    expect(chat).toMatchObject({ count: 2, newestSeq: 1024 })
    chat = await backend.commit('chat', { removeBelow: 1024, upsert: [row('d', 4096)] })
    expect((await backend.messages('chat', undefined, 10)).map((m) => m.id)).toEqual(['b', 'd'])
    chat = await backend.commit('chat', { removeFrom: 2000 })
    expect(chat).toMatchObject({ count: 1, newestSeq: 1024, bytes: b.json.length })
    chat = await backend.commit('chat', { clear: true, upsert: [row('e', 0)] })
    expect(chat).toMatchObject({ count: 1, newestSeq: 0 })
  })

  it('reads the newest page before an order, oldest first, and trims to the newest N', async () => {
    const backend = await open()
    const rows = Array.from({ length: 10 }, (_, i) => row(`m${i}`, i * 10))
    const chat = await backend.commit('chat', { upsert: rows, keepNewest: 6 })
    expect(chat.count).toBe(6)
    expect((await backend.messages('chat', undefined, 3)).map((m) => m.id)).toEqual([
      'm7',
      'm8',
      'm9',
    ])
    expect((await backend.messages('chat', 70, 10)).map((m) => m.id)).toEqual(['m4', 'm5', 'm6'])
    expect(await backend.messages('other', undefined, 3)).toEqual([])
  })

  it('removes whole chats, leaves the others, and erases the database', async () => {
    const backend = await open()
    await backend.commit('one', { upsert: [row('a', 0)] })
    await backend.commit('two', { upsert: [row('a', 0)] })
    await backend.remove(['one'])
    expect((await backend.chats()).map((c) => c.chat)).toEqual(['two'])
    expect(await backend.messages('one', undefined, 5)).toEqual([])
    expect(await backend.messages('two', undefined, 5)).toHaveLength(1)
    await backend.erase()
  })
})
