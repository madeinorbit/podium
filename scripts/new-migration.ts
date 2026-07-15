#!/usr/bin/env bun
/**
 * Authors a new migration with drizzle-kit [spec:SP-4428].
 *
 *   1. Edit apps/server/src/migrations/schema.ts — the schema is the source of truth.
 *   2. bun run migration:new add-widget-table
 *
 * This diffs the schema against the last snapshot (`drizzle-kit generate`),
 * emitting a timestamped migration folder + snapshot under
 * apps/server/src/migrations/drizzle/, then regenerates the bundled manifest the
 * runtime applier reads (drizzle-manifest.generated.ts).
 *
 * Why drizzle and not MAX+1: Podium runs many agents on parallel branches by
 * design. drizzle-kit names each folder with a UTC-timestamp prefix (collision-
 * free — the same reason #485 switched away from sequential numbers), and its
 * snapshot `prevIds[]` DAG + `drizzle-kit check` (CI) surface two branches that
 * touch the same table BEFORE merge — the conflict our old runner could not see.
 *
 * For a data backfill or any DDL drizzle can't diff (e.g. an FTS/expression
 * object), author an empty migration with `drizzle-kit generate --custom` and
 * hand-write its SQL, then rerun `bun run migration:manifest`.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const DRIZZLE_KIT = join(REPO, 'node_modules', '.bin', 'drizzle-kit')

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

// 1. Diff schema → a timestamped migration folder + snapshot.
run(DRIZZLE_KIT, ['generate', `--name=${name}`])
// 2. Re-bundle the manifest so the runtime applier sees the new migration.
run('bun', ['run', 'scripts/build-drizzle-manifest.ts'])

console.log(`\nAuthored migration '${name}'.`)
console.log(`Review the generated SQL under apps/server/src/migrations/drizzle/, then:`)
console.log(`  - \`bun run migration:check\` to confirm no cross-branch conflict, and`)
console.log(`  - \`bun run typecheck\` before committing.`)
