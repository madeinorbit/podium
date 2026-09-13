import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * EVERY AUTHORITY-CHANGING WRITE GOES THROUGH THE COMMIT FUNNEL (PDM-411).
 *
 * `MachinesService`'s authority epoch is bumped from `CommittedRows` subscribers.
 * A write that reaches `users`, `machines` or `grants` WITHOUT going through
 * `committed.write(...)` publishes nothing, so no subscriber hears it and the
 * epoch never moves. That is not hypothetical: `UsersRepository.removeMember`
 * disabled accounts with a raw `db.update` and was invisible to the epoch and to
 * WorldIndex alike (PDM-409).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN AST SCAN AND NOT A TEXT SCAN — THE THIRD ATTEMPT
 * ---------------------------------------------------------------------------
 *
 * Recorded because each earlier version looked adequate and the phase B reviewer
 * falsified it by naming a shape, and the shapes are the reason for the design:
 *
 *  1. TEXT PROXIMITY. v1 decided "funnelled" by searching six lines above for
 *     the string `committed.write`. A COMMENT naming the funnel satisfied it,
 *     and so did an unrelated, already-closed funnelled call.
 *  2. BRACKET COUNTING OVER RAW LINES. v2 counted brackets, which is better and
 *     still wrong in three ways the reviewer named: a comment or string
 *     containing an UNCLOSED `committed.write(` opens a span that never closes;
 *     funnelled status was recorded per LINE, so a closed funnel call followed
 *     by a raw write ON THE SAME LINE marked the raw write funnelled; and the
 *     statement extent was `lines.slice(i, i + 14)`, so a conflict clause beyond
 *     that window was read as a plain insert and skipped.
 *
 * A real parser has no such failure modes: a comment and a string produce no
 * syntax, containment is by node ancestry rather than by line, and a fluent
 * chain's extent is the chain, however long.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES TO GUESS
 * ---------------------------------------------------------------------------
 *
 * An instrument that cannot read a shape must SAY SO. Every unresolved shape is
 * reported exactly like a raw write, because "I could not classify this" and "I
 * classified this as harmless" must never be the same outcome — that equivalence
 * is what let `{ ...patch }` and `{ [column]: value }` read as naming no
 * authority field at all.
 *
 * STILL OUTSIDE IT, and named rather than implied: hand-written SQL text (this
 * scans drizzle builder calls only, where the table is an argument at the call
 * site), and a statement assembled by a helper in another file. The alias case is
 * NOT outside it — a reference is judged by what it RESOLVES to, so
 * `import { users as usersTable }` is still the table.
 */

/**
 * The scanned files, named REPO-RELATIVE and resolved from the repository root
 * on purpose, and this test lives in its OWN file for the same reason.
 *
 * `scripts/server-test-shards.ts` derives each shard's Turbo `inputs` from the
 * import closure, and this test has no import edge to the files it reads. It
 * recognises a source-reading test by a repo-root path literal NEXT TO a
 * filesystem call (`scansRepositorySource`), and only then pins the file to the
 * broad `boundary` shard whose inputs span the trees it can see. Written as
 * `new URL('../store/users.ts', import.meta.url)` the literal is invisible to
 * that scan, the shard key does not cover the repositories, and a commit adding
 * a raw write replays as a CACHE HIT — a green from a lane that never ran. An
 * earlier revision of this instrument lived inside
 * `modules/machines/service.test.ts` and had exactly that defect. Keep the
 * literals, and keep this file separate so pinning it to `boundary` does not
 * drag a services-shard file along with it.
 */
const REPOSITORIES: { path: string; table: string; columns: readonly string[] }[] = [
  // `disabledAt` and `role` are the only authority-relevant columns on `users`
  // that can move after creation; this build has no role-mutation method at all.
  { path: 'apps/server/src/store/users.ts', table: 'users', columns: ['disabledAt', 'role'] },
  { path: 'apps/server/src/store/machines.ts', table: 'machines', columns: ['ownerUserId'] },
  // No authority-irrelevant column exists on a grant edge itself, so every shape
  // but a plain insert counts.
  { path: 'apps/server/src/store/grants.ts', table: 'grants', columns: [] },
]

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** Trees searched for a writer outside the three repositories. */
const SEARCH_ROOTS = ['apps', 'packages', 'services', 'scripts']

type Verdict = 'raw' | 'unresolved'
interface Finding {
  where: string
  verdict: Verdict
  why: string
}

const BUILDER_WRITES = new Set(['insert', 'update', 'delete'])

/** Local name → exported name, so a reference is judged by what it resolves to. */
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

const namesTable = (node: ts.Expression, table: string, aliases: Map<string, string>): boolean => {
  if (ts.isIdentifier(node)) return (aliases.get(node.text) ?? node.text) === table
  if (ts.isPropertyAccessExpression(node)) return node.name.text === table
  return false
}

/**
 * Is this node lexically inside a `…committed.write(…)` CALL?
 *
 * Ancestry, not proximity and not line numbers. A comment produces no ancestor
 * and a sibling call on the same line is not an ancestor either.
 */
const insideCommitFunnel = (node: ts.Node): boolean => {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!ts.isCallExpression(n)) continue
    const callee = n.expression
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'write') continue
    const target = callee.expression
    const targetName = ts.isPropertyAccessExpression(target)
      ? target.name.text
      : ts.isIdentifier(target)
        ? target.text
        : undefined
    if (targetName === 'committed') return true
  }
  return false
}

/** The outermost node of the fluent chain this write call belongs to. */
const chainRoot = (write: ts.CallExpression): ts.Node => {
  let node: ts.Node = write
  for (;;) {
    const parent = node.parent
    if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      node = parent
      continue
    }
    if (parent && ts.isCallExpression(parent) && parent.expression === node) {
      node = parent
      continue
    }
    return node
  }
}

/** Every `.name(...)` call in the chain, by method name. */
const chainCalls = (root: ts.Node): Map<string, ts.CallExpression> => {
  const calls = new Map<string, ts.CallExpression>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text
      if (!calls.has(name)) calls.set(name, node)
    }
    if (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) {
      ts.forEachChild(node, visit)
    }
  }
  visit(root)
  return calls
}

type Payload = 'relevant' | 'irrelevant' | 'unresolved'

/**
 * Does this assignment payload touch an authority column?
 *
 * A SPREAD or a COMPUTED KEY can carry the field without naming it, so neither
 * may be read as "the field is absent". A getter, setter or method in the
 * literal is equally unreadable. Each answers `unresolved`, which is reported.
 */
const classifyPayload = (node: ts.Expression | undefined, columns: readonly string[]): Payload => {
  if (node === undefined) return 'unresolved'
  if (!ts.isObjectLiteralExpression(node)) return 'unresolved'
  const names: string[] = []
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) return 'unresolved'
    if (property.name && ts.isComputedPropertyName(property.name)) return 'unresolved'
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      if (property.name && ts.isIdentifier(property.name)) names.push(property.name.text)
      else if (property.name && ts.isStringLiteral(property.name)) names.push(property.name.text)
      else return 'unresolved'
      continue
    }
    return 'unresolved'
  }
  return names.some((name) => columns.includes(name)) ? 'relevant' : 'irrelevant'
}

/** The `set:` initializer of an `onConflictDoUpdate({ … })` argument. */
const conflictSetPayload = (call: ts.CallExpression): ts.Expression | undefined => {
  const argument = call.arguments[0]
  if (!argument || !ts.isObjectLiteralExpression(argument)) return undefined
  for (const property of argument.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'set'
    ) {
      return property.initializer
    }
  }
  return undefined
}

/**
 * Raw or unresolved authority writes to `table`. Takes source TEXT rather than a
 * path so the probes below can prove the scanner can FAIL — a guard nobody has
 * watched go red is not a guard.
 */
const authorityWritesOutsideTheFunnel = (
  source: string,
  table: string,
  columns: readonly string[],
  fileName = 'fixture.ts',
): Finding[] => {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const aliases = importAliases(sf)
  const findings: Finding[] = []

  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit)
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee)) return
    const verb = callee.name.text
    if (!BUILDER_WRITES.has(verb)) return
    const first = node.arguments[0]
    if (!first || !namesTable(first, table, aliases)) return

    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    const where = `${fileName}:${line}: .${verb}(${table})`
    const root = chainRoot(node)
    const calls = chainCalls(root)

    const report = (verdict: Verdict, why: string): void => {
      if (insideCommitFunnel(node)) return
      findings.push({ where, verdict, why })
    }

    if (verb === 'delete') {
      report('raw', 'a delete always removes authority')
      return
    }

    if (verb === 'insert') {
      const conflict = calls.get('onConflictDoUpdate')
      if (!conflict) {
        // A PLAIN insert cannot take authority away: a row that did not exist
        // held nothing. But if the builder ESCAPES into a binding, a conflict
        // clause can be attached elsewhere and this scan cannot see it.
        if (root.parent && ts.isVariableDeclaration(root.parent)) {
          report('unresolved', 'insert builder bound to a variable; a conflict clause may be added')
        }
        return
      }
      if (columns.length === 0) {
        report('raw', 'any grant row change alters who may use something')
        return
      }
      const payload = classifyPayload(conflictSetPayload(conflict), columns)
      if (payload === 'relevant') report('raw', 'conflict update assigns an authority column')
      else if (payload === 'unresolved')
        report('unresolved', 'conflict update payload is unreadable')
      return
    }

    // verb === 'update'
    if (columns.length === 0) {
      report('raw', 'any grant row change alters who may use something')
      return
    }
    const setCall = calls.get('set')
    const payload = classifyPayload(setCall?.arguments[0], columns)
    if (payload === 'relevant') report('raw', 'assigns an authority column')
    else if (payload === 'unresolved') report('unresolved', 'assignment payload is unreadable')
  }

  visit(sf)
  return findings
}

const USER_COLUMNS = ['disabledAt', 'role'] as const
const scan = (src: string, table = 'users', columns: readonly string[] = USER_COLUMNS) =>
  authorityWritesOutsideTheFunnel(src, table, columns)

describe('the authority-write funnel scanner', () => {
  it('is not fooled by a comment or a string that merely CONTAINS the funnel call', () => {
    // THE SHAPE THAT BEAT THE BRACKET COUNTER, and the one the earlier
    // "comment" probe failed to discriminate because its comment was BALANCED.
    // An UNCLOSED `committed.write(` inside a comment opened a span that never
    // closed, so every later write in the file read as nested.
    expect
      .soft(
        scan(
          [
            '    // we used to call this.committed.write( here and never closed the paren',
            '    await this.db.update(users).set({ disabledAt }).where(x).run()',
          ].join('\n'),
        ),
      )
      .toHaveLength(1)
    expect
      .soft(
        scan(
          [
            "    const note = 'this.committed.write('",
            '    await this.db.update(users).set({ disabledAt }).where(x).run()',
          ].join('\n'),
        ),
      )
      .toHaveLength(1)
    // CLEAN CONTROL: a GENUINE multi-line funnel, which must stay silent.
    expect
      .soft(
        scan(
          [
            '    await this.committed.write(',
            '      async () =>',
            '        this.db.update(users).set({ disabledAt }).where(x).returning().all(),',
            "      'upsert',",
            '    )',
          ].join('\n'),
        ),
      )
      .toHaveLength(0)
  })

  it('does not let a CLOSED funnel call shield a raw write on the SAME LINE', () => {
    // Funnelled status used to be recorded per LINE. Containment is per NODE.
    expect
      .soft(
        scan(
          "    await this.committed.write(async () => this.db.update(users).set({ role }).returning().all(), 'upsert'); await this.db.update(users).set({ disabledAt }).run()",
        ),
      )
      .toHaveLength(1)
    // CLEAN CONTROL: the same single line, both writes genuinely inside funnels.
    expect
      .soft(
        scan(
          "    await this.committed.write(async () => this.db.update(users).set({ role }).returning().all(), 'upsert'); await this.committed.write(async () => this.db.update(users).set({ disabledAt }).returning().all(), 'upsert')",
        ),
      )
      .toHaveLength(0)
  })

  it('reads a conflict clause however far it sits from the insert', () => {
    // The twelve/fourteen-line statement window classified a distant conflict
    // clause as a plain insert and skipped it. A chain has no window.
    const padding = Array.from({ length: 30 }, (_, i) => `      // filler ${i}`).join('\n')
    expect
      .soft(
        scan(
          [
            '    await this.db',
            '      .insert(users)',
            '      .values(v)',
            padding,
            '      .onConflictDoUpdate({ target: users.id, set: { disabledAt } })',
            '      .run()',
          ].join('\n'),
        ),
      )
      .toHaveLength(1)
    // CLEAN CONTROL: a PLAIN insert spread over the same distance stays silent.
    expect
      .soft(
        scan(
          [
            '    await this.db',
            '      .insert(users)',
            '      .values(v)',
            padding,
            '      .run()',
          ].join('\n'),
        ),
      )
      .toHaveLength(0)
  })

  it('REPORTS a payload it cannot read rather than calling it irrelevant', () => {
    // A spread or a computed key can carry `disabledAt` without naming it.
    for (const payload of ['{ ...patch }', '{ [column]: value }', 'patch']) {
      const found = scan(`    await this.db.update(users).set(${payload}).where(x).run()`)
      expect.soft(found, payload).toHaveLength(1)
      expect.soft(found[0]?.verdict, payload).toBe('unresolved')
    }
    // CLEAN CONTROL: a readable payload naming no authority column stays silent.
    expect
      .soft(scan('    await this.db.update(users).set({ avatar }).where(x).run()'))
      .toHaveLength(0)
    // ...and one that names the column in the PREDICATE only is not an assignment.
    expect
      .soft(
        scan(
          '    await this.db.update(users).set({ cloudAccountId }).where(isNull(users.disabledAt)).run()',
        ),
      )
      .toHaveLength(0)
  })

  it('judges the table by what the reference RESOLVES to, not by its spelling', () => {
    expect
      .soft(
        scan(
          [
            "import { users as usersTable } from './schema'",
            '    await this.db.update(usersTable).set({ disabledAt }).where(x).run()',
          ].join('\n'),
        ),
      )
      .toHaveLength(1)
    // CLEAN CONTROL: a different table that merely looks similar is not it.
    expect
      .soft(scan('    await this.db.update(userCredentials).set({ disabledAt }).run()'))
      .toHaveLength(0)
  })

  it('still catches the raw removeMember shape that started this', () => {
    expect
      .soft(
        scan(
          '    await this.db.update(users).set({ disabledAt: now }).where(eq(users.id, id)).run()',
        ),
      )
      .toHaveLength(1)
    expect
      .soft(scan('    await this.db.delete(grants).where(match).run()', 'grants', []))
      .toHaveLength(1)
    expect
      .soft(scan("    await this.db.insert(users).values({ role: 'admin' }).run()"))
      .toHaveLength(0)
  })
})

describe('the three authority repositories', () => {
  it('contain no raw or unresolved authority write', () => {
    const findings = REPOSITORIES.flatMap(({ path, table, columns }) =>
      authorityWritesOutsideTheFunnel(
        readFileSync(join(REPOSITORY_ROOT, path), 'utf8'),
        table,
        columns,
        path,
      ),
    )
    expect(findings).toEqual([])
  })

  it('are the only builder writers of those tables in the repository', () => {
    // THE POPULATION, DERIVED RATHER THAN ASSERTED. It was a grep in a receipt
    // until the reviewer pointed out the test did not establish it.
    //
    // This file is pinned to the `boundary` shard precisely because it reads
    // trees no import closure can see; that is what keeps this check's inputs in
    // the lane's cache key instead of letting it replay green.
    const writers = new Set<string>()
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue
        const relative = full.slice(REPOSITORY_ROOT.length).replace(/^\/+/, '')
        for (const { table, columns } of REPOSITORIES) {
          if (
            authorityWritesOutsideTheFunnel(readFileSync(full, 'utf8'), table, columns, relative)
              .length > 0
          ) {
            writers.add(relative)
          }
        }
      }
    }
    for (const root of SEARCH_ROOTS) {
      try {
        walk(join(REPOSITORY_ROOT, root))
      } catch {
        // A tree absent from this checkout contributes nothing.
      }
    }
    expect([...writers].sort()).toEqual([])
  })
})
