/**
 * Which Postgres-leg files open a full store without choosing what to run per engine
 * [POD-7098].
 *
 * Until a Postgres store can boot (the store-lifecycle port, POD-6994), a full store opened
 * on the leg fails with `PostgresStoreBootError`, so a leg file that opens one belongs on
 * `pending` in `apps/server/test-store-engines.json`. The lists' own check cannot see that: it
 * reads the lists, not the files, and a new store test runs on both engines by default. Seven
 * files reached the leg that way before this check (POD-7098).
 *
 * A file is reported when it calls a store opener and never reads the engine. The openers
 * are the store opens themselves ({@link STORE_OPENS}) and every exported test helper whose
 * body calls one, found by reading the test support source (`openWorkspaceStores`,
 * `makeOracle`, …). A file that reads the engine (`testStoreEngine()` or
 * `PODIUM_TEST_STORE_ENGINE`) is trusted to keep its full-store opens off Postgres, as
 * `users-earliest-admin.test.ts` skips them there and `capture-pg.test.ts` opens a SQLite
 * reference store itself. Database-free: it parses source and runs nothing.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

/** The calls that open a full store, as `name` or `Class.method`. */
export const STORE_OPENS: readonly string[] = [
  'openTestStore',
  'openStoreDatabase',
  'SessionStore.open',
  'StoreDatabase.open',
]

/** A file that names the engine chooses what it runs on Postgres itself. */
const READS_ENGINE = /\btestStoreEngine\b|PODIUM_TEST_STORE_ENGINE/

const toPosix = (path: string): string => path.split('\\').join('/')

/** Test support that is not a test file: where store-opening helpers live. */
const isSupportFile = (path: string): boolean =>
  path.endsWith('.ts') &&
  !path.endsWith('.d.ts') &&
  !path.includes('.test.') &&
  (path.includes('/test-support/') || path.endsWith('-support.ts') || path.endsWith('/testing.ts'))

/** The name of a call: `f(…)` is `f`, `A.f(…)` is `A.f`, anything else nothing. */
function callName(node: ts.CallExpression): string | undefined {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return `${callee.expression.text}.${callee.name.text}`
  }
  return undefined
}

/** Every call name under `node`. */
function callsUnder(node: ts.Node): Set<string> {
  const out = new Set<string>()
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current)) {
      const name = callName(current)
      if (name !== undefined) out.add(name)
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return out
}

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)

/** Each exported function of a source file with the calls its body makes. */
function exportedFunctions(file: string, source: string): Map<string, Set<string>> {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const out = new Map<string, Set<string>>()
  for (const statement of sourceFile.statements) {
    if (!isExported(statement)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      out.set(statement.name.text, callsUnder(statement.body))
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer
        if (
          ts.isIdentifier(declaration.name) &&
          init !== undefined &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          out.set(declaration.name.text, callsUnder(init.body))
        }
      }
    }
  }
  return out
}

/**
 * The store opens and every exported support helper that reaches one, directly or through
 * another such helper.
 */
export function storeOpeners(
  supportFiles: readonly { file: string; source: string }[],
): Set<string> {
  const helpers = new Map<string, Set<string>>()
  for (const { file, source } of supportFiles) {
    for (const [name, calls] of exportedFunctions(file, source)) helpers.set(name, calls)
  }
  const openers = new Set(STORE_OPENS)
  for (let grew = true; grew; ) {
    grew = false
    for (const [name, calls] of helpers) {
      if (openers.has(name)) continue
      if ([...calls].some((call) => openers.has(call))) {
        openers.add(name)
        grew = true
      }
    }
  }
  return openers
}

/** The test support files under `apps/server/src`, repository-relative, with their source. */
export function serverSupportFiles(repositoryRoot: string): { file: string; source: string }[] {
  const root = join(repositoryRoot, 'apps/server/src')
  return readdirSync(root, { recursive: true })
    .map((entry) => toPosix(relative(repositoryRoot, join(root, String(entry)))))
    .filter(isSupportFile)
    .sort()
    .map((file) => ({ file, source: readFileSync(join(repositoryRoot, file), 'utf8') }))
}

/**
 * The leg files that call a store opener and never read the engine, each with the openers
 * it calls: on the Postgres leg each such open fails until POD-6994.
 */
export function storeOpeningFiles(
  files: readonly { file: string; source: string }[],
  openers: ReadonlySet<string>,
): string[] {
  return files.flatMap(({ file, source }) => {
    if (READS_ENGINE.test(source)) return []
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const opened = [...callsUnder(sourceFile)].filter((call) => openers.has(call)).sort()
    return opened.length === 0 ? [] : [`${file} opens a store (${opened.join(', ')})`]
  })
}
