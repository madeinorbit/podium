import { asMachineId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

/**
 * A RE-DISCOVERY THAT CHANGES NOTHING MUST WRITE NOTHING [POD-1931].
 *
 * Discovery re-offers the whole conversation corpus every sweep, so the steady
 * state is thousands of upserts whose values already match the stored row. Each
 * such rewrite is not free: `conversations` carries the `conversations_au`
 * trigger, so one no-op UPDATE is an fts5 delete AND re-insert. Measured on the
 * live server before this guard: 1786 zero-change writes per 4 minutes, 1650 of
 * them inside a single 757ms event-loop stall.
 *
 * The conserved quantity is the NUMBER OF ROW WRITES, not a duration — these
 * assert it with the same mechanism whose cost is being avoided, a trigger that
 * records every UPDATE that actually fires.
 */
const writeProbe = (store: SessionStore, table: string): (() => number) => {
  const db = (
    store as unknown as {
      db: { exec(sql: string): void; prepare(sql: string): { get(): unknown } }
    }
  ).db
  db.exec(`CREATE TABLE IF NOT EXISTS _write_probe (t TEXT);
    CREATE TRIGGER probe_${table} AFTER UPDATE ON ${table}
    BEGIN INSERT INTO _write_probe VALUES('${table}'); END;`)
  return () =>
    (
      (db.prepare(`SELECT COUNT(*) AS n FROM _write_probe WHERE t = '${table}'`).get() as {
        n: number
      }) ?? { n: 0 }
    ).n
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'native-a',
  agentKind: 'claude-code',
  providerId: 'claude-code-jsonl',
  machineId: asMachineId('m1'),
  title: 'A conversation',
  projectPath: '/repo',
  messageCount: 12,
  ...over,
})

describe('idle re-discovery writes', () => {
  it('re-upserting an identical conversation row does not rewrite it', () => {
    const store = new SessionStore(':memory:')
    store.conversations.index.upsert([row()])
    const writes = writeProbe(store, 'conversations')
    expect(writes()).toBe(0)

    store.conversations.index.upsert([row()])
    store.conversations.index.upsert([row()])
    expect(writes()).toBe(0)

    // A real change still lands — the guard elides no-ops, not updates.
    store.conversations.index.upsert([row({ title: 'Renamed' })])
    expect(writes()).toBe(1)
    const found = store.conversations.index.searchCandidates({})
    expect(found.find((c) => c.id === 'native-a')?.title).toBe('Renamed')
  })

  it('an omitted field is not a change — COALESCE keeps the stored value', () => {
    const store = new SessionStore(':memory:')
    store.conversations.index.upsert([row()])
    const writes = writeProbe(store, 'conversations')

    const { title: _title, projectPath: _projectPath, ...withoutOptionals } = row()
    store.conversations.index.upsert([withoutOptionals])
    expect(writes()).toBe(0)
    const found = store.conversations.index.searchCandidates({})
    expect(found.find((c) => c.id === 'native-a')?.title).toBe('A conversation')
  })

  it('re-ensuring an unchanged segment does not rewrite it', () => {
    const store = new SessionStore(':memory:')
    const opts = {
      machineId: asMachineId('m1'),
      nativeId: 'native-a',
      providerId: 'claude-code-jsonl',
      path: '/transcripts/native-a.jsonl',
      sizeBytes: 4096,
    }
    const podiumId = store.conversations.registry.ensure(opts)
    const writes = writeProbe(store, 'conversation_segments')

    expect(store.conversations.registry.ensure(opts)).toBe(podiumId)
    expect(store.conversations.registry.ensure(opts)).toBe(podiumId)
    expect(writes()).toBe(0)

    // A grown transcript is a real change and still lands.
    expect(store.conversations.registry.ensure({ ...opts, sizeBytes: 8192 })).toBe(podiumId)
    expect(writes()).toBe(1)
    expect(store.conversations.registry.segmentPath(asMachineId('m1'), 'native-a')).toBe(opts.path)
  })
})
