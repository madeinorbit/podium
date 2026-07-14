#!/usr/bin/env bun
/**
 * Scaffolds a migration with a UTC timestamp version.
 *
 *   bun run migration:new add-widget-table
 *
 * Why a timestamp and not MAX+1: Podium runs many agents on parallel branches by
 * design, and sequential numbering guarantees they collide — two agents both take
 * the next number and only find out at merge. A timestamp is collision-free by
 * construction, so there is nothing to coordinate and no conflict to notice.
 * Rails made this same switch in 2.1. See #485 / #472.
 *
 * This is the ONLY supported way to pick a version. Do not hand-type one.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'apps', 'server', 'src', 'migrations')
const INDEX = join(MIGRATIONS_DIR, 'index.ts')

const rawName = process.argv[2]
if (!rawName) {
  console.error('usage: bun run migration:new <name>   (e.g. add-widget-table)')
  process.exit(1)
}

/** kebab-case, the convention every existing migration file follows. */
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

const now = new Date()
const p2 = (n: number) => String(n).padStart(2, '0')
const version =
  `${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}` +
  `${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}`

const file = join(MIGRATIONS_DIR, `${version}-${name}.ts`)
if (existsSync(file)) {
  console.error(`${file} already exists — wait a second and re-run`)
  process.exit(1)
}

// camelCase identifier for the import binding.
const ident = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())

writeFileSync(
  file,
  `/**
 * Migration ${version} — ${name}.
 *
 * ADDITIVE ONLY: no destructive drops/renames in a single release (two-phase them).
 * Runs inside a transaction — do NOT BEGIN/COMMIT here.
 * Must be ORDER-INDEPENDENT: a back-filled migration can run after higher-numbered
 * ones, so do not assume a predecessor already ran — guard defensively instead.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  db.exec(\`
    -- your DDL here
  \`)
}
`,
)

// Wire it into the registry: the import goes directly after the LAST migration import,
// and the entry at the end of MIGRATIONS — timestamps always sort last, so appending is
// always correct and never conflicts with another branch's entry.
const src = readFileSync(INDEX, 'utf8')

const importLine = `import { up as ${ident} } from './${version}-${name}'\n`
const lastMigrationImport = src.lastIndexOf('import { up as ')
const afterLastImport = src.indexOf('\n', lastMigrationImport) + 1
const withImport = src.slice(0, afterLastImport) + importLine + src.slice(afterLastImport)

const listEnd = withImport.lastIndexOf(']\n\n/** Highest schema version')
if (lastMigrationImport === -1 || listEnd === -1) {
  console.error(
    `could not auto-wire ${INDEX} — its shape changed. Add these two lines by hand:\n` +
      `  ${importLine.trim()}\n` +
      `  { version: ${version}, name: '${name}', up: ${ident} },`,
  )
  process.exit(1)
}
const entry = `  { version: ${version}, name: '${name}', up: ${ident} },\n`
const wired = withImport.slice(0, listEnd) + entry + withImport.slice(listEnd)
writeFileSync(INDEX, wired)

console.log(`created ${file}`)
console.log(`registered { version: ${version}, name: '${name}' } in migrations/index.ts`)
console.log(`\nVersion ${version} is a UTC timestamp — it cannot collide with another branch.`)
console.log(`Do not renumber it, and do not hand-pick MAX+1.`)
// The import placement above is best-effort; typecheck is the backstop.
console.log(`\nRun \`bun run typecheck\` to confirm the wiring, then write your DDL.`)
