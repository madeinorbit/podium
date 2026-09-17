import { openDatabase } from '@podium/runtime/sqlite'
import { expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

it('moves owned and shared custody into edges, leaves unowned rows alone, and drops the column', () => {
  const db = openDatabase(':memory:')
  try {
    const cut = DRIZZLE_MIGRATIONS.findIndex(m => m.name.endsWith('machine-custody-grant-edges'))
    expect(cut).toBeGreaterThan(0)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
    for (const [id, owner] of [['owned', 'alice'], ['shared', 'bob'], ['unowned', null], ['retained', null], ['revoked', 'alice']] as const) {
      db.prepare(`INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at, owner_user_id)
        VALUES (?, ?, ?, 'hash', '2026-09-01', '2026-09-01', ?)`).run(id, id, id, owner)
    }
    db.prepare("UPDATE machines SET revoked_at = '2026-09-02' WHERE id = 'revoked'").run()
    for (const [id, grantee, verb] of [['shared', 'alice', 'use'], ['shared', 'bob', 'manage'], ['retained', 'alice', 'use']] as const) {
      db.prepare(`INSERT INTO grants (resource_kind, resource_id, grantee, verb, owner, visibility, created_at, actor_kind)
        VALUES ('machine', ?, ?, ?, 'bob', 'owned-compute', '2026-09-02', 'user')`).run(id, grantee, verb)
    }
    const priorShare = db.prepare("SELECT * FROM grants WHERE resource_id = 'shared' AND grantee = 'alice'").get()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
    const edges = (id: string) => db.prepare('SELECT grantee, verb, custody FROM grants WHERE resource_id = ? ORDER BY grantee, verb').all(id)
    expect(edges('owned')).toEqual([{ grantee: 'alice', verb: 'manage', custody: 1 }, { grantee: 'alice', verb: 'use', custody: 0 }])
    expect(edges('shared')).toEqual([{ grantee: 'alice', verb: 'use', custody: 0 }, { grantee: 'bob', verb: 'manage', custody: 1 }, { grantee: 'bob', verb: 'use', custody: 0 }])
    expect(edges('unowned')).toEqual([])
    expect(edges('retained')).toEqual([{ grantee: 'alice', verb: 'use', custody: 0 }])
    expect(edges('revoked')).toEqual(edges('owned'))
    expect(db.prepare("SELECT * FROM grants WHERE resource_id = 'shared' AND grantee = 'alice'").get()).toEqual({ ...priorShare as object, custody: 0 })
    expect(db.prepare('PRAGMA table_info(machines)').all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'owner_user_id' })]))
    expect(() => db.prepare(`INSERT INTO grants (resource_kind, resource_id, grantee, verb, owner, visibility, created_at, actor_kind, custody)
      VALUES ('machine', 'owned', 'bob', 'manage', 'bob', 'owned-compute', 'now', 'user', 1)`).run()).toThrow()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
    expect(edges('owned')).toHaveLength(2)
  } finally { db.close() }
})
