/**
 * THE TWO MIGRATION CHAINS AGREE [POD-6981, POD-6958 design 2.7].
 *
 * Database-free, in the lean gate. It holds:
 *
 * - the chain rule (`pgChainProblems`): the Postgres chain starts with one baseline;
 *   before the freeze it is that baseline alone, covering the newest SQLite migration;
 *   after it, every later change is one folder name in both chains;
 * - the baseline is what the twin renders, byte for byte (`bun run
 *   migration:pg-baseline` writes it; nobody edits it), and the chain's newest snapshot
 *   is the twin, so a schema change that reached `schema.ts` but not the chain fails;
 * - every DDL note of `schema-overrides.ts` has its patch in the baseline, and back;
 * - the bundled manifest carries the folders.
 *
 * The rule is a function of folder names, so the last block plants one-sided
 * migrations in both phases and proves each is found.
 */

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  migrationFolders,
  PG_BASELINE_FROZEN,
  PG_DDL_PATCHES,
  PG_DRIZZLE_DIR,
  pgBaselineDrift,
  pgChainProblems,
  pgHeadSnapshotDrift,
  SQLITE_DRIZZLE_DIR,
} from './chain'
import { PG_MIGRATIONS } from './manifest.generated'
import { PG_DDL_NOTES } from './schema-overrides'

const sqliteNames = migrationFolders(SQLITE_DRIZZLE_DIR)
const pgNames = migrationFolders(PG_DRIZZLE_DIR)

describe('the committed chains', () => {
  it('follow the chain rule', () => {
    expect(pgChainProblems({ sqliteNames, pgNames, frozen: PG_BASELINE_FROZEN })).toEqual([])
  })

  it.skipIf(PG_BASELINE_FROZEN)('carry the baseline the twin renders', async () => {
    expect(await pgBaselineDrift()).toEqual([])
  })

  it('end at the twin: drizzle-kit has nothing left to generate', async () => {
    expect(await pgHeadSnapshotDrift()).toEqual([])
  })

  it('patch every DDL note into the baseline, and nothing else', () => {
    expect(Object.keys(PG_DDL_PATCHES).sort()).toEqual(Object.keys(PG_DDL_NOTES).sort())
  })

  it('are bundled in the manifest', () => {
    expect(PG_MIGRATIONS.map((m) => m.name)).toEqual(pgNames)
  })
})

describe('the chain rule finds planted one-sided migrations', () => {
  const sqlite = ['20260715135845_baseline', '20261117050304_workspace-column']
  const baseline = '20261117050304_baseline'

  it('accepts the baseline alone before the freeze', () => {
    expect(pgChainProblems({ sqliteNames: sqlite, pgNames: [baseline], frozen: false })).toEqual([])
  })

  it('before the freeze: a Postgres migration after the baseline', () => {
    expect(
      pgChainProblems({
        sqliteNames: sqlite,
        pgNames: [baseline, '20261118000000_add-widgets'],
        frozen: false,
      }),
    ).toEqual([
      expect.stringMatching(
        /^20261118000000_add-widgets is a Postgres migration after the baseline/,
      ),
    ])
  })

  it('before the freeze: a SQLite migration the baseline does not cover', () => {
    expect(
      pgChainProblems({
        sqliteNames: [...sqlite, '20261118000000_add-widgets'],
        pgNames: [baseline],
        frozen: false,
      }),
    ).toEqual([expect.stringMatching(/^SQLite migration 20261118000000_add-widgets is newer than/)])
  })

  it('after the freeze: accepts a change written in both chains', () => {
    const change = '20261118000000_add-widgets'
    expect(
      pgChainProblems({
        sqliteNames: [...sqlite, change],
        pgNames: [baseline, change],
        frozen: true,
      }),
    ).toEqual([])
  })

  it('after the freeze: a SQLite-only migration, and a Postgres-only one', () => {
    expect(
      pgChainProblems({
        sqliteNames: [...sqlite, '20261118000000_sqlite-only'],
        pgNames: [baseline, '20261119000000_pg-only'],
        frozen: true,
      }),
    ).toEqual([
      expect.stringMatching(/^SQLite migration 20261118000000_sqlite-only has no Postgres twin/),
      expect.stringMatching(/^Postgres migration 20261119000000_pg-only has no SQLite twin/),
    ])
  })

  it('a chain without a baseline first, or with two', () => {
    expect(
      pgChainProblems({ sqliteNames: sqlite, pgNames: ['20261118000000_x'], frozen: true }),
    ).toEqual([expect.stringMatching(/must start with its baseline/)])
    expect(
      pgChainProblems({
        sqliteNames: sqlite,
        pgNames: [baseline, '20261118000000_baseline'],
        frozen: true,
      }),
    ).toContainEqual(expect.stringMatching(/more than one baseline/))
  })
})

describe('the baseline check finds a hand edit', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pg-chain-'))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  it.skipIf(PG_BASELINE_FROZEN)('reports an edited migration.sql', async () => {
    const pgDir = join(scratch, 'pg')
    cpSync(PG_DRIZZLE_DIR, pgDir, { recursive: true })
    const [folder] = migrationFolders(pgDir)
    writeFileSync(join(pgDir, folder as string, 'migration.sql'), 'CREATE TABLE edited (id int);')
    expect(await pgBaselineDrift(SQLITE_DRIZZLE_DIR, pgDir)).toEqual([
      `${folder}/migration.sql differs from what the Postgres twin renders`,
      'Run `bun run migration:pg-baseline` and commit the result.',
    ])
  })
})
