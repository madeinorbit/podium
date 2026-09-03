#!/usr/bin/env bun
/**
 * THE NO-DRIFT GATE for the migration chain [spec:SP-4428].
 *
 *   bun run audit:migration-drift          # the gate — exit 1 on any drift
 *   bun run audit:migration-drift --probe  # prove the check can say YES
 *
 * WHY THIS EXISTS, and why `migration:check` is not enough.
 *
 * `drizzle-kit check` validates the snapshot DAG against ITSELF — one head, no
 * two branches touching the same table. It never reads `schema.ts`. So the head
 * snapshot can fall behind the schema and every gate in this repository stays
 * green, which is exactly what POD-3341 found:
 * `20260830003000_session-requested-driver` is hand-written and carries no
 * snapshot, so `sessions.requested_driver_id` existed in the schema and in the
 * applied DDL but in no snapshot. The next author would have generated a SECOND
 * `ADD requested_driver_id` and hit a duplicate-column failure on every
 * instance, and nothing would have said so first.
 *
 * This gate closes that: a green run means the head snapshot IS the schema, so
 * the next `migration:new` diffs from the truth and emits only what its author
 * intended. It is also the gate that catches a schema mistake visible only in
 * generated DDL — the class POD-3254 had to pin with a hand-written unit
 * assertion (`migrations/column-modes.test.ts`) because, while the chain was
 * forked, `drizzle-kit generate` refused to run at all.
 *
 * IT WRITES NOTHING. `generate --explain` is a dry run: it prints the statements
 * it WOULD emit and leaves no migration folder behind, so the gate is safe to
 * run on any branch at any time, red or green.
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const DRIZZLE_KIT = join(ROOT, 'node_modules', '.bin', 'drizzle-kit')
const CONFIG = join(ROOT, 'drizzle.config.ts')
const OUT_DIR = join(ROOT, 'apps/server/src/migrations/drizzle')

/** The one shape of `generate --explain --output json` this gate reads. */
export interface ExplainResult {
  /** `no_changes` is the green answer; `ok` means there is DDL left to emit. */
  status: string
  statements?: { type: string; column?: { name?: string } }[]
}

/**
 * Dry-runs `drizzle-kit generate` against `configPath` and returns its verdict.
 *
 * Always spawned with the repo root as cwd, because a drizzle config's `schema`
 * globs resolve against the CWD rather than against the config file's own
 * directory — which is what lets a throwaway config in a temp directory still
 * point at the real schema files.
 */
export function explain(configPath: string): ExplainResult {
  const res = spawnSync(
    DRIZZLE_KIT,
    ['generate', `--config=${configPath}`, '--explain', '--output', 'json'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  const stdout = res.stdout ?? ''
  // drizzle prints its banner lines before the JSON object, so take the last line.
  const line = stdout.trim().split('\n').at(-1) ?? ''
  if (res.status !== 0 || !line.startsWith('{')) {
    throw new Error(
      `drizzle-kit generate --explain failed (exit ${res.status ?? 'signal'}):\n${stdout}${res.stderr ?? ''}`,
    )
  }
  return JSON.parse(line) as ExplainResult
}

/** The gate: the repository's real schema must diff to nothing. */
export function findDrift(): ExplainResult {
  return explain(CONFIG)
}

/**
 * A config for a THROWAWAY copy of the chain — same dialect, schemas and
 * filters as `drizzle.config.ts`, a different `out`.
 *
 * Written as a plain object rather than through `defineConfig` on purpose: a
 * file under the OS temp directory cannot resolve `drizzle-kit` as a module,
 * and `defineConfig` is only a typing helper, so importing it would buy nothing
 * and cost the probe its isolation.
 */
function scratchConfig(dir: string, out: string): string {
  const path = join(dir, 'drizzle.drift-probe.config.ts')
  writeFileSync(
    path,
    `export default {\n` +
      `  dialect: 'sqlite',\n` +
      `  schema: ['./apps/server/src/migrations/schema.ts', './packages/sync/src/adapters/sqlite/schema.ts'],\n` +
      `  out: ${JSON.stringify(out)},\n` +
      `  tablesFilter: ['!*_fts', '!*_fts_*', '!sqlite_*', '!schema_version', '!__drizzle_migrations'],\n` +
      `}\n`,
  )
  return path
}

/**
 * The self-test: take a copy of the chain, delete ONE column from its head
 * snapshot, and require the dry run to ask for that column back.
 *
 * Without this a gate that could never say YES would read as green forever —
 * which is the failure mode this whole file exists to end. The mutation is the
 * POD-3341 defect exactly: a column the schema has and the head snapshot does
 * not.
 *
 * The column is CHOSEN rather than named, so the probe does not rot when the
 * head moves: it must be nullable and mentioned by no key, index, check or
 * foreign key, so removing it can only produce the one `add_column`.
 */
export function probeFailure(): string | undefined {
  const scratch = mkdtempSync(join(tmpdir(), 'podium-migration-drift-'))
  try {
    const out = join(scratch, 'drizzle')
    cpSync(OUT_DIR, out, { recursive: true })
    const head = headSnapshotPath(out)
    const snapshot = JSON.parse(readFileSync(head, 'utf8')) as { ddl: Record<string, unknown>[] }
    const victim = pickRemovableColumn(snapshot.ddl)
    if (!victim) {
      return `no removable nullable column found in ${head} — the probe cannot mutate anything`
    }
    snapshot.ddl = snapshot.ddl.filter((entry) => entry !== victim)
    writeFileSync(head, JSON.stringify(snapshot, null, 2))
    const result = explain(scratchConfig(scratch, out))
    const asked = (result.statements ?? []).some(
      (statement) => statement.type === 'add_column' && statement.column?.name === victim.name,
    )
    return asked
      ? undefined
      : `removed ${victim.table}.${victim.name} from the head snapshot and generate still said '${result.status}'`
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** The chain's head folder is its last by name — drizzle names folders by UTC timestamp. */
function headSnapshotPath(out: string): string {
  const head = readdirSync(out)
    .filter((entry) => existsSync(join(out, entry, 'snapshot.json')))
    .sort()
    .at(-1)
  if (!head) throw new Error(`no snapshot found under ${out}`)
  return join(out, head, 'snapshot.json')
}

interface ColumnEntry extends Record<string, unknown> {
  entityType: string
  name: string
  table: string
  notNull: boolean
}

/** A nullable column no other DDL entry names, so deleting it has one consequence. */
function pickRemovableColumn(ddl: Record<string, unknown>[]): ColumnEntry | undefined {
  const columns = ddl.filter(
    (entry): entry is ColumnEntry => entry.entityType === 'columns' && entry.notNull === false,
  )
  const others = JSON.stringify(ddl.filter((entry) => entry.entityType !== 'columns'))
  return columns.find((column) => !others.includes(`"${column.name}"`))
}

if (import.meta.main) {
  if (new Set(process.argv.slice(2)).has('--probe')) {
    const failure = probeFailure()
    console.log(`${failure ? 'FAIL' : 'PASS'}  a column missing from the head snapshot is reported`)
    if (failure) {
      console.error(failure)
      process.exit(1)
    }
    process.exit(0)
  }
  const result = findDrift()
  if (result.status === 'no_changes') {
    console.log('Migration chain has no drift: the head snapshot is the schema.')
    process.exit(0)
  }
  console.error('The head snapshot has DRIFTED from the schema — generate still has DDL to emit:\n')
  console.error(JSON.stringify(result.statements ?? result, null, 2))
  console.error(
    `\nAuthor it (\`bun run migration:new <name>\`), or — if this DDL is already applied by a\n` +
      `hand-written migration that carries no snapshot — fold it into the head snapshot, the way\n` +
      `20260804200000_podium-managed-machines was folded into 20260807080429's.`,
  )
  process.exit(1)
}
