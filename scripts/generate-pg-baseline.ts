#!/usr/bin/env bun
/**
 * Writes the Postgres baseline migration from the Postgres schema twin [POD-6981,
 * POD-6958 design 2.7]: `apps/server/src/migrations/pg/drizzle/<ts>_baseline/`, named
 * after the newest SQLite migration, then the bundled manifests.
 *
 *   bun run migration:pg-baseline           regenerate it in place
 *   bun run migration:pg-baseline --check   exit 1 when the committed one is stale
 *
 * The baseline is never edited by hand; `apps/server/src/migrations/pg/chain.ts` says
 * what it holds and when regenerating it stops being allowed (`PG_BASELINE_FROZEN`).
 * `bun run migration:new` runs this for you while the baseline is not frozen.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BASELINE_SUFFIX,
  migrationFolders,
  PG_BASELINE_FROZEN,
  PG_DRIZZLE_DIR,
  pgBaselineDrift,
  renderPgBaseline,
  SQLITE_DRIZZLE_DIR,
} from '../apps/server/src/migrations/pg/chain'

const REPO = join(import.meta.dir, '..')

if (process.argv.includes('--check')) {
  const problems = await pgBaselineDrift()
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
  console.log('the Postgres baseline is what the twin renders.')
  process.exit(0)
}

if (PG_BASELINE_FROZEN) {
  console.error(
    'the Postgres baseline is frozen (PG_BASELINE_FROZEN in apps/server/src/migrations/pg/chain.ts): ' +
      'a hosted database has applied it. Write a migration in both chains with `bun run migration:new <name>`.',
  )
  process.exit(1)
}

const baseline = await renderPgBaseline(migrationFolders(SQLITE_DRIZZLE_DIR))
mkdirSync(PG_DRIZZLE_DIR, { recursive: true })
for (const name of migrationFolders(PG_DRIZZLE_DIR)) {
  // Before the freeze the chain is the baseline alone; an older baseline is replaced.
  if (name.endsWith(BASELINE_SUFFIX) && name !== baseline.folder) {
    rmSync(join(PG_DRIZZLE_DIR, name), { recursive: true })
  }
}
const folder = join(PG_DRIZZLE_DIR, baseline.folder)
mkdirSync(folder, { recursive: true })
writeFileSync(join(folder, 'migration.sql'), baseline.migrationSql)
writeFileSync(join(folder, 'snapshot.json'), baseline.snapshotJson)
console.log(`wrote apps/server/src/migrations/pg/drizzle/${baseline.folder}`)

const manifest = spawnSync('bun', ['run', 'scripts/build-drizzle-manifest.ts'], {
  cwd: REPO,
  stdio: 'inherit',
})
if (manifest.status !== 0) process.exit(manifest.status ?? 1)
