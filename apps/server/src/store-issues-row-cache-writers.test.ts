import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * EVERY WRITER TO THE `issues` TABLE INVALIDATES THE FRAME ROW CACHE [POD-1939].
 *
 * POD-1931's frame cache is correct only while every statement that writes the
 * table calls `invalidateRowCache()` first. That rule lived in call-site
 * cooperation and a comment, and a rename had already nearly dropped one of the
 * sites (POD-1360's `backfillNullRepoIds` → `migrateLegacyIssueRepoIds`). A
 * behavioural test per existing method could not have caught that class of
 * mistake at all: it can only assert about methods that already exist, and the
 * failure being guarded against is a write path that does not exist yet.
 *
 * So this reads the SOURCE. It enumerates every statement in `store/issues.ts`
 * that writes the `issues` table, resolves the method that encloses it, and
 * fails unless that method invalidates BEFORE the write. A new write path is
 * caught the moment it is written, whatever it is called.
 *
 * TWO WRITE FORMS, because the repository is mid-conversion to drizzle
 * (POD-3221 step 5d). A hand-written statement is found in the SQL text of a
 * string or template literal; a builder write is found as a call —
 * `.insert(issues)` / `.update(issues)` / `.delete(issues)` — on the schema's
 * table object. A scan that knew only the SQL text would go quiet the moment
 * `issues.ts` converted, which is the same class of silent failure POD-1360
 * nearly shipped, one conversion instead of one rename. The builder arm asks
 * what a reference RESOLVES to, so `import { issues as issuesTable }` and
 * `schema.issues` are both the table, and `issueLabels` is not.
 *
 * WHY NOT WRAP THE HANDLE. Wrapping `SqlDatabase` so a write invalidates
 * automatically is the obvious design, and it is unsafe here: `transaction()`
 * (packages/runtime/src/sqlite/transaction.ts) tracks nesting depth in a
 * `WeakMap` keyed by the handle OBJECT. A repository holding a wrapper would
 * present a different key from the raw handle every other repository and the
 * store facade use, so its `transaction()` would read depth 0 while a
 * transaction opened on the raw handle was already in flight and issue `BEGIN
 * IMMEDIATE` inside it — "cannot start a transaction within a transaction".
 * The invariant is therefore enforced, not automated.
 *
 * ORDERING IS PART OF THE INVARIANT, not decoration. Invalidating after the
 * write would still empty the map, but reads taken between the write and the
 * invalidation would cache rows read inside an open transaction — and those
 * survive a rollback for the rest of the turn, which is precisely what
 * `rowCacheDisabledForFrame` exists to prevent.
 *
 * SCOPE. `store/issues.ts` is the repository that owns the cache. Migration SQL
 * (`migrations/`) writes the table too, but it runs at boot before the
 * repository serves any read, so it is outside this rule and outside this scan.
 */

const INVALIDATOR = 'invalidateRowCache'

/**
 * The scanned file, named REPO-RELATIVE and resolved from the repository root on
 * purpose. `scripts/server-test-shards.ts` derives each shard's Turbo `inputs`
 * from the import closure, and this test has no import edge to the file it
 * reads; it recognises a source-reading test by a repo-root path literal next to
 * a filesystem call, and only then carries `apps/server/src/store/issues.ts`
 * into the lane's inputs. Written as `join(import.meta.dirname, 'store/...')`
 * the literal is invisible to that scan, the shard's key does not cover
 * issues.ts, and a commit that adds a forgotten write path replays as a CACHE
 * HIT — a green from a lane that never ran. Keep the literal.
 */
const SOURCE_RELATIVE = 'apps/server/src/store/issues.ts'

const SOURCE_PATH = join(fileURLToPath(new URL('../../../', import.meta.url)), SOURCE_RELATIVE)

/** The table this guard is about, as the schema file exports it. */
const TABLE = 'issues'

/**
 * The three ways SQLite writes a table, tolerant of the whitespace and newlines
 * a multi-line template literal puts between the keywords, of the `OR IGNORE` /
 * `OR REPLACE` conflict clauses, and of a quoted table name — the last because
 * a `sql\`UPDATE "issues" …\`` fragment inside a builder query is a write like
 * any other and must not be able to hide behind its quotes. `issues\b` keeps the
 * child tables (`issue_labels`, `issue_deps`, `issue_ref_letters`, …) out.
 */
const QUOTED = String.raw`["'\`\[]?`
const WRITE_PATTERNS: { kind: 'INSERT' | 'UPDATE' | 'DELETE'; pattern: RegExp }[] = [
  {
    kind: 'INSERT',
    pattern: new RegExp(
      String.raw`\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+${QUOTED}issues\b`,
      'i',
    ),
  },
  {
    kind: 'UPDATE',
    pattern: new RegExp(String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?${QUOTED}issues\b`, 'i'),
  },
  { kind: 'DELETE', pattern: new RegExp(String.raw`\bDELETE\s+FROM\s+${QUOTED}issues\b`, 'i') },
]

/**
 * drizzle's three write builders. Each takes the table object as its only
 * argument, which is what makes this scannable at all: the table is named at
 * the call, not buried in a string.
 */
const BUILDER_WRITES = new Map<string, 'INSERT' | 'UPDATE' | 'DELETE'>([
  ['insert', 'INSERT'],
  ['update', 'UPDATE'],
  ['delete', 'DELETE'],
])

interface Write {
  kind: 'INSERT' | 'UPDATE' | 'DELETE'
  /** Which detector saw it: hand-written SQL text, or a drizzle write builder. */
  form: 'sql-text' | 'builder'
  line: number
  /** Enclosing method, or null for a write that is not inside one at all. */
  method: string | null
  pos: number
}

interface Violation {
  reason: 'no-invalidation' | 'invalidation-after-write' | 'write-outside-method'
  method: string | null
  line: number
  kind: string
  form: Write['form']
}

interface Scan {
  writes: Write[]
  violations: Violation[]
}

/** The innermost class method enclosing a node, if any. */
const enclosingMethod = (node: ts.Node): ts.MethodDeclaration | undefined => {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isMethodDeclaration(n)) return n
    // A write in a constructor, a free function or a property initializer has no
    // method to carry the rule; it is reported rather than silently skipped.
    if (ts.isConstructorDeclaration(n) || ts.isFunctionDeclaration(n)) return undefined
  }
  return undefined
}

const methodName = (m: ts.MethodDeclaration): string => m.name.getText()

/**
 * Local name → exported name for every named import in the file, so a reference
 * is judged by what it resolves to. `import { issues as issuesTable }` makes
 * `issuesTable` the table; nothing else in the file can become it by being
 * spelled `issues`.
 */
const importAliases = (sf: ts.SourceFile): Map<string, string> => {
  const aliases = new Map<string, string>()
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      aliases.set(element.name.text, (element.propertyName ?? element.name).text)
    }
  }
  return aliases
}

/**
 * Does this argument name the `issues` TABLE? Either a reference resolving to
 * the schema's `issues` export — under any import alias — or a namespaced
 * `schema.issues`. `issueLabels`, `issueDeps` and the rest resolve to their own
 * names and are not it.
 */
const namesIssuesTable = (node: ts.Expression, aliases: Map<string, string>): boolean => {
  if (ts.isIdentifier(node)) return (aliases.get(node.text) ?? node.text) === TABLE
  if (ts.isPropertyAccessExpression(node)) return node.name.text === TABLE
  return false
}

/** `this.foo(...)` → `foo`, for any other call shape → undefined. */
const selfCallName = (node: ts.Node): string | undefined => {
  if (!ts.isCallExpression(node)) return undefined
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  return callee.expression.kind === ts.SyntaxKind.ThisKeyword ? callee.name.text : undefined
}

/**
 * Scan a TypeScript source for `issues`-table writes and check each one's
 * enclosing method invalidates first. Takes source text rather than a path so
 * the fixtures below can prove the scanner can FAIL — a guard nobody has seen
 * go red is not a guard.
 */
const scanRowCacheWriters = (source: string, fileName = 'issues.ts'): Scan => {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1
  const aliases = importAliases(sf)

  /** Every `this.x()` call per method, in source order. */
  const callsByMethod = new Map<string, { name: string; pos: number }[]>()
  const writes: Write[] = []
  const seen = new Set<string>()

  const record = (kind: Write['kind'], form: Write['form'], node: ts.Node): void => {
    const line = lineOf(node.getStart())
    // A template expression and a string literal nested inside it would both
    // match; one statement is one write.
    const key = `${form}:${kind}:${line}`
    if (seen.has(key)) return
    seen.add(key)
    const method = enclosingMethod(node)
    writes.push({
      kind,
      form,
      line,
      method: method ? methodName(method) : null,
      pos: node.getStart(),
    })
  }

  const visit = (node: ts.Node): void => {
    const called = selfCallName(node)
    if (called) {
      const method = enclosingMethod(node)
      if (method) {
        const key = methodName(method)
        const list = callsByMethod.get(key)
        if (list) list.push({ name: called, pos: node.getStart() })
        else callsByMethod.set(key, [{ name: called, pos: node.getStart() }])
      }
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const text = node.getText()
      for (const { kind, pattern } of WRITE_PATTERNS) {
        if (pattern.test(text)) record(kind, 'sql-text', node)
      }
    }
    // A drizzle write builder: `<anything>.insert(issues)`, `.update(issues)`,
    // `.delete(issues)`. The receiver is deliberately not constrained — the
    // executor's handle may be reached as `this.db`, `tx`, or through any field
    // a later refactor introduces, and a guard that pinned the receiver's name
    // would go quiet on the rename it exists to catch. What is constrained is
    // the argument: it must resolve to the `issues` table.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const kind = BUILDER_WRITES.get(node.expression.name.text)
      const [arg] = node.arguments
      if (kind && node.arguments.length === 1 && arg && namesIssuesTable(arg, aliases)) {
        record(kind, 'builder', node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  /** Does this method invalidate — itself, or through a method that does? */
  const invalidates = (name: string, chain: Set<string>): boolean => {
    if (name === INVALIDATOR) return true
    if (chain.has(name)) return false
    chain.add(name)
    return (callsByMethod.get(name) ?? []).some((c) => invalidates(c.name, chain))
  }

  /** Source position of the earliest call in `name` that invalidates. */
  const invalidationPos = (name: string): number | undefined => {
    const positions = (callsByMethod.get(name) ?? [])
      .filter((c) => invalidates(c.name, new Set([name])))
      .map((c) => c.pos)
    return positions.length ? Math.min(...positions) : undefined
  }

  const violations: Violation[] = []
  const violation = (write: Write, reason: Violation['reason']): Violation => ({
    reason,
    method: write.method,
    line: write.line,
    kind: write.kind,
    form: write.form,
  })
  for (const write of writes) {
    if (!write.method) {
      violations.push(violation(write, 'write-outside-method'))
      continue
    }
    const at = invalidationPos(write.method)
    if (at === undefined) violations.push(violation(write, 'no-invalidation'))
    else if (at > write.pos) violations.push(violation(write, 'invalidation-after-write'))
  }
  return { writes, violations }
}

const explain = (violations: Violation[]): string =>
  violations
    .map(
      (v) =>
        `${SOURCE_RELATIVE}:${v.line} — ${v.kind} on \`issues\` (${v.form})${v.method ? ` in ${v.method}()` : ''}: ` +
        (v.reason === 'no-invalidation'
          ? `the method never calls this.${INVALIDATOR}()`
          : v.reason === 'invalidation-after-write'
            ? `this.${INVALIDATOR}() is called AFTER the write`
            : 'the write is not inside a class method, so the rule cannot be checked'),
    )
    .join('\n')

describe('issues row cache: every writer invalidates', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8')

  it('every statement writing the issues table invalidates the row cache first', () => {
    const { violations } = scanRowCacheWriters(source)
    expect(explain(violations)).toBe('')
  })

  // ---- the scanner is armed ----
  //
  // The assertion above is a pass over an empty list, so on its own it cannot
  // tell "no violations" from "sees nothing". These pin the other end.

  it('sees the write statements that are actually in the file', () => {
    const { writes } = scanRowCacheWriters(source)
    // Not a pinned list of method names: a rename must not be able to make the
    // scan go quiet, which is the failure mode POD-1360 nearly shipped.
    expect(writes.length).toBeGreaterThanOrEqual(5)
    expect(new Set(writes.map((w) => w.kind))).toEqual(new Set(['INSERT', 'UPDATE', 'DELETE']))
    expect(writes.filter((w) => w.method === null)).toEqual([])
  })

  it('fails a new write path whose method does not invalidate', () => {
    const { violations } = scanRowCacheWriters(`
      class IssuesRepository {
        archiveIssue(id: string): void {
          this.db.prepare('UPDATE issues SET archived = 1 WHERE id = ?').run(id)
        }
      }
    `)
    expect(violations.map((v) => [v.method, v.reason])).toEqual([
      ['archiveIssue', 'no-invalidation'],
    ])
  })

  it('fails a method that invalidates only after the write', () => {
    const { violations } = scanRowCacheWriters(`
      class IssuesRepository {
        archiveIssue(id: string): void {
          this.db.prepare('UPDATE issues SET archived = 1 WHERE id = ?').run(id)
          this.invalidateRowCache()
        }
      }
    `)
    expect(violations.map((v) => [v.method, v.reason])).toEqual([
      ['archiveIssue', 'invalidation-after-write'],
    ])
  })

  it('fails a write that is not inside a method at all', () => {
    const { violations } = scanRowCacheWriters(`
      function heal(db: SqlDatabase): void {
        db.prepare('DELETE FROM issues WHERE deleted_at IS NOT NULL').run()
      }
    `)
    expect(violations.map((v) => v.reason)).toEqual(['write-outside-method'])
  })

  it('accepts a write invalidated through a helper called first', () => {
    const scan = scanRowCacheWriters(`
      class IssuesRepository {
        private beginWrite(): void {
          this.invalidateRowCache()
        }
        archiveIssue(id: string): void {
          this.beginWrite()
          this.db.prepare('UPDATE issues SET archived = 1 WHERE id = ?').run(id)
        }
      }
    `)
    expect(scan.writes.length).toBe(1)
    expect(scan.violations).toEqual([])
  })

  it('sees a write inside a transaction callback, and the multi-line SQL forms', () => {
    const scan = scanRowCacheWriters(`
      class IssuesRepository {
        bulk(rows: Row[]): void {
          this.invalidateRowCache()
          transaction(this.db, () => {
            this.db
              .prepare(\`INSERT OR IGNORE
                          INTO issues
                            (id, seq)
                          VALUES (?, ?)\`)
              .run(rows[0].id, rows[0].seq)
          })
        }
      }
    `)
    expect(scan.writes.map((w) => [w.kind, w.method])).toEqual([['INSERT', 'bulk']])
    expect(scan.violations).toEqual([])
  })

  // ---- the builder forms, which the repository converts to (POD-3221 step 5d) ----
  //
  // Same rule, same reporting, a different way of naming the table. Each of
  // these has a hand-written twin above; the pair is the point, because the
  // conversion must not be able to lower the guard.

  it('fails a builder write path whose method does not invalidate', () => {
    const { writes, violations } = scanRowCacheWriters(`
      import { issues } from '../migrations/schema'
      class IssuesRepository {
        archiveIssue(id: string): void {
          this.db.update(issues).set({ archived: 1 }).where(eq(issues.id, id)).run()
        }
      }
    `)
    expect(writes.map((w) => [w.kind, w.form])).toEqual([['UPDATE', 'builder']])
    expect(violations.map((v) => [v.method, v.reason])).toEqual([
      ['archiveIssue', 'no-invalidation'],
    ])
  })

  it('fails a builder insert and delete that invalidate only after the write', () => {
    const { violations } = scanRowCacheWriters(`
      import { issues } from '../migrations/schema'
      class IssuesRepository {
        replaceIssue(row: Row): void {
          this.db.insert(issues).values(row).run()
          this.invalidateRowCache()
        }
        purge(id: string): void {
          this.db.delete(issues).where(eq(issues.id, id)).run()
          this.invalidateRowCache()
        }
      }
    `)
    expect(violations.map((v) => [v.method, v.kind, v.reason])).toEqual([
      ['replaceIssue', 'INSERT', 'invalidation-after-write'],
      ['purge', 'DELETE', 'invalidation-after-write'],
    ])
  })

  it('fails a builder write that is not inside a method at all', () => {
    const { violations } = scanRowCacheWriters(`
      import { issues } from '../migrations/schema'
      function heal(db: Db): void {
        db.delete(issues).where(isNotNull(issues.deletedAt)).run()
      }
    `)
    expect(violations.map((v) => [v.reason, v.form])).toEqual([['write-outside-method', 'builder']])
  })

  it('follows the table through an import alias and a namespace import', () => {
    const { writes, violations } = scanRowCacheWriters(`
      import { issues as issuesTable } from '../migrations/schema'
      import * as schema from '../migrations/schema'
      class IssuesRepository {
        renamed(id: string): void {
          this.db.update(issuesTable).set({ archived: 1 }).run()
        }
        namespaced(id: string): void {
          this.db.delete(schema.issues).run()
        }
      }
    `)
    expect(writes.map((w) => [w.kind, w.method])).toEqual([
      ['UPDATE', 'renamed'],
      ['DELETE', 'namespaced'],
    ])
    expect(violations.map((v) => v.reason)).toEqual(['no-invalidation', 'no-invalidation'])
  })

  it('accepts a builder write invalidated first, inside a transaction body', () => {
    const scan = scanRowCacheWriters(`
      import { issues } from '../migrations/schema'
      class IssuesRepository {
        bulk(rows: Row[]): void {
          this.invalidateRowCache()
          this.transact((tx) => {
            tx.insert(issues).values(rows).onConflictDoNothing().run()
          })
        }
      }
    `)
    expect(scan.writes.map((w) => [w.kind, w.method])).toEqual([['INSERT', 'bulk']])
    expect(scan.violations).toEqual([])
  })

  it('sees a raw `sql` template write next to a builder write', () => {
    const scan = scanRowCacheWriters(`
      import { issues } from '../migrations/schema'
      class IssuesRepository {
        touch(id: string): void {
          this.db.run(sql\`UPDATE issues SET updated_at = \${Date.now()} WHERE id = \${id}\`)
        }
        quoted(id: string): void {
          this.db.run(sql\`DELETE FROM "issues" WHERE id = \${id}\`)
        }
      }
    `)
    expect(scan.writes.map((w) => [w.kind, w.form, w.method])).toEqual([
      ['UPDATE', 'sql-text', 'touch'],
      ['DELETE', 'sql-text', 'quoted'],
    ])
    expect(scan.violations.map((v) => v.reason)).toEqual(['no-invalidation', 'no-invalidation'])
  })

  it('does not mistake the child tables for the issues table in builder form', () => {
    const scan = scanRowCacheWriters(`
      import { issueLabels, issueDeps, issues } from '../migrations/schema'
      class IssuesRepository {
        setIssueLabels(issueId: string, labels: string[]): void {
          this.db.delete(issueLabels).where(eq(issueLabels.issueId, issueId)).run()
          this.db.insert(issueDeps).values({ fromId: issueId }).run()
          this.db.select().from(issues).where(eq(issues.id, issueId)).all()
          this.pending.delete(issueId)
        }
      }
    `)
    expect(scan.writes).toEqual([])
    expect(scan.violations).toEqual([])
  })

  it('does not mistake the child tables for the issues table', () => {
    const scan = scanRowCacheWriters(`
      class IssuesRepository {
        setIssueLabels(issueId: string, labels: string[]): void {
          this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(issueId)
          this.db.prepare('INSERT OR IGNORE INTO issue_deps (from_id, to_id) VALUES (?, ?)').run()
          this.db.prepare('UPDATE issue_ref_letters SET next_index = ?').run(1)
          this.db.prepare('SELECT id FROM issues WHERE repo_id = ?').all(issueId)
        }
      }
    `)
    expect(scan.writes).toEqual([])
    expect(scan.violations).toEqual([])
  })
})
