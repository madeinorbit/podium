import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * EVERY WRITER INSIDE `ReposRepository` DROPS THE REGISTRY READ FIRST [POD-3247].
 *
 * The registry cache (POD-1638) used to enforce this by CONSTRUCTION: the
 * repository wrapped `db.prepare`, matched the SQL text against
 * `INSERT|UPDATE|DELETE ... repos|repo_prefixes`, and dropped the cache when such
 * a statement ran. A mutator added to the class could not forget, because it never
 * had to remember.
 *
 * That wrapper is gone, for two reasons, and this test is what replaces the half
 * of it that was worth keeping. It could only see statements prepared on ITS
 * handle — so a writer on the store's raw handle went straight past it, which is a
 * correctness bug that already happened once and which an async query layer
 * running through an executor would reproduce by default. And being a wrapper, it
 * was a second database object, which forced a second field on the class because
 * `transaction()` keys nesting depth on handle identity.
 *
 * The outside-the-class half is now the store's per-table announcement
 * (`store/table-writes.ts`), covered behaviourally in `store/repos-read-cost.test.ts`.
 * The inside-the-class half is this: a source scan, the same instrument POD-1939
 * put on the issues row cache, for the same reason a per-method behavioural test
 * cannot do it — the write path being guarded against is one that does not exist
 * yet, and a test can only assert about methods that already do.
 *
 * ORDERING IS THE RULE, NOT DECORATION, and this scan is stricter than its
 * ancestor about what "before" means. Invalidating before the write is not enough
 * on its own: if the method takes a CACHED read between the invalidation and the
 * write, the read has re-held the registry and the write leaves it stale again.
 * That is not hypothetical — `updateRepoOrigin` reads `prefixForRepoId` to decide
 * whether to re-key a prefix, and then writes `repo_prefixes`. So a write is
 * accepted only when the LATEST invalidation before it has no cached read after it.
 *
 * WHAT THE SCAN CANNOT SEE, stated rather than implied: it reads lexical order,
 * not execution order, so a branch that skips an invalidation at runtime reads as
 * invalidated here. Behavioural cover for the paths that exist is in
 * `store/repos-read-cost.test.ts`; this guards the paths nobody has written.
 *
 * SCOPE. `store/repos.ts` is the repository that owns the cache. Migration SQL
 * writes both tables too, but it runs at boot before the repository serves a read.
 *
 * TWO WRITE FORMS [POD-3395, applying POD-3362's recorded decision]. POD-3362
 * wrote the rule this scan enforces as covering a write "in SQL text or through
 * drizzle's builder", and its sibling guard on the issues row cache was widened
 * to both forms by POD-3253 before any conversion ran. This one was not, and the
 * repos conversion is what made that matter: with every statement moved onto the
 * builder, the SQL-text detector finds NOTHING, and a scan that sees nothing
 * reports no violations — a guard that passes by going blind.
 *
 * It did not pass quietly, and that is the part worth keeping. The armed-ness
 * assertion below ("sees the write statements that are actually in the file")
 * failed with `expected 2 to be greater than or equal to 10` the moment the
 * conversion landed, which is exactly what it is for. The builder arm below is
 * the answer to it: a write is now found EITHER as SQL text OR as
 * `.insert(repos)` / `.update(repoPrefixes)` / `.delete(repos)` — the table named
 * at the call rather than buried in a string. Both detectors stay, because the
 * file still holds two raw statements (`UPDATE OR IGNORE`, which drizzle's update
 * builder cannot express — POD-3406), and because the ordering rule they feed is
 * the same rule either way.
 */

const INVALIDATOR = 'invalidateRegistry'
/** The private method that FILLS `this.cached`; every cached read goes through it. */
const CACHE_READER = 'registry'

/**
 * The scanned file, named REPO-RELATIVE and resolved from the repository root on
 * purpose. `scripts/server-test-shards.ts` derives each shard's Turbo `inputs`
 * from the import closure, and this test has no import edge to the file it reads;
 * it recognises a source-reading test by a repo-root path literal next to a
 * filesystem call, and only then carries `apps/server/src/store/repos.ts` into the
 * lane's inputs. Written as `join(import.meta.dirname, 'store/...')` the literal is
 * invisible to that scan, the shard's key does not cover repos.ts, and a commit
 * that adds a forgotten write path replays as a CACHE HIT — a green from a lane
 * that never ran. Keep the literal.
 */
const SOURCE_RELATIVE = 'apps/server/src/store/repos.ts'

const SOURCE_PATH = join(fileURLToPath(new URL('../../../', import.meta.url)), SOURCE_RELATIVE)

/**
 * The three ways SQLite writes a table, tolerant of the whitespace and newlines a
 * multi-line template literal puts between the keywords, and of the `OR IGNORE` /
 * `OR REPLACE` conflict clauses. The two tables are named explicitly so that
 * `repo_draft_seq` — written by `nextDraftSeq`, held by no cache — stays out.
 */
const TABLES = '(?:repos|repo_prefixes)\\b'

/**
 * The same two tables as drizzle SCHEMA EXPORTS — what a builder write names.
 * `repoDraftSeq` is deliberately absent for the same reason `repo_draft_seq` is
 * absent from the SQL patterns: no cache holds it.
 */
const BUILDER_TABLES: ReadonlySet<string> = new Set(['repos', 'repoPrefixes'])

/**
 * drizzle's three write builders. Each takes the table object as its only
 * argument, which is what makes this scannable at all.
 */
const BUILDER_WRITES = new Map<string, 'INSERT' | 'UPDATE' | 'DELETE'>([
  ['insert', 'INSERT'],
  ['update', 'UPDATE'],
  ['delete', 'DELETE'],
])
const WRITE_PATTERNS: { kind: 'INSERT' | 'UPDATE' | 'DELETE'; pattern: RegExp }[] = [
  {
    kind: 'INSERT',
    pattern: new RegExp(`\\b(?:INSERT|REPLACE)\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${TABLES}`, 'i'),
  },
  { kind: 'UPDATE', pattern: new RegExp(`\\bUPDATE\\s+(?:OR\\s+\\w+\\s+)?${TABLES}`, 'i') },
  { kind: 'DELETE', pattern: new RegExp(`\\bDELETE\\s+FROM\\s+${TABLES}`, 'i') },
]

interface Write {
  kind: 'INSERT' | 'UPDATE' | 'DELETE'
  /** Which detector saw it: hand-written SQL text, or a drizzle write builder. */
  form: 'sql-text' | 'builder'
  line: number
  /** Enclosing class method, or null for a write not inside one at all. */
  method: string | null
  pos: number
}

interface Violation {
  reason:
    | 'no-invalidation'
    | 'invalidation-after-write'
    | 'cached-read-after-invalidation'
    | 'write-outside-method'
  method: string | null
  line: number
  kind: string
  form: Write['form']
}

/**
 * Named imports, mapped local name -> exported name, so an aliased schema import
 * cannot hide a builder write.
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

/** Does this argument name one of the two CACHED tables, under any alias? */
const namesCachedTable = (node: ts.Expression, aliases: Map<string, string>): boolean => {
  if (ts.isIdentifier(node)) return BUILDER_TABLES.has(aliases.get(node.text) ?? node.text)
  if (ts.isPropertyAccessExpression(node)) return BUILDER_TABLES.has(node.name.text)
  return false
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

/** `this.foo(...)` → `foo`, for any other call shape → undefined. */
const selfCallName = (node: ts.Node): string | undefined => {
  if (!ts.isCallExpression(node)) return undefined
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  return callee.expression.kind === ts.SyntaxKind.ThisKeyword ? callee.name.text : undefined
}

/**
 * Scan a TypeScript source for writes to the two cached tables and check each
 * one's enclosing method drops the registry read first, with no cached read taken
 * in between. Takes source TEXT rather than a path so the fixtures below can prove
 * the scanner can FAIL — a guard nobody has seen go red is not a guard.
 */
const scanRegistryWriters = (source: string, fileName = 'repos.ts'): Scan => {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1
  const aliases = importAliases(sf)

  /** Every `this.x()` call per method, in source order. */
  const callsByMethod = new Map<string, { name: string; pos: number }[]>()
  const writes: Write[] = []
  const seen = new Set<string>()

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
    const record = (kind: Write['kind'], form: Write['form'], node: ts.Node): void => {
      const line = lineOf(node.getStart())
      // A template expression and a string literal nested inside it would both
      // match; one statement is one write.
      const key = `${kind}:${line}`
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
    // A drizzle write builder: `<anything>.insert(repos)`, `.update(repoPrefixes)`,
    // `.delete(repos)`. The RECEIVER is deliberately unconstrained — the query
    // layer may be reached as `this.db`, as `tx`, or through a field a later
    // refactor introduces, and a guard that pinned the receiver's name would go
    // quiet on exactly the rename it exists to catch. What is constrained is the
    // ARGUMENT: it must resolve to one of the two cached tables.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const kind = BUILDER_WRITES.get(node.expression.name.text)
      const [arg] = node.arguments
      if (kind && node.arguments.length === 1 && arg && namesCachedTable(arg, aliases)) {
        record(kind, 'builder', node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  /** Does calling this method reach `target`, directly or through a helper? */
  const reaches = (name: string, target: string, chain: Set<string>): boolean => {
    if (name === target) return true
    if (chain.has(name)) return false
    chain.add(name)
    return (callsByMethod.get(name) ?? []).some((c) => reaches(c.name, target, chain))
  }

  /** Positions in `method` of calls that reach `target`. */
  const positionsReaching = (method: string, target: string): number[] =>
    (callsByMethod.get(method) ?? [])
      .filter((c) => reaches(c.name, target, new Set([method])))
      .map((c) => c.pos)

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
    const invalidations = positionsReaching(write.method, INVALIDATOR)
    if (invalidations.length === 0) {
      violations.push(violation(write, 'no-invalidation'))
      continue
    }
    const before = invalidations.filter((p) => p < write.pos)
    if (before.length === 0) {
      violations.push(violation(write, 'invalidation-after-write'))
      continue
    }
    // The LATEST invalidation before the write is the one that has to hold, and it
    // only holds if nothing re-filled the cache between it and the statement.
    const latest = Math.max(...before)
    const refills = positionsReaching(write.method, CACHE_READER).filter(
      (p) => p > latest && p < write.pos,
    )
    if (refills.length > 0) violations.push(violation(write, 'cached-read-after-invalidation'))
  }
  return { writes, violations }
}

const explain = (violations: Violation[]): string =>
  violations
    .map(
      (v) =>
        `${SOURCE_RELATIVE}:${v.line} — ${v.kind} on the cached tables${v.method ? ` in ${v.method}()` : ''}: ` +
        (v.reason === 'no-invalidation'
          ? `the method never calls this.${INVALIDATOR}()`
          : v.reason === 'invalidation-after-write'
            ? `this.${INVALIDATOR}() is called AFTER the write`
            : v.reason === 'cached-read-after-invalidation'
              ? `a cached read is taken between this.${INVALIDATOR}() and the write, so the write leaves the re-held read stale`
              : 'the write is not inside a class method, so the rule cannot be checked'),
    )
    .join('\n')

describe('repos registry cache: every writer invalidates', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8')

  it('every statement writing repos or repo_prefixes drops the registry read first', () => {
    const { violations } = scanRegistryWriters(source)
    expect(explain(violations)).toBe('')
  })

  // ---- the scanner is armed ----
  //
  // The assertion above is a pass over an empty list, so on its own it cannot tell
  // "no violations" from "sees nothing". These pin the other end.

  it('sees the write statements that are actually in the file', () => {
    const { writes } = scanRegistryWriters(source)
    // Not a pinned list of method names: a rename must not be able to make the scan
    // go quiet, which is the failure mode this class of guard exists for.
    expect(writes.length).toBeGreaterThanOrEqual(10)
    expect(new Set(writes.map((w) => w.kind))).toEqual(new Set(['INSERT', 'UPDATE', 'DELETE']))
    expect(writes.filter((w) => w.method === null)).toEqual([])
  })

  it('fails a new write path whose method does not invalidate', () => {
    const { violations } = scanRegistryWriters(`
      class ReposRepository {
        forgetRepo(path: string): void {
          this.db.prepare('DELETE FROM repos WHERE path = ?').run(path)
        }
      }
    `)
    expect(violations.map((v) => [v.method, v.reason])).toEqual([['forgetRepo', 'no-invalidation']])
  })

  it('fails a method that invalidates only after the write', () => {
    const { violations } = scanRegistryWriters(`
      class ReposRepository {
        forgetRepo(path: string): void {
          this.db.prepare('DELETE FROM repos WHERE path = ?').run(path)
          this.invalidateRegistry()
        }
      }
    `)
    expect(violations.map((v) => [v.method, v.reason])).toEqual([
      ['forgetRepo', 'invalidation-after-write'],
    ])
  })

  it('fails a cached read taken between the invalidation and the write', () => {
    // The bug this scan was widened for, in its smallest form: the drop is spent by
    // the read, and the write goes on to leave that read stale. `updateRepoOrigin`
    // had exactly this shape before POD-3247.
    const { violations } = scanRegistryWriters(`
      class ReposRepository {
        private registry(): Held { return this.cached ?? this.load() }
        prefixForRepoId(id: string): string | null { return this.registry().prefixes.get(id) }
        rekey(oldId: string, newId: string): void {
          this.invalidateRegistry()
          if (this.prefixForRepoId(newId) === null) {
            this.db.prepare('UPDATE repo_prefixes SET repo_id = ? WHERE repo_id = ?').run(newId, oldId)
          }
        }
      }
    `)
    expect(violations.map((v) => [v.method, v.reason])).toEqual([
      ['rekey', 'cached-read-after-invalidation'],
    ])
  })

  it('accepts the same method once the drop moves below the read', () => {
    const { violations } = scanRegistryWriters(`
      class ReposRepository {
        private registry(): Held { return this.cached ?? this.load() }
        prefixForRepoId(id: string): string | null { return this.registry().prefixes.get(id) }
        rekey(oldId: string, newId: string): void {
          if (this.prefixForRepoId(newId) === null) {
            this.invalidateRegistry()
            this.db.prepare('UPDATE repo_prefixes SET repo_id = ? WHERE repo_id = ?').run(newId, oldId)
          }
        }
      }
    `)
    expect(violations).toEqual([])
  })

  it('fails a write that is not inside a method at all', () => {
    const { violations } = scanRegistryWriters(`
      function heal(db: SqlDatabase): void {
        db.prepare("UPDATE repos SET machine_id = ?").run('m')
      }
    `)
    expect(violations.map((v) => v.reason)).toEqual(['write-outside-method'])
  })

  it('accepts a write invalidated through a helper called first', () => {
    const scan = scanRegistryWriters(`
      class ReposRepository {
        private beginWrite(): void {
          this.invalidateRegistry()
        }
        forgetRepo(path: string): void {
          this.beginWrite()
          this.db.prepare('DELETE FROM repos WHERE path = ?').run(path)
        }
      }
    `)
    expect(scan.writes.length).toBe(1)
    expect(scan.violations).toEqual([])
  })

  it('sees a write inside a transaction callback, and the multi-line SQL forms', () => {
    const scan = scanRegistryWriters(`
      class ReposRepository {
        bulk(rows: Row[]): void {
          this.invalidateRegistry()
          transaction(this.db, () => {
            this.db
              .prepare(\`INSERT OR IGNORE
                          INTO repo_prefixes
                            (repo_id, prefix)
                          VALUES (?, ?)\`)
              .run(rows[0].id, rows[0].prefix)
          })
        }
      }
    `)
    expect(scan.writes.map((w) => [w.kind, w.method])).toEqual([['INSERT', 'bulk']])
    expect(scan.violations).toEqual([])
  })

  // ---- the builder arm, which the repository now writes through (POD-3395) ----
  //
  // Same principle as the SQL-text fixtures above: a detector nobody has watched
  // go red is not a detector. These drive the builder form through every branch
  // of the ordering rule.

  it('fails a builder write path whose method does not invalidate', () => {
    const { writes, violations } = scanRegistryWriters(`
      import { repos } from '../migrations/schema'
      class ReposRepository {
        forgetRepo(machineId: string, path: string): void {
          this.db.delete(repos).where(eq(repos.path, path)).run()
        }
      }
    `)
    expect(writes.map((w) => [w.kind, w.form])).toEqual([['DELETE', 'builder']])
    expect(violations.map((v) => [v.method, v.reason])).toEqual([['forgetRepo', 'no-invalidation']])
  })

  it('fails a builder write that invalidates only afterwards', () => {
    const { violations } = scanRegistryWriters(`
      import { repoPrefixes } from '../migrations/schema'
      class ReposRepository {
        rekey(id: string): void {
          this.db.update(repoPrefixes).set({ repoId: id }).run()
          this.invalidateRegistry()
        }
      }
    `)
    expect(violations.map((v) => [v.method, v.reason, v.form])).toEqual([
      ['rekey', 'invalidation-after-write', 'builder'],
    ])
  })

  it('fails a cached read taken between the invalidation and a builder write', () => {
    // The `updateRepoOrigin` shape POD-3247 widened this scan for, in builder form.
    const { violations } = scanRegistryWriters(`
      import { repoPrefixes } from '../migrations/schema'
      class ReposRepository {
        private registry(): Held { return this.cached ?? this.load() }
        prefixForRepoId(id: string): string | null { return this.registry().prefixes.get(id) }
        rekey(oldId: string, newId: string): void {
          this.invalidateRegistry()
          if (this.prefixForRepoId(newId) === null) {
            this.db.update(repoPrefixes).set({ repoId: newId }).where(eq(repoPrefixes.repoId, oldId)).run()
          }
        }
      }
    `)
    expect(violations.map((v) => [v.method, v.reason])).toEqual([
      ['rekey', 'cached-read-after-invalidation'],
    ])
  })

  it('sees a builder write through an aliased schema import', () => {
    // The rename this arm exists to survive: a guard keyed on the local name
    // would go quiet here, which is the failure mode, not the safe direction.
    const { writes } = scanRegistryWriters(`
      import { repos as repoRows } from '../migrations/schema'
      class ReposRepository {
        add(row: Row): void {
          this.invalidateRegistry()
          this.db.insert(repoRows).values(row).onConflictDoNothing().run()
        }
      }
    `)
    expect(writes.map((w) => [w.kind, w.form, w.method])).toEqual([['INSERT', 'builder', 'add']])
  })

  it('sees a raw statement and a builder write side by side', () => {
    // repos.ts holds both today: the two UPDATE OR IGNORE statements drizzle's
    // update builder cannot express (POD-3406) next to converted builder writes.
    const scan = scanRegistryWriters(`
      import { repos } from '../migrations/schema'
      class ReposRepository {
        rename(machineId: string, from: string, to: string): void {
          this.invalidateRegistry()
          this.db.run(sql\`UPDATE OR IGNORE repos SET path = \${to} WHERE path = \${from}\`)
          this.db.delete(repos).where(eq(repos.path, from)).run()
        }
      }
    `)
    expect(scan.writes.map((w) => [w.kind, w.form])).toEqual([
      ['UPDATE', 'sql-text'],
      ['DELETE', 'builder'],
    ])
    expect(scan.violations).toEqual([])
  })

  it('does not mistake the uncached sibling table in builder form', () => {
    const scan = scanRegistryWriters(`
      import { repoDraftSeq, repos } from '../migrations/schema'
      class ReposRepository {
        nextDraftSeq(repoId: string): void {
          this.db.insert(repoDraftSeq).values({ repoId, nextSeq: 1 }).run()
          this.db.select().from(repos).where(eq(repos.repoId, repoId)).all()
        }
      }
    `)
    // A read of `repos` and a write of the UNCACHED sibling: neither is a write
    // to a cached table, so a scan that flagged either would be crying wolf on
    // the method the SQL-text arm already exempts by name.
    expect(scan.writes).toEqual([])
    expect(scan.violations).toEqual([])
  })

  it('does not mistake the uncached sibling tables for the cached two', () => {
    const scan = scanRegistryWriters(`
      class ReposRepository {
        nextDraftSeq(repoId: string): void {
          this.db.prepare('INSERT INTO repo_draft_seq (repo_id, next_seq) VALUES (?, ?)').run(repoId, 1)
          this.db.prepare('UPDATE repo_draft_seq SET next_seq = ?').run(2)
          this.db.prepare('DELETE FROM repository_mirrors WHERE repo_id = ?').run(repoId)
          this.db.prepare('SELECT path FROM repos WHERE repo_id = ?').all(repoId)
        }
      }
    `)
    expect(scan.writes).toEqual([])
    expect(scan.violations).toEqual([])
  })
})
