import type { SqlDatabase } from '@podium/runtime/sqlite'
import {
  multiMemberRows,
  serverRows,
} from '../../../../packages/runtime/src/fixtures/customer-upgrade'
import { runDrizzleMigrations } from '../migrations'
import { DRIZZLE_MIGRATIONS } from '../migrations/drizzle-manifest.generated'

export type FixtureRow = Record<string, string | number | null>

export function insertFixtureRow(db: SqlDatabase, table: string, row: FixtureRow): void {
  const names = Object.keys(row)
  db.prepare(
    `INSERT INTO ${table} (${names.map((name) => `\`${name}\``).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  ).run(...names.map((name) => row[name] ?? null))
}

/** Seed the November customer fixture on its original migration ledger. */
export function seedCustomerMembers(db: SqlDatabase, multiple: boolean): number {
  const cut = DRIZZLE_MIGRATIONS.findIndex(
    (migration) => migration.name === multiMemberRows.beforeMigration,
  )
  if (cut < 0) throw new Error('The customer fixture migration is missing from the manifest')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  db.exec('PRAGMA foreign_keys=OFF; DELETE FROM user_credentials; DELETE FROM users')
  const shapes = [
    multiMemberRows.singleMember,
    ...(multiple ? [multiMemberRows.additionalMembers] : []),
  ]
  for (const shape of shapes) {
    for (const [table, rows] of Object.entries(shape)) {
      for (const row of rows) insertFixtureRow(db, table, row)
    }
  }
  for (const captured of serverRows.machines) {
    const { owner_user_id: _owner, ...machine } = captured
    const owner =
      multiple && machine.id === 'machine-peer' ? 'mem_upgrade_bob' : 'mem_upgrade_alice'
    insertFixtureRow(db, 'machines', machine)
    insertFixtureRow(db, 'grants', {
      resource_kind: 'machine',
      resource_id: machine.id,
      grantee: owner,
      verb: 'manage',
      owner,
      visibility: 'private',
      created_at: machine.created_at,
      custody: 1,
      actor_kind: 'user',
      actor_id: owner,
      on_behalf_of: owner,
    })
  }
  return cut
}
