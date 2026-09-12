#!/usr/bin/env bun
/**
 * THE EXPAND-ONLY GATE for schema migrations.
 *
 *   bun run audit:expand-only            # the gate — exit 1 on any finding
 *   bun run audit:expand-only --json
 *   bun run audit:expand-only --probe    # prove every check fires AND spares
 *
 * WHY THIS EXISTS
 *
 * Podium's migrations are forward-only, and that is the right choice: a forward
 * migration that drops a column or coalesces rows CANNOT be inverted, because the
 * data is gone. A `down` that appears to work is a false comfort.
 *
 * What replaces it is discipline: additive changes ship in release N, and the
 * destructive contract step ships no earlier than N+1. Then rolling back one
 * release needs no down migration at all, because the older binary simply ignores
 * columns it does not know. That turns rollback into a plain binary swap, which
 * is the property the whole update story leans on.
 *
 * Discipline that nothing checks is a preference. This is the check.
 *
 * WHY THIS MEASURES INSTEAD OF PATTERN-MATCHING (PDM-298)
 *
 * The first version of this gate read the SQL and called every `__new_` table
 * rebuild destructive. SQLite cannot ALTER a default, a primary key or a check
 * constraint in place, so drizzle-kit emits create/copy/drop/rename for changes
 * that lose NOTHING — and the gate flagged all of them. It reported 22 findings
 * on the epic integration branch, 20 of which were that boilerplate. It had been
 * red on main for a month, which meant it could not report the two findings that
 * were real: one of them a column dropped in the same release as the backfill
 * that replaced it, which is the exact thing this file exists to refuse.
 *
 * A gate red for reasons unrelated to your change is not a gate. So it no longer
 * guesses from the spelling of the DDL. It replays the whole chain into an
 * in-memory SQLite — which is precisely what a fresh install does — and compares
 * the table and column shape either side of each migration. What survived is
 * measured, not inferred. A rebuild that carries every column across destroys
 * nothing and is silent; a rebuild that quietly leaves one behind is reported by
 * name, which the old pattern-matcher could not do at all.
 *
 * The syntactic check that remains is `not-null-without-default`, and it must:
 * replay cannot see it, because tightening a column is not the LOSS of one. It is
 * the reason this change is not a narrowing — every shape the old gate caught is
 * still caught, and the destructive rebuild it could only guess at is now named.
 *
 * DECLARING A LEGITIMATE CONTRACT STEP
 *
 * Dropping a column is not always a mistake — shipping the drop too early is. But
 * the gate had no vocabulary for the difference, so every legitimate N+1 contract
 * step looked identical to an accident and the only way past was the allowlist.
 * An audit whose only escape hatch is an allowlist decays into a list of things
 * we agreed not to look at.
 *
 * So a contract step says so, in the migration, where the reviewer reads it:
 *
 *   -- expand-only: contract-step
 *   -- retires: issues.assignee
 *   -- expanded-in: 20260912164233_a2-ownership-backfill
 *   -- reason: the backfill adjudicated every value; this is the last copy
 *
 * `retires:` must match what the replay measured EXACTLY. That is the load-bearing
 * half: a declaration cannot be a blanket pardon, so a migration that declares one
 * drop and smuggles a second still fails, and one that declares a drop it does not
 * perform fails too. `expanded-in:` must name a migration that really exists and
 * really is earlier. `reason:` is for the human; the gate only insists it is there.
 *
 * WHAT THIS STILL CANNOT CHECK, stated so nobody mistakes silence for proof: that
 * the expand shipped a RELEASE earlier rather than merely a migration earlier. The
 * tree carries no release boundary a script can read, so the gate verifies
 * ordering and leaves the release gap to the reviewer the `reason:` line is
 * addressed to.
 */

import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const MIGRATION_ROOT = 'apps/server/src/migrations/drizzle'

/** drizzle's own statement separator, and what the runtime migrator splits on. */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint'

export type FindingKind =
  | 'table-dropped'
  | 'column-dropped'
  | 'not-null-without-default'
  | 'undeclared-loss'
  | 'declaration-retires-nothing'
  | 'unknown-expand'
  | 'chain-does-not-replay'

export interface MigrationFinding {
  where: string
  kind: FindingKind
  /** What was measured or read — the column, the table, or the statement. */
  detail: string
}

/**
 * Frozen migrations, written before this gate existed, that genuinely destroy
 * data. Each comment is a one-line justification for the reviewer who eventually
 * removes it.
 *
 * This list was ELEVEN entries. Nine of them were table rebuilds that lose
 * nothing, allowlisted only because the old pattern-matcher could not tell a
 * rebuild from a drop; measuring the chain retired them (PDM-298). What is left
 * is the two pre-gate sites that really do drop data.
 */
export const HISTORICAL_ALLOWLIST = new Set<string>([
  // Pre-gate state-family backfill followed by destructive column drops.
  'apps/server/src/migrations/drizzle/20260730201523_per-user-state-family/migration.sql',
  // Pre-gate removal of the retired sync-feed table.
  'apps/server/src/migrations/drizzle/20260731225445_drop-dead-sync-feed/migration.sql',
])

// ---------------------------------------------------------------------------
// Reading the SQL: comments and literals first, always.
// ---------------------------------------------------------------------------

interface StatementSpan {
  original: string
  clean: string
}

/**
 * Replace comments and SQL string literals with whitespace before matching.
 * Newlines are preserved for readable output and semicolons are blanked inside
 * comments/literals so they cannot manufacture statement boundaries.
 */
export function stripCommentsAndStringLiterals(sql: string): string {
  let state: 'normal' | 'line-comment' | 'block-comment' | 'string' = 'normal'
  let out = ''

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]
    const next = sql[index + 1]

    if (state === 'line-comment') {
      if (char === '\n') {
        out += '\n'
        state = 'normal'
      } else {
        out += ' '
      }
      continue
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        out += '  '
        index++
        state = 'normal'
      } else {
        out += char === '\n' ? '\n' : ' '
      }
      continue
    }

    if (state === 'string') {
      if (char === "'" && next === "'") {
        out += '  '
        index++
      } else if (char === "'") {
        out += ' '
        state = 'normal'
      } else {
        out += char === '\n' ? '\n' : ' '
      }
      continue
    }

    if (char === '-' && next === '-') {
      out += '  '
      index++
      state = 'line-comment'
    } else if (char === '/' && next === '*') {
      out += '  '
      index++
      state = 'block-comment'
    } else if (char === "'") {
      out += ' '
      state = 'string'
    } else {
      out += char
    }
  }

  return out
}

function splitStatements(sql: string): StatementSpan[] {
  const clean = stripCommentsAndStringLiterals(sql)
  const spans: StatementSpan[] = []
  let start = 0

  const add = (end: number) => {
    const statementClean = clean.slice(start, end).trim()
    if (statementClean !== '') {
      spans.push({ original: sql.slice(start, end).trim(), clean: statementClean })
    }
  }

  for (let index = 0; index < clean.length; index++) {
    if (clean[index] !== ';') continue
    add(index + 1)
    start = index + 1
  }
  add(sql.length)

  return spans
}

// ---------------------------------------------------------------------------
// The one check replay cannot make: tightening is not loss.
// ---------------------------------------------------------------------------

/**
 * A column added NOT NULL with no default is additive in name only — it is a new
 * requirement on every writer, and the older binary that does not know to supply
 * it cannot insert a row. Replaying the schema cannot see this, because nothing
 * was lost; it has to be read out of the DDL.
 */
export function findTighteningDdl(sql: string): string[] {
  const addNotNullRe = /\bALTER\s+TABLE\b[\s\S]*?\bADD(?:\s+COLUMN)?\b[\s\S]*?\bNOT\s+NULL\b/i
  const defaultRe = /\bDEFAULT\b/i

  return splitStatements(sql)
    .filter((span) => addNotNullRe.test(span.clean) && !defaultRe.test(span.clean))
    .map((span) => span.original)
}

// ---------------------------------------------------------------------------
// The contract-step declaration.
// ---------------------------------------------------------------------------

export interface ContractDeclaration {
  /** Exactly what this step retires, as `table <name>` or `<table>.<column>`. */
  retires: string[]
  /** The migration directory whose expand this step contracts. */
  expandedIn: string | null
  reason: string | null
}

const DECLARATION_MARKER = /^\s*--\s*expand-only:\s*contract-step\s*$/im

/**
 * Read the declaration out of the migration's own comments. Deliberately a
 * comment rather than a side-file: the claim belongs next to the DDL it excuses,
 * in the diff the reviewer is already reading.
 */
export function parseContractDeclaration(sql: string): ContractDeclaration | null {
  if (!DECLARATION_MARKER.test(sql)) return null

  const retires: string[] = []
  let expandedIn: string | null = null
  let reason: string | null = null

  for (const line of sql.split('\n')) {
    const comment = line.match(/^\s*--\s*(.*)$/)?.[1]
    if (comment === undefined) continue

    const retiresMatch = comment.match(/^retires:\s*(.+)$/i)
    if (retiresMatch?.[1] !== undefined) {
      for (const item of retiresMatch[1].split(',')) {
        const trimmed = item.trim()
        if (trimmed !== '') retires.push(trimmed)
      }
      continue
    }

    const expandMatch = comment.match(/^expanded-in:\s*(\S+)\s*$/i)
    if (expandMatch?.[1] !== undefined) {
      expandedIn = expandMatch[1]
      continue
    }

    const reasonMatch = comment.match(/^reason:\s*(.+)$/i)
    if (reasonMatch?.[1] !== undefined) reason = reasonMatch[1].trim()
  }

  return { retires, expandedIn, reason }
}

// ---------------------------------------------------------------------------
// Measuring the chain.
// ---------------------------------------------------------------------------

/** table name → its column names. */
export type SchemaShape = Map<string, Set<string>>

export function shapeOf(db: Database): SchemaShape {
  const shape: SchemaShape = new Map()
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>

  for (const { name } of tables) {
    const columns = db.query(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>
    shape.set(name, new Set(columns.map((column) => column.name)))
  }
  return shape
}

export function applyMigration(db: Database, sql: string): void {
  for (const statement of sql.split(STATEMENT_BREAKPOINT)) {
    const trimmed = statement.trim()
    if (trimmed !== '') db.run(trimmed)
  }
}

/**
 * What a migration destroyed, as the names an operator would recognise. A table
 * that is gone is reported as the table, not as each of its columns — one fact,
 * not forty.
 */
export function lossBetween(before: SchemaShape, after: SchemaShape): string[] {
  const lost: string[] = []

  for (const [table, columns] of before) {
    const survivor = after.get(table)
    if (survivor === undefined) {
      lost.push(`table ${table}`)
      continue
    }
    for (const column of columns) {
      if (!survivor.has(column)) lost.push(`${table}.${column}`)
    }
  }

  return lost.sort()
}

// ---------------------------------------------------------------------------
// Adjudicating one migration: measurement against declaration.
// ---------------------------------------------------------------------------

export interface Adjudication {
  lost: string[]
  declaration: ContractDeclaration | null
  /** Migration directory names ordered before this one, for `expanded-in`. */
  earlier: ReadonlySet<string>
}

/**
 * The rule, in one place so a probe can drive it without a filesystem: loss with
 * no declaration is a finding; a declaration must account for the loss exactly,
 * name a real earlier expand, and carry a reason.
 */
export function adjudicate({ lost, declaration, earlier }: Adjudication): Array<{
  kind: FindingKind
  detail: string
}> {
  if (declaration === null) {
    return lost.map((item) => ({
      kind: item.startsWith('table ') ? ('table-dropped' as const) : ('column-dropped' as const),
      detail: `${item} is destroyed with no contract-step declaration`,
    }))
  }

  const findings: Array<{ kind: FindingKind; detail: string }> = []
  const declared = new Set(declaration.retires)

  for (const item of lost) {
    if (!declared.has(item)) {
      findings.push({
        kind: 'undeclared-loss',
        detail: `${item} is destroyed but the contract-step declaration does not retire it`,
      })
    }
  }

  for (const item of declared) {
    if (!lost.includes(item)) {
      findings.push({
        kind: 'declaration-retires-nothing',
        detail: `the declaration retires ${item}, but nothing of that name is destroyed here`,
      })
    }
  }

  if (declaration.expandedIn === null) {
    findings.push({
      kind: 'unknown-expand',
      detail: 'the contract-step declaration names no `expanded-in:` migration',
    })
  } else if (!earlier.has(declaration.expandedIn)) {
    findings.push({
      kind: 'unknown-expand',
      detail: `\`expanded-in: ${declaration.expandedIn}\` is not a migration that runs before this one`,
    })
  }

  if (declaration.reason === null) {
    findings.push({
      kind: 'unknown-expand',
      detail: 'the contract-step declaration carries no `reason:` line for the reviewer',
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

function migrationDirectories(): string[] {
  return readdirSync(join(ROOT, MIGRATION_ROOT), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

export function runChecks(): MigrationFinding[] {
  const findings: MigrationFinding[] = []
  const directories = migrationDirectories()
  const earlier = new Set<string>()
  const db = new Database(':memory:')

  for (const directory of directories) {
    const path = relative(ROOT, join(ROOT, MIGRATION_ROOT, directory, 'migration.sql'))
    const sql = readFileSync(join(ROOT, path), 'utf8')

    const before = shapeOf(db)
    try {
      applyMigration(db, sql)
    } catch (error) {
      // A fresh install replays exactly this chain from empty. If it cannot, the
      // gate has no measurement to report and says so rather than guessing.
      findings.push({
        where: path,
        kind: 'chain-does-not-replay',
        detail: `${(error as Error).message} — the gate could measure nothing past this point`,
      })
      return findings
    }
    const after = shapeOf(db)

    for (const statement of findTighteningDdl(sql)) {
      findings.push({ where: path, kind: 'not-null-without-default', detail: statement })
    }

    if (!HISTORICAL_ALLOWLIST.has(path)) {
      const adjudicated = adjudicate({
        lost: lossBetween(before, after),
        declaration: parseContractDeclaration(sql),
        earlier,
      })
      for (const finding of adjudicated) findings.push({ where: path, ...finding })
    }

    earlier.add(directory)
  }

  return findings
}

// ---------------------------------------------------------------------------
// The probes. Every check gets a planted violation AND a planted innocent.
// ---------------------------------------------------------------------------

const BASELINE = `CREATE TABLE probe_table (
  id text PRIMARY KEY,
  keep_me text,
  old_value text
);`

/**
 * A check that only ever fires proves as little as one that never does. The
 * twenty false findings that kept this gate red for a month were all one shape —
 * a rebuild that loses nothing — so that shape gets a probe of its own, and it
 * asserts SILENCE. Weakening the gate back to where it started would turn that
 * probe red, which is the point of it.
 */
export const PROBES: ReadonlyArray<{
  name: string
  sql: string
  /** The findings this must produce, by kind. Empty means it must be spared. */
  expect: FindingKind[]
}> = [
  {
    name: 'plain additive column',
    sql: 'ALTER TABLE probe_table ADD COLUMN note text;',
    expect: [],
  },
  { name: 'a new table', sql: 'CREATE TABLE probe_new (id text PRIMARY KEY);', expect: [] },
  { name: 'DROP TABLE', sql: 'DROP TABLE probe_table;', expect: ['table-dropped'] },
  {
    name: 'DROP COLUMN',
    sql: 'ALTER TABLE probe_table DROP COLUMN old_value;',
    expect: ['column-dropped'],
  },
  {
    name: 'RENAME COLUMN, which loses the old name',
    sql: 'ALTER TABLE probe_table RENAME COLUMN old_value TO new_value;',
    expect: ['column-dropped'],
  },
  {
    name: 'a table rebuild that DROPS a column',
    sql: `CREATE TABLE __new_probe_table (id text PRIMARY KEY, keep_me text);
INSERT INTO __new_probe_table(id, keep_me) SELECT id, keep_me FROM probe_table;
DROP TABLE probe_table;
ALTER TABLE __new_probe_table RENAME TO probe_table;`,
    expect: ['column-dropped'],
  },
  {
    // THE NEGATIVE CONTROL. Drizzle emits this for any change SQLite cannot make
    // in place — a default, a primary key, a check. It loses nothing, and the old
    // gate called every one of them destructive.
    name: 'a table rebuild that PRESERVES every column',
    sql: `CREATE TABLE __new_probe_table (id text PRIMARY KEY, keep_me text, old_value text NOT NULL DEFAULT '');
INSERT INTO __new_probe_table(id, keep_me, old_value) SELECT id, keep_me, old_value FROM probe_table;
DROP TABLE probe_table;
ALTER TABLE __new_probe_table RENAME TO probe_table;`,
    expect: [],
  },
  {
    name: 'NOT NULL with no default, which is additive in name only',
    // SQLite refuses this against a non-empty table, which is the hazard; the
    // planted table is empty so the probe measures the CHECK, not sqlite's mood.
    sql: 'ALTER TABLE probe_table ADD COLUMN required_value text NOT NULL;',
    expect: ['not-null-without-default'],
  },
  {
    name: 'NOT NULL WITH a default',
    sql: "ALTER TABLE probe_table ADD COLUMN required_value text NOT NULL DEFAULT 'x';",
    expect: [],
  },
  {
    name: 'a declared contract step that accounts for its loss',
    sql: `-- expand-only: contract-step
-- retires: probe_table.old_value
-- expanded-in: 00000000000000_probe-expand
-- reason: the probe expand replaced it
ALTER TABLE probe_table DROP COLUMN old_value;`,
    expect: [],
  },
  {
    // The anti-laundering probe: a declaration is not a blanket pardon.
    name: 'a declared contract step that smuggles a second drop',
    sql: `-- expand-only: contract-step
-- retires: probe_table.old_value
-- expanded-in: 00000000000000_probe-expand
-- reason: the probe expand replaced it
ALTER TABLE probe_table DROP COLUMN old_value;
ALTER TABLE probe_table DROP COLUMN keep_me;`,
    expect: ['undeclared-loss'],
  },
  {
    name: 'a declaration naming an expand that does not exist',
    sql: `-- expand-only: contract-step
-- retires: probe_table.old_value
-- expanded-in: 99999999999999_never-happened
-- reason: the probe expand replaced it
ALTER TABLE probe_table DROP COLUMN old_value;`,
    expect: ['unknown-expand'],
  },
  {
    name: 'a declaration with no reason for the reviewer',
    sql: `-- expand-only: contract-step
-- retires: probe_table.old_value
-- expanded-in: 00000000000000_probe-expand
ALTER TABLE probe_table DROP COLUMN old_value;`,
    expect: ['unknown-expand'],
  },
]

/** Run one probe against a planted baseline and report the kinds it produced. */
export function probeKinds(sql: string): FindingKind[] {
  const db = new Database(':memory:')
  applyMigration(db, BASELINE)
  const before = shapeOf(db)
  applyMigration(db, sql)
  const after = shapeOf(db)

  const kinds: FindingKind[] = findTighteningDdl(sql).map(() => 'not-null-without-default')
  for (const finding of adjudicate({
    lost: lossBetween(before, after),
    declaration: parseContractDeclaration(sql),
    earlier: new Set(['00000000000000_probe-expand']),
  })) {
    kinds.push(finding.kind)
  }
  return kinds.sort()
}

export function probeFailures(): string[] {
  return PROBES.flatMap((probe) => {
    const got = probeKinds(probe.sql)
    const want = [...probe.expect].sort()
    return got.join(',') === want.join(',')
      ? []
      : [`${probe.name} → expected [${want}], got [${got}]`]
  })
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2))

  if (args.has('--probe')) {
    for (const probe of PROBES) {
      const got = probeKinds(probe.sql)
      const want = [...probe.expect].sort()
      const ok = got.join(',') === want.join(',')
      const verb = probe.expect.length === 0 ? 'spares' : 'catches'
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${verb}  ${probe.name} → [${got}]`)
    }

    const failures = probeFailures()
    if (failures.length > 0) {
      console.error(
        `\nexpand-only migration audit: ${failures.length} probe failure(s) — the gate is not evidence`,
      )
      process.exit(1)
    }
    // Deliberately NOT an assertion about the real tree. That conflation is what
    // suppressed this gate's output for a month: `--probe && gate` short-circuited
    // on a red tree, so CI printed one line about the instrument and not one of
    // the findings it had measured (PDM-298).
    console.log(
      '\nexpand-only migration audit: every check fired on its planted violation and spared its planted innocent',
    )
    process.exit(0)
  }

  const findings = runChecks()
  if (args.has('--json')) {
    console.log(JSON.stringify({ findings }, null, 2))
  } else {
    for (const finding of findings) {
      console.error(`${finding.kind}\n  ${finding.where}\n  ${finding.detail}\n`)
    }
  }

  if (findings.length > 0) {
    console.error(`expand-only migration audit: ${findings.length} finding(s)`)
    process.exit(1)
  }
  if (!args.has('--json')) {
    console.log('expand-only migration audit OK — no migration destroys anything undeclared')
  }
}
