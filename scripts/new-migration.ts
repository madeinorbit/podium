#!/usr/bin/env bun
/**
 * Authors a new migration with drizzle-kit, in BOTH chains.
 *
 *   1. Edit apps/server/src/migrations/schema.ts — the schema is the source of truth —
 *      and its Postgres twin, apps/server/src/migrations/pg/schema.ts
 *      (`bun run schema:pg -- --check <table>` shows what the generator would write).
 *   2. bun run migration:new add-widget-table
 *
 * This diffs the SQLite schema against the last snapshot (`drizzle-kit generate`),
 * emitting a timestamped migration folder + snapshot under
 * apps/server/src/migrations/drizzle/. Then the Postgres chain
 * (apps/server/src/migrations/pg/drizzle/, `drizzle.config.pg.ts`):
 *
 * - while the Postgres baseline is not frozen (`PG_BASELINE_FROZEN`, see
 *   apps/server/src/migrations/pg/chain.ts), the baseline is regenerated in place from
 *   the twin and renamed after the new SQLite migration;
 * - once it is frozen, `drizzle-kit generate --config=drizzle.config.pg.ts` writes the
 *   Postgres migration, renamed to the SQLite folder's exact name, so the two chains
 *   name one change once (`chain-parity.test.ts` holds them to it). When the twin has no
 *   schema change (a data migration), an empty custom Postgres migration is written for
 *   you to fill: data migrations are written per engine.
 *
 * Finally it regenerates the bundled manifests the runtime appliers read.
 *
 * Why drizzle and not MAX+1: Podium runs many agents on parallel branches by
 * design. drizzle-kit names each folder with a UTC-timestamp prefix (collision-
 * free — the same reason #485 switched away from sequential numbers), and its
 * snapshot `prevIds[]` DAG + `drizzle-kit check` (CI) surface two branches that
 * touch the same table BEFORE merge — the conflict our old runner could not see.
 *
 * For a data backfill or any DDL drizzle can't diff (e.g. an FTS/expression
 * object), author an empty migration with `drizzle-kit generate --custom` and
 * hand-write its SQL. That path does NOT touch the Postgres chain: before the Postgres
 * freeze, run `bun run migration:pg-baseline` (the baseline is named after the newest
 * SQLite migration, so it must be regenerated; it also rebuilds both manifests). After
 * the freeze, write its Postgres twin under the same folder name the same way
 * (`--config=drizzle.config.pg.ts`), then rerun `bun run migration:manifest`.
 * `chain-parity.test.ts`, in the lean gate, fails until the chains agree.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PG_BASELINE_FROZEN } from '../apps/server/src/migrations/pg/chain'

const REPO = join(import.meta.dir, '..')
const DRIZZLE_KIT = join(REPO, 'node_modules', '.bin', 'drizzle-kit')
const SQLITE_DIR = join(REPO, 'apps/server/src/migrations/drizzle')
const PG_DIR = join(REPO, 'apps/server/src/migrations/pg/drizzle')
const PG_CONFIG = '--config=drizzle.config.pg.ts'

const rawName = process.argv[2]
if (!rawName) {
  console.error('usage: bun run migration:new <name>   (e.g. add-widget-table)')
  process.exit(1)
}

/** kebab-case — drizzle uses this as the folder-name slug after the timestamp. */
const name = rawName
  .trim()
  .replace(/[_\s]+/g, '-')
  .replace(/[^a-zA-Z0-9-]/g, '')
  .replace(/-+/g, '-')
  .toLowerCase()
if (!name) {
  console.error(`'${rawName}' has no usable characters — pick a name like add-widget-table`)
  process.exit(1)
}

function run(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit' })
  if (res.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')} failed (exit ${res.status ?? 'signal'})`)
    process.exit(res.status ?? 1)
  }
}

function folders(dir: string): Set<string> {
  return new Set(readdirSync(dir).filter((entry) => statSync(join(dir, entry)).isDirectory()))
}

/** The one folder `step` added under `dir`, or undefined when it added none. */
function added(dir: string, step: () => void): string | undefined {
  const before = folders(dir)
  step()
  const fresh = [...folders(dir)].filter((entry) => !before.has(entry))
  if (fresh.length > 1) {
    console.error(`expected one new migration folder under ${dir}, found ${fresh.join(', ')}`)
    process.exit(1)
  }
  return fresh[0]
}

// 1. Diff the SQLite schema → a timestamped migration folder + snapshot.
const sqliteFolder = added(SQLITE_DIR, () => run(DRIZZLE_KIT, ['generate', `--name=${name}`]))

// 2. The Postgres chain.
if (sqliteFolder === undefined) {
  console.log('\nNo SQLite migration was written, so the Postgres chain is unchanged.')
} else if (!PG_BASELINE_FROZEN) {
  // Regenerates the baseline in place, named after the new SQLite migration.
  run('bun', ['run', 'scripts/generate-pg-baseline.ts'])
} else {
  let pgFolder = added(PG_DIR, () => run(DRIZZLE_KIT, ['generate', PG_CONFIG, `--name=${name}`]))
  if (pgFolder === undefined) {
    pgFolder = added(PG_DIR, () =>
      run(DRIZZLE_KIT, ['generate', PG_CONFIG, '--custom', `--name=${name}`]),
    )
    console.log(
      `\nThe Postgres twin has no schema change: wrote an empty Postgres migration. ` +
        `Write its Postgres data migration, or a comment saying why it has none.`,
    )
  }
  if (pgFolder === undefined) {
    console.error('drizzle-kit wrote no Postgres migration folder')
    process.exit(1)
  }
  if (pgFolder !== sqliteFolder) renameSync(join(PG_DIR, pgFolder), join(PG_DIR, sqliteFolder))
}

// 3. Re-bundle the manifests so the runtime appliers see the new migrations.
run('bun', ['run', 'scripts/build-drizzle-manifest.ts'])

console.log(`\nAuthored migration '${name}'.`)
console.log(`Review the generated SQL under apps/server/src/migrations/drizzle/`)
console.log(`and apps/server/src/migrations/pg/drizzle/, then:`)
console.log(`  - \`bun run migration:check\` to confirm no cross-branch conflict, and`)
console.log(`  - \`bun run typecheck\` before committing.`)
