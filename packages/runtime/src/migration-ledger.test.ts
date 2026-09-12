import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalMigrationName,
  instanceDatabasePath,
  MIGRATION_NAME_ALIASES,
  readAppliedMigrations,
} from './migration-ledger'
import { openDatabase } from './sqlite'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function scratch(): string {
  dir = mkdtempSync(join(tmpdir(), 'podium-migration-ledger-'))
  return dir
}

function ledgerAt(path: string, names: string[]): void {
  const db = openDatabase(path)
  db.exec(
    `CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text)`,
  )
  const insert = db.prepare(
    `INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)`,
  )
  for (const [index, name] of names.entries()) insert.run(`h${index}`, index, name)
  db.close()
}

describe('readAppliedMigrations', () => {
  it('answers undefined for a machine that holds no database, and creates nothing', () => {
    const path = join(scratch(), 'podium.db')
    expect(readAppliedMigrations(path)).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('reads the migration names the ledger records', () => {
    const path = join(scratch(), 'podium.db')
    ledgerAt(path, ['20260715135845_baseline', '20260809112031_transcript-segment-incarnations'])
    expect(readAppliedMigrations(path)).toEqual([
      '20260715135845_baseline',
      '20260809112031_transcript-segment-incarnations',
    ])
  })

  it('answers an empty list for a database that carries no drizzle ledger', () => {
    const path = join(scratch(), 'podium.db')
    const db = openDatabase(path)
    db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)')
    db.close()
    expect(readAppliedMigrations(path)).toEqual([])
  })
})

describe('canonicalMigrationName', () => {
  it('resolves a migration deployed under its pre-rebase name to the canonical one', () => {
    expect(canonicalMigrationName('20260722210552_session-spawn-failure')).toBe(
      '20260724134702_session-spawn-failure',
    )
  })

  it('leaves every other name exactly as it is', () => {
    expect(canonicalMigrationName('20260715135845_baseline')).toBe('20260715135845_baseline')
  })
})

describe('instanceDatabasePath', () => {
  it('names podium.db below the state root it is given', () => {
    expect(instanceDatabasePath('/state/root')).toBe(join('/state/root', 'podium.db'))
  })
})

/**
 * MIGRATIONS THAT CAN NO LONGER BE REPLAYED, and the alias entries that would
 * replay them (PDM-226; decided by the PDM-107 phase coordinator after PDM-128
 * recorded the hazard rather than fixing it).
 *
 * An alias exists because the same change was deployed locally under one
 * generated timestamp and rebased upstream under another. Its effect on the
 * server's migrator is that a ledger holding the OLD name makes the CANONICAL
 * name read as PENDING — so the canonical migration's frozen SQL runs again on a
 * database that has already had that change applied. That is the whole point of
 * the alias for a migration whose SQL is idempotent against the schema it left
 * behind, and it is a boot failure for one whose SQL is not.
 *
 * `20260911082826_retire-the-solo-user` is not. It contains, frozen,
 *
 *     UPDATE `issues` SET `assignee` = '{{mint:mem_}}' WHERE `assignee` = 'user:sole';
 *
 * and `20260912164255_a2-retire-issue-assignee` drops `issues.assignee`. Replayed
 * against a post-A2 schema that statement fails with "no such column: assignee".
 *
 * WHY A TEST AND NOT A FIX. The frozen SQL cannot be altered — preserving frozen
 * history is a charter requirement — so this cannot be repaired later either,
 * only refused now. No alias targets that migration today, so there is no live
 * exposure; what there is, is a trap that is silent to the next author. Whoever
 * adds an alias here will be solving an unrelated rebase problem and has no
 * reason to suspect that the migration they are pointing at replays SQL naming a
 * dropped column. This test is what tells them, in the file they are editing.
 *
 * WHAT IT DELIBERATELY CANNOT SEE: the retirement migration being RENAMED and
 * aliased old -> new. The canonical target would then be the new name, which
 * this list does not know, and recognising it means reading the frozen SQL of a
 * migration that lives in `apps/server` — a dependency `packages/runtime` does
 * not take (check-boundaries rule 4), and a column-reference check that means
 * parsing SQL. That variant is a much louder edit: a new frozen file, a new
 * manifest entry, and the header of `20260912164255_a2-retire-issue-assignee`
 * spelling the consequence out for anyone touching this history at all.
 */
const UNREPLAYABLE_MIGRATIONS: ReadonlyMap<string, string> = new Map([
  [
    '20260911082826_retire-the-solo-user',
    "its frozen SQL runs `UPDATE issues SET assignee = ... WHERE assignee = 'user:sole'`, " +
      'and `20260912164255_a2-retire-issue-assignee` (multi-user epic A2) dropped ' +
      '`issues.assignee`. An alias pointing here makes that statement run again on an ' +
      'already-upgraded database, where it fails with "no such column: assignee". See PDM-226.',
  ],
])

/** The alias entries whose canonical target is a migration that cannot be replayed. */
function replayHazards(aliases: ReadonlyMap<string, string>): string[] {
  return [...aliases]
    .filter(([, canonical]) => UNREPLAYABLE_MIGRATIONS.has(canonical))
    .map(
      ([deployed, canonical]) =>
        `${deployed} -> ${canonical}: ${UNREPLAYABLE_MIGRATIONS.get(canonical)}`,
    )
}

describe('MIGRATION_NAME_ALIASES', () => {
  it('never aliases a migration whose frozen SQL can no longer be replayed', () => {
    expect(replayHazards(MIGRATION_NAME_ALIASES)).toEqual([])
  })

  it('recognises the hazard it is guarding against', () => {
    // Proves the assertion above is load-bearing rather than vacuously green: the
    // map it would have to become for a reader to see this fail.
    const hazardous = new Map<string, string>([
      ...MIGRATION_NAME_ALIASES,
      ['20260901000000_retire-the-solo-user', '20260911082826_retire-the-solo-user'],
    ])
    expect(replayHazards(hazardous)).toHaveLength(1)
    expect(replayHazards(hazardous)[0]).toContain('no such column: assignee')
  })
})
