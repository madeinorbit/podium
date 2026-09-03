import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from './store'
import { forceFeature } from './test-support/features'
import { openTestStore } from './test-support/open-test-store'

/**
 * SEARCH IS ONE SWITCH [PDM-25].
 *
 * The `command-palette` flag that shows Cmd+K also decides whether this boot
 * builds a full-text index at all. Off is not a degraded mode invented here: it
 * is byte-for-byte what a SQLite build without FTS5 has always done — LIKE over
 * `conversations`, no transcript hits — which is why it is safe to make it the
 * default. What these pin is the part that is new: the DDL that must NOT run,
 * the triggers that must go (a write on `conversations` may never depend on
 * them), and that turning search back on recovers everything.
 */

const stores: SessionStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})

function open(path: string): SessionStore {
  const store = openTestStore(path)
  stores.push(store)
  return store
}

/** A file the whole test can reboot: the flag is read once per construction. */
function dbFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'podium-search-flag-')), 'podium.db')
}

const rawDb = (store: SessionStore) =>
  (store as unknown as { db: { prepare(sql: string): { all(...p: unknown[]): unknown[] } } }).db

const triggerNames = (store: SessionStore): string[] =>
  (
    rawDb(store)
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'conversations_a%'",
      )
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .sort()

const hasTable = (store: SessionStore, name: string): boolean =>
  rawDb(store).prepare('SELECT name FROM sqlite_master WHERE name=?').all(name).length > 0

const conversation = (store: SessionStore, over: Record<string, unknown> = {}) => ({
  id: 'native-a',
  agentKind: 'claude-code',
  providerId: 'claude-code-jsonl',
  machineId: store.hostMachineId,
  title: 'the flux capacitor rewrite',
  projectPath: '/repo',
  messageCount: 3,
  ...over,
})

describe('search index gate', () => {
  it('builds nothing at boot when the flag is off, and writes stop paying for it', () => {
    const store = open(dbFile())

    expect(store.searchIndexEnabled).toBe(false)
    expect(hasTable(store, 'conversations_fts')).toBe(false)
    expect(hasTable(store, 'transcript_fts')).toBe(false)
    expect(triggerNames(store)).toEqual([])

    // The whole point of dropping the triggers first: `conversations` stays
    // writable. A trigger pointing at a table that is not there fails EVERY
    // insert, update and delete on the row it hangs off.
    store.conversations.index.upsert([conversation(store)])
    store.conversations.index.upsert([conversation(store, { title: 'renamed' })])

    // And search still answers — through the LIKE fallback that has always
    // covered builds without FTS5.
    expect(
      store.conversations.index.searchCandidates({ query: 'renamed' }).map((r) => r.id),
    ).toEqual(['native-a'])
    expect(store.conversations.transcriptIndex.searchCandidates('renamed')).toEqual([])
  })

  it('builds the tables, the triggers and the index when the flag is on', () => {
    forceFeature('command-palette', true)
    const store = open(dbFile())

    expect(store.searchIndexEnabled).toBe(true)
    expect(hasTable(store, 'conversations_fts')).toBe(true)
    expect(hasTable(store, 'transcript_fts')).toBe(true)
    expect(triggerNames(store)).toEqual([
      'conversations_ad',
      'conversations_ai',
      'conversations_au',
    ])

    store.conversations.index.upsert([conversation(store)])
    expect(
      store.conversations.index.searchCandidates({ query: 'capacitor' }).map((r) => r.id),
    ).toEqual(['native-a'])
  })

  it('turns off and back on across boots: triggers go, tables stay, the index rebuilds', () => {
    const path = dbFile()

    forceFeature('command-palette', true)
    const first = open(path)
    first.conversations.index.upsert([conversation(first)])
    const machineId = first.hostMachineId
    first.close()
    stores.pop()

    forceFeature('command-palette', false)
    const off = open(path)
    expect(off.searchIndexEnabled).toBe(false)
    expect(triggerNames(off)).toEqual([])
    // Never dropped: a stale table costs nothing, and keeping `transcript_fts`
    // is what stops a re-enable from having to re-read the whole lake.
    expect(hasTable(off, 'conversations_fts')).toBe(true)
    expect(hasTable(off, 'transcript_fts')).toBe(true)
    // A row written while search is off is invisible to fts5 — nothing feeds it.
    off.conversations.index.upsert([
      conversation(off, { id: 'native-b', title: 'written while search was off', machineId }),
    ])
    off.close()
    stores.pop()

    forceFeature('command-palette', true)
    const back = open(path)
    expect(triggerNames(back)).toEqual(['conversations_ad', 'conversations_ai', 'conversations_au'])
    // The row that arrived during the dark boot is searchable anyway: enabling
    // runs a full 'rebuild' from `conversations`, so the index cannot lag it.
    expect(
      back.conversations.index.searchCandidates({ query: 'written' }).map((r) => r.id),
    ).toEqual(['native-b'])
  })

  it('keeps indexed transcript rows across an off boot instead of reindexing them', () => {
    const path = dbFile()
    const machineId = asMachineId('11111111-1111-4111-8111-111111111111')

    forceFeature('command-palette', true)
    const first = open(path)
    first.conversations.transcriptIndex.append(
      machineId,
      'native-a',
      [{ content: 'the flux capacitor drifts under load' }],
      512,
    )
    expect(first.conversations.transcriptIndex.searchCandidates('capacitor')).toHaveLength(1)
    first.close()
    stores.pop()

    forceFeature('command-palette', false)
    const off = open(path)
    // Closed for this boot: no hits, no appends, and the durable byte cursor is
    // left exactly where it was so the next enabled boot resumes from it.
    expect(off.conversations.transcriptIndex.searchCandidates('capacitor')).toEqual([])
    off.conversations.transcriptIndex.append(
      machineId,
      'native-a',
      [{ content: 'not indexed while off' }],
      1024,
    )
    off.close()
    stores.pop()

    forceFeature('command-palette', true)
    const back = open(path)
    const hits = back.conversations.transcriptIndex.searchCandidates('capacitor')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.nativeId).toBe('native-a')
    expect(back.conversations.transcriptIndex.rows(machineId, 'native-a')).toHaveLength(1)
  })
})
