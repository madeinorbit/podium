import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { serverRecordBuilders } from '../sync/record-builders'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_sync-without-boot-reconcile'))
const TS = '2026-11-11T00:00:00.000Z'
type Db = ReturnType<typeof openDatabase>

function beforeUpgrade(): Db {
  expect(cut).toBeGreaterThan(0)
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  return db
}

/** Supply required storage fields while keeping the repair fixture small. */
function insert(db: Db, table: string, values: Record<string, string | number | null>): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string
    type: string
    notnull: number
    dflt_value: unknown
  }[]
  const required = Object.fromEntries(
    columns
      .filter((c) => c.notnull && c.dflt_value === null)
      .map((c) => [c.name, c.type === 'INTEGER' ? 0 : 'fixture']),
  )
  const row = { ...required, ...values }
  const keys = Object.keys(row)
  db.prepare(
    `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
  ).run(...keys.map((key) => row[key]))
}

describe('the upgrade without boot reconcile', () => {
  it('preserves historical repairs, increments existing generations and runs once', () => {
    const db = beforeUpgrade()
    try {
      insert(db, 'users', { id: 'owner', display_name: 'Owner', role: 'admin', created_at: TS })
      insert(db, 'users', { id: 'member', display_name: 'Member', role: 'member', created_at: TS })
      insert(db, 'sessions', {
        id: 'ses_dangling',
        owner_user_id: 'owner',
        agent_kind: 'codex',
        origin_kind: 'spawn',
        status: 'exited',
        machine_id: 'machine:test',
        created_at: TS,
        issue_id: 'gone',
        ref_issue_id: 'gone',
        ref_letter: 'A',
      })
      insert(db, 'issue_ref_letters', { issue_id: 'gone', next_index: 2 })
      for (const [native, path] of [
        ['child', '/logs/parent/subagents/parent.jsonl'],
        ['own', '/logs/parent/subagents/own.jsonl'],
      ]) {
        insert(db, 'conversation_segments', {
          machine_id: 'machine:test',
          native_id: native!,
          provider_id: 'claude-code-jsonl',
          podium_id: `conv_${native}`,
          path: path!,
          seq_in_conv: 0,
          linked_by: 'scan',
          created_at: TS,
        })
      }
      for (const id of ['preparing', 'dispatched']) {
        insert(db, 'superagent_threads', {
          id,
          owner_user_id: 'owner',
          kind: 'btw',
          turn_running: 1,
          created_at: TS,
          updated_at: TS,
        })
      }
      insert(db, 'superagent_pending_turns', {
        turn_id: 'turn',
        owner_user_id: 'owner',
        thread_id: 'dispatched',
        podium_session_id: 'ses_dangling',
        payload_json: '{}',
        created_at: TS,
      })
      db.exec("INSERT INTO sync_kind VALUES ('pendingInteraction', 7)")
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
      expect(db.prepare('SELECT issue_id, ref_issue_id, ref_letter FROM sessions').get()).toEqual({
        issue_id: null,
        ref_issue_id: null,
        ref_letter: null,
      })
      expect(db.prepare('SELECT * FROM issue_ref_letters').all()).toEqual([])
      expect(
        db.prepare('SELECT native_id, path FROM conversation_segments ORDER BY native_id').all(),
      ).toEqual([
        { native_id: 'child', path: null },
        { native_id: 'own', path: '/logs/parent/subagents/own.jsonl' },
      ])
      expect(
        db
          .prepare("SELECT id, turn_running FROM superagent_threads WHERE kind = 'btw' ORDER BY id")
          .all(),
      ).toEqual([
        { id: 'dispatched', turn_running: 1 },
        { id: 'preparing', turn_running: 0 },
      ])
      expect(
        db
          .prepare(
            "SELECT id, owner_user_id FROM superagent_threads WHERE kind = 'global' ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: 'global', owner_user_id: 'owner' },
        { id: 'global:member', owner_user_id: 'member' },
      ])
      const generations = db.prepare('SELECT kind, generation FROM sync_kind ORDER BY kind').all()
      expect(generations.map((r) => r.kind)).toEqual([...serverRecordBuilders().kinds()].sort())
      expect(generations.find((r) => r.kind === 'pendingInteraction')?.generation).toBe(8)
      expect(
        generations.filter((r) => r.kind !== 'pendingInteraction').every((r) => r.generation === 1),
      ).toBe(true)
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
      expect(db.prepare('SELECT kind, generation FROM sync_kind ORDER BY kind').all()).toEqual(
        generations,
      )
    } finally {
      db.close()
    }
  })

  it('rolls the repairs and generation changes back with a failed migration', () => {
    const db = beforeUpgrade()
    try {
      db.exec("INSERT INTO sync_kind VALUES ('session', 9)")
      const failed = [
        ...DRIZZLE_MIGRATIONS,
        {
          name: '20990101000000_failed-upgrade',
          sql: 'INSERT INTO missing_table VALUES (1)',
        },
      ]
      expect(() => runDrizzleMigrations(db, failed)).toThrow()
      expect(db.prepare('SELECT * FROM sync_kind').all()).toEqual([
        { kind: 'session', generation: 9 },
      ])
      expect(
        db
          .prepare("SELECT * FROM sqlite_master WHERE name = 'idx_superagent_threads_running'")
          .all(),
      ).toEqual([])
    } finally {
      db.close()
    }
  })
})
