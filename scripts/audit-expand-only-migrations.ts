#!/usr/bin/env bun
/**
 * THE EXPAND-ONLY GATE for schema migrations.
 *
 *   bun run audit:expand-only            # the gate — exit 1 on any finding
 *   bun run audit:expand-only --json
 *   bun run audit:expand-only --probe    # prove every check can say YES
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
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const MIGRATION_ROOT = 'apps/server/src/migrations/drizzle'

export type DestructiveDdlKind =
  | 'drop-table'
  | 'drop-column'
  | 'rename'
  | 'table-rebuild'
  | 'not-null-without-default'

export interface DestructiveDdlFinding {
  statement: string
  kind: DestructiveDdlKind
}

export interface MigrationFinding extends DestructiveDdlFinding {
  where: string
}

/**
 * These are frozen migrations written before this gate existed. The allowlist
 * contains sites, not explanations the gate would need to parse: each comment
 * is a one-line justification for the reviewer who eventually removes it.
 */
export const HISTORICAL_ALLOWLIST = new Set<string>([
  // Pre-gate SQLite table rebuilds for the per-user state keying migration.
  'apps/server/src/migrations/drizzle/20260730104951_per-user-state-keying/migration.sql',
  // Pre-gate state-family backfill followed by destructive column drops.
  'apps/server/src/migrations/drizzle/20260730201523_per-user-state-family/migration.sql',
  // Pre-gate removal of the retired sync-feed table.
  'apps/server/src/migrations/drizzle/20260731225445_drop-dead-sync-feed/migration.sql',
  // Pre-gate message lifecycle table rebuild.
  'apps/server/src/migrations/drizzle/20260717150407_message-lifecycle-834/migration.sql',
  // Pre-gate proposed-lane issue table rebuild.
  'apps/server/src/migrations/drizzle/20260718123614_proposed-lane-brief/migration.sql',
  // Pre-gate session stop metadata table rebuild.
  'apps/server/src/migrations/drizzle/20260718124039_session-stop-metadata/migration.sql',
  // Pre-gate first-admin user migration table rebuild.
  'apps/server/src/migrations/drizzle/20260730173834_user-accounts-first-admin/migration.sql',
  // Pre-gate feed identity singleton table rebuild.
  'apps/server/src/migrations/drizzle/20260731221009_feed-identity-singleton/migration.sql',
  // Pre-gate inbox attribution table rebuild.
  'apps/server/src/migrations/drizzle/20260801022516_inbox-attribution-delegation/migration.sql',
  // Pre-gate local-machine-defaults table rebuilds.
  'apps/server/src/migrations/drizzle/20260802035017_drop-local-machine-defaults/migration.sql',
  // Pre-gate session attribution table rebuild.
  'apps/server/src/migrations/drizzle/20260803030000_session-attribution-pair/migration.sql',
])

interface StatementSpan {
  start: number
  end: number
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

function splitStatements(sql: string, clean: string): StatementSpan[] {
  const spans: StatementSpan[] = []
  let start = 0

  const add = (end: number) => {
    const original = sql.slice(start, end).trim()
    const statementClean = clean.slice(start, end).trim()
    if (statementClean !== '') {
      spans.push({ start, end, original, clean: statementClean })
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

const IDENTIFIER = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)'

function unquoteIdentifier(identifier: string): string {
  if (
    (identifier.startsWith('`') && identifier.endsWith('`')) ||
    (identifier.startsWith('"') && identifier.endsWith('"')) ||
    (identifier.startsWith('[') && identifier.endsWith(']'))
  ) {
    return identifier.slice(1, -1)
  }
  return identifier
}

function identifierAfter(
  statement: string,
  expression: RegExp,
): string | null {
  return statement.match(expression)?.[1] ?? null
}

interface RebuildFinding {
  start: number
  covered: Set<number>
  finding: DestructiveDdlFinding
}

function findTableRebuilds(sql: string, spans: StatementSpan[]): RebuildFinding[] {
  const rebuilds: RebuildFinding[] = []
  const createRe = new RegExp(
    `\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})`,
    'i',
  )
  const insertRe = new RegExp(`\\bINSERT\\s+INTO\\s+(${IDENTIFIER})`, 'i')
  const dropRe = new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${IDENTIFIER})`, 'i')
  const renameRe = new RegExp(
    `\\bALTER\\s+TABLE\\s+(${IDENTIFIER})\\s+RENAME\\s+TO\\s+(${IDENTIFIER})`,
    'i',
  )

  for (const [createIndex, createSpan] of spans.entries()) {
    const newTableToken = identifierAfter(createSpan.clean, createRe)
    if (newTableToken === null) continue

    const newTable = unquoteIdentifier(newTableToken)
    if (!newTable.toLowerCase().startsWith('__new_')) continue
    const oldTable = newTable.slice('__new_'.length)

    const insertIndex = spans.findIndex(
      (span, index) =>
        index > createIndex &&
        unquoteIdentifier(identifierAfter(span.clean, insertRe) ?? '').toLowerCase() ===
          newTable.toLowerCase(),
    )
    const dropIndex = spans.findIndex(
      (span, index) =>
        index > createIndex &&
        unquoteIdentifier(identifierAfter(span.clean, dropRe) ?? '').toLowerCase() ===
          oldTable.toLowerCase(),
    )
    const renameIndex = spans.findIndex((span, index) => {
      if (index <= createIndex) return false
      const match = span.clean.match(renameRe)
      const renamedFrom = match?.[1]
      const renamedTo = match?.[2]
      return (
        renamedFrom !== undefined &&
        renamedTo !== undefined &&
        unquoteIdentifier(renamedFrom).toLowerCase() === newTable.toLowerCase() &&
        unquoteIdentifier(renamedTo).toLowerCase() === oldTable.toLowerCase()
      )
    })

    if (insertIndex < 0 || dropIndex < 0 || renameIndex < 0) continue
    const covered = new Set([createIndex, insertIndex, dropIndex, renameIndex])
    const renameSpan = spans[renameIndex]
    if (renameSpan === undefined) continue
    rebuilds.push({
      start: createSpan.start,
      covered,
      finding: {
        kind: 'table-rebuild',
        statement: sql.slice(createSpan.start, renameSpan.end).trim(),
      },
    })
  }

  return rebuilds
}

/** Find destructive DDL in one migration's SQL text. */
export function findDestructiveDdl(sql: string): DestructiveDdlFinding[] {
  // This order is load-bearing: prose and string contents must be gone before
  // any detector runs, or a comment can create a false finding and teach the
  // next migration author to add an allowlist entry for prose.
  const clean = stripCommentsAndStringLiterals(sql)
  const spans = splitStatements(sql, clean)
  const rebuilds = findTableRebuilds(sql, spans)
  const covered = new Set<number>(rebuilds.flatMap((rebuild) => [...rebuild.covered]))
  const findings: Array<{ start: number; finding: DestructiveDdlFinding }> = rebuilds.map(
    ({ start, finding }) => ({ start, finding }),
  )

  const dropTableRe = /\bDROP\s+TABLE\b/i
  const dropColumnRe = /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i
  const renameRe = /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\b/i
  const addNotNullRe = /\bALTER\s+TABLE\b[\s\S]*?\bADD(?:\s+COLUMN)?\b[\s\S]*?\bNOT\s+NULL\b/i
  const defaultRe = /\bDEFAULT\b/i

  for (const [index, span] of spans.entries()) {
    if (covered.has(index)) continue

    let kind: DestructiveDdlKind | null = null
    if (dropTableRe.test(span.clean)) {
      kind = 'drop-table'
    } else if (dropColumnRe.test(span.clean)) {
      kind = 'drop-column'
    } else if (renameRe.test(span.clean)) {
      kind = 'rename'
    } else if (addNotNullRe.test(span.clean) && !defaultRe.test(span.clean)) {
      kind = 'not-null-without-default'
    }

    if (kind !== null) findings.push({ start: span.start, finding: { kind, statement: span.original } })
  }

  findings.sort((left, right) => left.start - right.start)
  return findings.map(({ finding }) => finding)
}

function migrationFiles(): string[] {
  const root = join(ROOT, MIGRATION_ROOT)
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name === 'migration.sql') {
        files.push(relative(ROOT, full))
      }
    }
  }
  walk(root)
  return files.sort()
}

export function runChecks(): MigrationFinding[] {
  const findings: MigrationFinding[] = []
  for (const path of migrationFiles()) {
    if (HISTORICAL_ALLOWLIST.has(path)) continue
    const sql = readFileSync(join(ROOT, path), 'utf8')
    for (const finding of findDestructiveDdl(sql)) {
      findings.push({ where: path, ...finding })
    }
  }
  return findings
}

/** Every detector gets its own planted violation. A missing check cannot hide
 * behind the clean historical tree and call itself a pass. */
export const PROBES: ReadonlyArray<{
  name: string
  sql: string
  expect: DestructiveDdlKind
}> = [
  { name: 'DROP TABLE', sql: 'DROP TABLE probe_table;', expect: 'drop-table' },
  {
    name: 'DROP COLUMN',
    sql: 'ALTER TABLE probe_table DROP COLUMN old_value;',
    expect: 'drop-column',
  },
  {
    name: 'RENAME',
    sql: 'ALTER TABLE probe_table RENAME COLUMN old_name TO new_name;',
    expect: 'rename',
  },
  {
    name: 'SQLite table rebuild',
    sql: `CREATE TABLE __new_probe_table (id text PRIMARY KEY);
INSERT INTO __new_probe_table SELECT id FROM probe_table;
DROP TABLE probe_table;
ALTER TABLE __new_probe_table RENAME TO probe_table;`,
    expect: 'table-rebuild',
  },
  {
    name: 'NOT NULL without a default',
    sql: 'ALTER TABLE probe_table ADD COLUMN required_value text NOT NULL;',
    expect: 'not-null-without-default',
  },
]

export function probeFailures(): string[] {
  return PROBES.flatMap((probe) => {
    const findings = findDestructiveDdl(probe.sql)
    return findings.some((finding) => finding.kind === probe.expect)
      ? []
      : [`${probe.name} → expected ${probe.expect}, got [${findings.map((f) => f.kind)}]`]
  })
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2))

  if (args.has('--probe')) {
    const failures = probeFailures()
    for (const probe of PROBES) {
      const findings = findDestructiveDdl(probe.sql)
      const ok = findings.some((finding) => finding.kind === probe.expect)
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${probe.name} → expected ${probe.expect}, got [${findings.map((f) => f.kind)}]`,
      )
    }

    const clean = runChecks()
    if (clean.length > 0) {
      console.log(`FAIL  the real migration tree should be clean, got ${clean.length} finding(s)`)
    } else {
      console.log('PASS  the real migration tree is clean after the historical allowlist')
    }

    if (failures.length > 0 || clean.length > 0) {
      console.error(
        `\nexpand-only migration audit: ${failures.length + (clean.length > 0 ? 1 : 0)} probe/clean-tree failure(s) — the gate is not evidence`,
      )
      process.exit(1)
    }
    console.log('\nexpand-only migration audit: every check fired on its planted violation and spared the clean tree')
    process.exit(0)
  }

  const findings = runChecks()
  if (args.has('--json')) {
    console.log(JSON.stringify({ findings }, null, 2))
  } else {
    for (const finding of findings) {
      console.error(`${finding.kind}\n  ${finding.where}\n  ${finding.statement}\n`)
    }
  }

  if (findings.length > 0) {
    console.error(`expand-only migration audit: ${findings.length} finding(s)`)
    process.exit(1)
  }
  if (!args.has('--json')) {
    console.log('expand-only migration audit OK — all migration DDL is additive')
  }
}
