import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asUserId, type LayoutWire, layoutRowId } from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import type { Ledger } from '@podium/sync'
import { expect, it } from 'vitest'
import { SessionRegistry } from '../relay'
import { openTestStore } from '../test-support/open-test-store'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const index = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_first-flights-seen-state'))
const through = DRIZZLE_MIGRATIONS.slice(0, index + 1)
const migrationName = DRIZZLE_MIGRATIONS[index]?.name
if (!migrationName) throw new Error('First Flights migration is missing')

it('logs all seven moments for every account present at upgrade, preserves rows, and leaves new accounts eligible', () => {
  expect(index).toBeGreaterThan(0)
  const db = openDatabase(':memory:')
  try {
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, index))
    const add = db.prepare(
      'INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)',
    )
    add.run('existing', 'Existing', 'member', '2026-10-26T00:00:00Z')
    // Even an account created months after development but before upgrade is seeded.
    add.run('recent', 'Recent', 'member', '2027-02-01T00:00:00Z')
    db.prepare('INSERT INTO user_layout (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)').run(
      'existing',
      'tips.seen.first-prompt',
      JSON.stringify('2026-10-26T01:00:00Z'),
      '2026-10-26T01:00:00Z',
    )
    db.prepare('INSERT INTO user_layout (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)').run(
      'existing',
      'tips.enabled',
      JSON.stringify('false'),
      '2026-10-26T01:00:00Z',
    )
    runDrizzleMigrations(db, through)
    const rows = (id: string) =>
      db.prepare('SELECT key, value FROM user_layout WHERE user_id = ?').all(id) as {
        key: string
        value: string
      }[]
    expect(rows('existing')).toHaveLength(8)
    expect(
      JSON.parse(rows('existing').find((r) => r.key === 'tips.seen.first-prompt')?.value ?? 'null'),
    ).toBe('2026-10-26T01:00:00Z')
    expect(
      JSON.parse(rows('existing').find((r) => r.key === 'tips.enabled')?.value ?? 'null'),
    ).toBe('false')
    expect(rows('existing').filter((r) => r.key.startsWith('tips.seen.'))).toHaveLength(7)
    expect(rows('recent')).toHaveLength(7)
    for (const row of rows('recent')) {
      const time = JSON.parse(row.value)
      expect(new Date(time).toISOString()).toBe(time)
    }
    // New member on this established server, even after subsequent boots.
    add.run('later', 'Later', 'member', '2027-02-02T00:00:00Z')
    runDrizzleMigrations(db, through)
    expect(rows('later')).toEqual([])
  } finally {
    db.close()
  }
})

it('a fresh install leaves its generated first admin eligible', () => {
  const db = openDatabase(':memory:')
  try {
    runDrizzleMigrations(db, through)
    // The historical first-admin migration creates an account during the batch.
    expect(db.prepare('SELECT id FROM users').all()).toHaveLength(1)
    expect(db.prepare("SELECT * FROM user_layout WHERE key LIKE 'tips.seen.%'").all()).toEqual([])
    runDrizzleMigrations(db, through)
    expect(db.prepare("SELECT * FROM user_layout WHERE key LIKE 'tips.seen.%'").all()).toEqual([])
  } finally {
    db.close()
  }
})

it('commits the seen-state backfill and its receipt together', () => {
  const db = openDatabase(':memory:')
  try {
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, index))
    const broken = [
      ...through,
      { name: '20990101000000_failed-upgrade', sql: 'INSERT INTO missing_table VALUES (1)' },
    ]
    expect(() => runDrizzleMigrations(db, broken)).toThrow()
    expect(db.prepare("SELECT * FROM user_layout WHERE key LIKE 'tips.seen.%'").all()).toEqual([])
    expect(
      db.prepare('SELECT * FROM __drizzle_migrations WHERE name = ?').all(migrationName),
    ).toEqual([])
    runDrizzleMigrations(db, through)
    expect(db.prepare("SELECT * FROM user_layout WHERE key LIKE 'tips.seen.%'").all()).toHaveLength(
      7,
    )
  } finally {
    db.close()
  }
})

it('publishes upgraded tip rows before scoped bootstrap and keeps them through unrelated layout updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'first-flights-feed-'))
  const path = join(dir, 'store.db')
  const userId = asUserId('existing')
  const otherId = asUserId('other')
  const db = openDatabase(path)
  try {
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, index))
    db.prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)').run(
      userId,
      'Existing',
      'member',
      '2026-01-01T00:00:00Z',
    )
    db.prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)').run(
      otherId,
      'Other',
      'member',
      '2026-01-01T00:00:00Z',
    )
    db.prepare('INSERT INTO user_layout (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)').run(
      userId,
      'tips.enabled',
      JSON.stringify('false'),
      '2026-01-01T00:00:00Z',
    )
  } finally {
    db.close()
  }
  const store = await openTestStore(path)
  let registry: SessionRegistry | undefined
  try {
    // Neither row has a ledger entry yet: one was inserted before upgrade and
    // the other is an ordinary durable layout row written without the service.
    await store.layout.set(otherId, 'dockTab', 'files', '2026-01-01T00:00:00Z')
    registry = await SessionRegistry.create(store, undefined, {
      instanceId: 'default',
      rehearseBoot: true,
    })
    const { ledger } = registry as unknown as { ledger: Ledger }
    const principal: Principal = {
      kind: 'user',
      user: userId,
      device: asDeviceId('dev:tips'),
      capability: asCapabilityRef('cap:tips'),
    }
    const seeded = await store.layout.getSnapshot(userId)
    const seenKeys = Object.keys(seeded)
      .filter((key) => key.startsWith('tips.seen.'))
      .sort()
    expect(seenKeys).toHaveLength(7)
    const world = await ledger.authority.bootstrap(principal)
    const layoutChanges = world.changes.filter((change) => change.entity === 'userLayout')
    expect(layoutChanges.map((change) => change.entityId).sort()).toEqual(
      Object.keys(seeded)
        .map((key) => layoutRowId(userId, key))
        .sort(),
    )
    for (const change of layoutChanges) {
      expect(change.op).toBe('upsert')
      if (change.op === 'upsert') expect((change.value as LayoutWire).userId).toBe(userId)
    }
    // The same full entity snapshot used for subsequent deliveries retains all
    // seven seeded values when another device changes an unrelated layout key.
    await registry.modules.layout.set(userId, { dockTab: 'chat' }, '2026-10-27T20:00:00Z')
    const rows = (await ledger.authority.snapshot('userLayout')) as LayoutWire[]
    const accountRows = Object.fromEntries(
      rows.filter((row) => row.userId === userId).map((row) => [row.key, row.value]),
    )
    expect(accountRows).toEqual({ ...seeded, dockTab: 'chat' })
    expect(accountRows['tips.enabled']).toBe('false')
    expect(rows.find((row) => row.userId === otherId && row.key === 'dockTab')?.value).toBe('files')
    // Boot reconciliation is idempotent and includes removes, not just tips.
    const before = await ledger.cursor()
    await registry.modules.layout.reconcileAllToLedger()
    expect(await ledger.cursor()).toBe(before)
    await store.layout.clear(otherId, 'dockTab')
    await registry.modules.layout.reconcileAllToLedger()
    expect(
      ((await ledger.authority.snapshot('userLayout')) as LayoutWire[]).some(
        (row) => row.userId === otherId && row.key === 'dockTab',
      ),
    ).toBe(false)
  } finally {
    await registry?.dispose()
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
