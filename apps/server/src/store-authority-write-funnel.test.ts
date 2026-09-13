import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
 * site), and a statement assembled by a helper in another file.
 *
 * THE ALIAS HANDLING IS SYNTACTIC IMPORT-NAME MAPPING, NOT SYMBOL RESOLUTION,
 * and the distinction is the reviewer's. It reads this file's named imports and
 * maps local name -> imported name, so `import { users as usersTable }` is
 * recognised. It does NOT resolve symbols: a namespace import used as
 * `schema.users` is matched on the property name alone, and a table reached
 * through a re-export, a local rebinding or a value passed in as a parameter is
 * not tracked at all.
 */

/**
 * The scanned files, named REPO-RELATIVE and resolved from the repository root.
 *
 * WHY THIS FILE IS SEPARATE: `scripts/server-test-shards.ts` recognises a
 * source-reading test by a repo-root path literal next to a filesystem call
 * (`scansRepositorySource`) and PINS IT to the broad `boundary` shard.
 * Recognition is per FILE, so leaving this scanner inside
 * `modules/machines/service.test.ts` would have re-pinned sixty behavioural
 * tests out of `services` along with it. That is the whole reason for the split.
 *
 * A CORRECTION, KEPT HERE BECAUSE THE CLAIM WAS PUBLISHED AND WAS WRONG. An
 * earlier revision of this header said the previous relative-URL spelling left
 * these three repositories out of the lane's cache key, so a commit adding a raw
 * write would replay as a CACHE HIT. THAT IS FALSE, and the phase B reviewer
 * caught it. `apps/server/turbo.json` was parsed at four pins — the epic tip
 * before this instrument existed, and all three of its revisions — and
 * `src/store/{users,machines,grants}.ts` are explicit inputs to BOTH
 * `test:services` and `test:boundary` at every one of them. They arrive through
 * the IMPORT CLOSURE, which reaches the store from the server code these lanes
 * already import; the path literals never carried them. The regeneration's only
 * turbo diff is this test file's own entry.
 *
 * The mistake was checking the inputs AFTER regenerating, seeing the three files
 * present, and crediting the change — a post-hoc attribution with no control,
 * where one `git show <old-sha>:apps/server/turbo.json` would have falsified it.
 * Whether a missed source-reading classification matters for other walked files
 * is a separate question and is NOT asserted here.
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

/**
 * The `set:` initializer of an `onConflictDoUpdate({ … })` argument — after
 * adjudicating the WHOLE options object, not just the first `set` it meets.
 *
 * `{ set: { avatar }, ...patch }` is the shape that beat the previous version:
 * it returned the literal `{ avatar }`, which classifies IRRELEVANT, while the
 * spread can replace `set` entirely with an authority-changing payload. A
 * computed key can do the same, and a duplicate `set` later in the literal
 * simply wins at runtime. None of those may be read as "the payload is
 * `{ avatar }`".
 *
 * `undefined` means UNRESOLVED — the caller reports it rather than skipping it.
 */
const conflictSetPayload = (call: ts.CallExpression): ts.Expression | undefined => {
  const argument = call.arguments[0]
  if (!argument || !ts.isObjectLiteralExpression(argument)) return undefined
  let resolved: ts.Expression | undefined
  for (const property of argument.properties) {
    // Anything that can introduce or replace `set` without naming it here.
    if (ts.isSpreadAssignment(property)) return undefined
    if (property.name && ts.isComputedPropertyName(property.name)) return undefined
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      return undefined
    }
    if (property.name && ts.isIdentifier(property.name) && property.name.text === 'set') {
      // A later duplicate wins at runtime, so keep overwriting rather than
      // returning the first.
      resolved = ts.isPropertyAssignment(property) ? property.initializer : undefined
      if (resolved === undefined) return undefined
    }
  }
  return resolved
}

/**
 * Does this source write `table` through a drizzle builder AT ALL — funnelled or
 * not, authority-relevant or not?
 *
 * A DIFFERENT QUESTION from {@link authorityWritesOutsideTheFunnel}, and keeping
 * them apart is the reviewer's correction: the population claim ("these three
 * files are the only writers") cannot be answered by a function that filters to
 * raw authority writes, because every funnelled or irrelevant write elsewhere
 * would vanish and the assertion would pass for the wrong reason.
 */
const anyBuilderWrite = (source: string, table: string, fileName: string): boolean => {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const aliases = importAliases(sf)
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    ts.forEachChild(node, visit)
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee) || !BUILDER_WRITES.has(callee.name.text)) return
    const first = node.arguments[0]
    if (first && namesTable(first, table, aliases)) found = true
  }
  visit(sf)
  return found
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

  it('maps an import alias syntactically (NOT symbol resolution — see the header)', () => {
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

  it('adjudicates the WHOLE onConflictDoUpdate options object, not its first set', () => {
    // WHICH SHAPES THIS REPAIR ACTUALLY FIXES, MEASURED AGAINST THE PIN rather
    // than assumed. PDM-409-B bounded this and was right; I then ran the pin's
    // own scanner (extracted from `git show 3f62981c3:…`) over each fixture, and
    // the rule is sharper than "outer options were unhandled":
    //
    //   THE PIN ONLY WENT WRONG WHEN IT FOUND A LITERAL `set` AND RETURNED IT,
    //   ignoring the rest of the object. With no `set` to find it already
    //   answered `unresolved`.
    //
    // So a spread or a computed key ALONGSIDE a benign `set` was missed (0
    // findings), while the same shapes with NO `set`, and a non-literal options
    // object, were ALREADY CORRECT. The second group are CONTROLS here, not
    // repairs, and counting them as repairs would inflate this fix exactly the
    // way B declined to inflate its own discrimination count.

    // --- MISSED AT THE PIN (0 findings there). These are the repair. ---
    const spreadBesideSet = scan(
      '    await this.db.insert(users).values(v).onConflictDoUpdate({ set: { avatar }, ...patch }).run()',
    )
    expect.soft(spreadBesideSet).toHaveLength(1)
    expect.soft(spreadBesideSet[0]?.verdict).toBe('unresolved')

    const computedBesideSet = scan(
      '    await this.db.insert(users).values(v).onConflictDoUpdate({ set: { avatar }, [key]: x }).run()',
    )
    expect.soft(computedBesideSet).toHaveLength(1)
    expect.soft(computedBesideSet[0]?.verdict).toBe('unresolved')

    // A duplicate `set` wins at runtime, so the LAST one is what must be read.
    expect
      .soft(
        scan(
          '    await this.db.insert(users).values(v).onConflictDoUpdate({ set: { avatar }, set: { disabledAt } }).run()',
        ),
      )
      .toHaveLength(1)

    // --- ALREADY CORRECT AT THE PIN. Controls: they must STAY caught, and they
    //     are not evidence for this repair. ---
    for (const alreadyCorrect of [
      '    await this.db.insert(users).values(v).onConflictDoUpdate(options).run()',
      '    await this.db.insert(users).values(v).onConflictDoUpdate({ [key]: { disabledAt } }).run()',
      '    await this.db.insert(users).values(v).onConflictDoUpdate({ ...patch }).run()',
    ]) {
      const found = scan(alreadyCorrect)
      expect.soft(found, alreadyCorrect).toHaveLength(1)
      expect.soft(found[0]?.verdict, alreadyCorrect).toBe('unresolved')
    }

    // --- CLEAN CONTROLS, so the new conservatism has not collapsed the verdicts. ---
    expect
      .soft(
        scan(
          '    await this.db.insert(users).values(v).onConflictDoUpdate({ target: users.id, set: { avatar } }).run()',
        ),
      )
      .toHaveLength(0)
    const readableAuthority = scan(
      '    await this.db.insert(users).values(v).onConflictDoUpdate({ target: users.id, set: { disabledAt } }).run()',
    )
    expect.soft(readableAuthority).toHaveLength(1)
    expect.soft(readableAuthority[0]?.verdict).toBe('raw')
    expect
      .soft(
        scan(
          "    await this.committed.write(async () => this.db.insert(users).values(v).onConflictDoUpdate({ set: { avatar }, ...patch }).returning().all(), 'upsert')",
        ),
      )
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

/**
 * Every file under `roots` that a `visit` callback marks, walked once.
 *
 * ONLY AN ABSENT ROOT MAY CONTRIBUTE NOTHING. The previous version wrapped the
 * WHOLE walk in a `catch {}` "for a tree absent from this checkout", which also
 * swallowed every read, stat and parse failure inside trees that DO exist — so a
 * permission error or an unreadable file would have quietly shrunk the
 * population and left the assertion green. Absence is checked explicitly, up
 * front; everything else propagates.
 */
const walkRepositorySources = (
  roots: readonly string[],
  visit: (relativePath: string, source: string) => void,
): void => {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue
      visit(full.slice(REPOSITORY_ROOT.length).replace(/^\/+/, ''), readFileSync(full, 'utf8'))
    }
  }
  for (const root of roots) {
    const path = join(REPOSITORY_ROOT, root)
    if (!existsSync(path)) continue
    walk(path)
  }
}

/** Every file containing ANY drizzle builder write to one of the three tables,
 *  funnelled or not, authority-relevant or not. */
const builderWriteFiles = (): string[] => {
  const files = new Set<string>()
  walkRepositorySources(SEARCH_ROOTS, (relativePath, source) => {
    for (const { table } of REPOSITORIES) {
      if (anyBuilderWrite(source, table, relativePath)) files.add(relativePath)
    }
  })
  return [...files].sort()
}

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

  it('are the only files in the repository that write those tables at all', () => {
    // THE POPULATION PROPERTY, STATED AS WHAT IT ACTUALLY IS. The previous
    // version called itself this and asked a DIFFERENT question: it ran
    // `authorityWritesOutsideTheFunnel` over the tree and asserted the result was
    // empty. That finds only RAW or UNRESOLVED authority writes, so a funnelled
    // write in a fourth file -- or an authority-IRRELEVANT one -- vanished, and
    // the test could not have established the claim its name made. It needs an
    // enumeration that ignores both the funnel and the column list, which is
    // what `anyBuilderWrite` is.
    expect(builderWriteFiles()).toEqual(REPOSITORIES.map(({ path }) => path).sort())
  })

  it('and nothing anywhere in the repository writes them raw or unreadably', () => {
    // The repo-wide version of the first test, named for what it checks rather
    // than for the population claim it cannot make.
    const findings: Finding[] = []
    walkRepositorySources(SEARCH_ROOTS, (relativePath, source) => {
      for (const { table, columns } of REPOSITORIES) {
        findings.push(...authorityWritesOutsideTheFunnel(source, table, columns, relativePath))
      }
    })
    expect(findings).toEqual([])
  })

  it('the walk skips an ABSENT root and FAILS on an unexpected traversal error', () => {
    // THE NEGATIVE CONTROL for the swallowed-error defect. An absent root is the
    // only tolerated case; anything else must be visible. A path that exists but
    // is a FILE makes readdirSync throw, which is the cheapest stand-in for the
    // permission and I/O failures the old `catch {}` hid.
    let visited = 0
    expect(() =>
      walkRepositorySources(['no-such-tree-at-all'], () => {
        visited += 1
      }),
    ).not.toThrow()
    expect(visited).toBe(0)

    expect(() => walkRepositorySources([REPOSITORIES[0]?.path ?? ''], () => {})).toThrow()
  })
})
