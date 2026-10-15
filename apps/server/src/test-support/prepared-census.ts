/**
 * THE PER-CALL BUILDER CENSUS [POD-6147, server data design §3 rule 1].
 *
 * Finds every drizzle query that a repository builds when a method runs rather
 * than once per store. A query is BUILT where a chain starts on a drizzle
 * instance: `db.select(...)`, `.selectDistinct`, `.insert`, `.update`,
 * `.delete`, `.$count`, `.$with`/`.with`, or a raw `db.all/get/run/values(sql)`.
 * A start that sits inside the callback of `prepared(...)` or
 * `preparedFamily(...)` is a definition: it runs once per store (or once per
 * shape). Every other start runs on every call, and is what this reports.
 *
 * "A drizzle instance" is recognised by name, which is how every repository in
 * the set spells it: `db`, `tx`, `rootDb`, or a member access ending in `.db`
 * or `.rootDb` (`this.db`, `this.queries.rootDb`). A census by name is a census
 * of the convention, and the convention is uniform; the runtime half of the
 * guard (`store/prepared-guard.test.ts`) counts real preparations and catches
 * what a renamed handle would hide from this one.
 */

import ts from 'typescript'

/** One place a query is built per call. */
export interface PerCallBuilder {
  readonly file: string
  /** `Class.member`, or the enclosing function or variable name. */
  readonly member: string
  readonly line: number
  /** `select`, `insert`, `all`, ... */
  readonly method: string
}

const BUILDER_STARTS = new Set([
  'select',
  'selectDistinct',
  'insert',
  'update',
  'delete',
  '$count',
  '$with',
  'with',
])
const RAW_TERMINALS = new Set(['all', 'get', 'run', 'values'])
const DEFINERS = new Set(['prepared', 'preparedFamily'])

function isDrizzleHandle(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === 'db' || expression.text === 'tx' || expression.text === 'rootDb'
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === 'db' || expression.name.text === 'rootDb'
  }
  return false
}

/** Inside the build callback of `prepared(...)` / `preparedFamily(...)`? */
function insideDefinition(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue
    const call = current.parent
    if (!call || !ts.isCallExpression(call) || call.arguments[0] !== current) continue
    const callee = call.expression
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined
    if (name !== undefined && DEFINERS.has(name)) return true
  }
  return false
}

function memberName(node: ts.Node): string {
  let member: string | undefined
  let owner: string | undefined
  for (let current = node.parent; current; current = current.parent) {
    if (
      member === undefined &&
      (ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current) ||
        ts.isPropertyDeclaration(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isVariableDeclaration(current)) &&
      current.name !== undefined
    ) {
      member = current.name.getText()
    }
    if (member === undefined && ts.isConstructorDeclaration(current)) member = 'constructor'
    if (ts.isClassDeclaration(current) && current.name) {
      owner = current.name.text
      break
    }
  }
  return [owner, member ?? '<module>'].filter(Boolean).join('.')
}

/**
 * Top-level functions that only definitions call: `function sessionsWhere(db, where)`
 * shared by several `prepared(...)` callbacks builds its query inside each of
 * them, once. A helper with any reference outside a definition is not one.
 */
function definitionHelpers(sourceFile: ts.SourceFile): Set<ts.Node> {
  const candidates = new Map<string, ts.Node>()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      candidates.set(statement.name.text, statement)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer
        if (
          ts.isIdentifier(declaration.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          candidates.set(declaration.name.text, init)
        }
      }
    }
  }
  const outside = new Set<string>()
  const referenced = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && candidates.has(node.text)) {
      const parent = node.parent
      const isDeclarationName =
        (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
        parent.name === node
      if (!isDeclarationName) {
        referenced.add(node.text)
        if (!insideDefinition(node)) outside.add(node.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  const helpers = new Set<ts.Node>()
  for (const [name, node] of candidates) {
    if (referenced.has(name) && !outside.has(name)) helpers.add(node)
  }
  return helpers
}

function insideHelper(node: ts.Node, helpers: Set<ts.Node>): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (helpers.has(current)) return true
  }
  return false
}

/** Every per-call builder in one source file. */
export function perCallBuilders(file: string, source: string): PerCallBuilder[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const helpers = definitionHelpers(sourceFile)
  const found: PerCallBuilder[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const receiver = node.expression.expression
      const starts =
        isDrizzleHandle(receiver) &&
        (BUILDER_STARTS.has(method) || (RAW_TERMINALS.has(method) && node.arguments.length > 0))
      if (starts && !insideDefinition(node) && !insideHelper(node, helpers)) {
        found.push({
          file,
          member: memberName(node),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          method,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** The repository sources the census covers, from a list of tracked paths. */
export function censusScope(paths: readonly string[]): string[] {
  return paths.filter(
    (path) =>
      path.endsWith('.ts') &&
      (path.startsWith('apps/server/src/store/') ||
        path.startsWith('packages/sync/src/adapters/sqlite/')) &&
      !path.includes('.test.') &&
      !path.includes('.type-test.') &&
      !path.includes('/executor/') &&
      !path.includes('/spike/') &&
      !path.endsWith('/test-support.ts'),
  )
}
