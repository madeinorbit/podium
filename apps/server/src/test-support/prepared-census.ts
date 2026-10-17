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

/** One `prepared(...)` / `preparedFamily(...)` call in the source [POD-6148]. */
export interface QueryDefinitionSite {
  readonly file: string
  /**
   * The name the query-plan audit keys allowlists and family shapes by:
   * `const name = prepared(...)` gives `name`, `{ name: prepared(...) }` gives
   * `name`, `this.writes.name ??= prepared(...)` gives `name`, with the enclosing
   * class or function in front when there is one (`IssuesRepository.upsert`).
   */
  readonly name: string
  readonly kind: 'prepared' | 'family'
  /** First and last line of the call, 1-based, inclusive. */
  readonly startLine: number
  readonly endLine: number
  /** False for a definition made inside a function or method rather than at module level. */
  readonly moduleLevel: boolean
}

function definitionName(call: ts.CallExpression): string {
  let own: string | undefined
  for (let current: ts.Node = call.parent; current && own === undefined; current = current.parent) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) own = current.name.text
    else if (ts.isPropertyAssignment(current)) own = current.name.getText()
    else if (ts.isBinaryExpression(current)) {
      own = ts.isPropertyAccessExpression(current.left)
        ? current.left.name.text
        : current.left.getText()
    } else if (!ts.isParenthesizedExpression(current) && !ts.isAsExpression(current)) break
  }
  let owner: string | undefined
  for (let current: ts.Node = call.parent; current; current = current.parent) {
    if (ts.isClassDeclaration(current) && current.name) {
      owner = current.name.text
      break
    }
    if (ts.isFunctionDeclaration(current) && current.name) {
      owner = current.name.text
      break
    }
  }
  return [owner, own ?? '<anonymous>'].filter(Boolean).join('.')
}

function atModuleLevel(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isFunctionLike(current) &&
      !(current.parent && ts.isCallExpression(current.parent) && isDefinerCall(current.parent))
    ) {
      return false
    }
    if (ts.isClassLike(current)) return false
  }
  return true
}

function isDefinerCall(node: ts.CallExpression): boolean {
  const callee = node.expression
  return ts.isIdentifier(callee) && DEFINERS.has(callee.text)
}

/** Every query definition in one source file, in source order. */
export function queryDefinitionSites(file: string, source: string): QueryDefinitionSite[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: QueryDefinitionSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isDefinerCall(node)) {
      const callee = node.expression as ts.Identifier
      found.push({
        file,
        name: definitionName(node),
        kind: callee.text === 'prepared' ? 'prepared' : 'family',
        startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
        moduleLevel: atModuleLevel(node),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/**
 * THE RAW SQL CENSUS [POD-6227]: every statement handed to a database handle
 * outside the repositories, where neither the definition census above nor the
 * query-plan audit can see it.
 *
 * A raw statement is the one argument of a `.prepare(...)` call, of a `.query(...)`
 * call whose argument is SQL text, or of the sync worker's streaming
 * `iterate(db, sql)`. A literal (a string, or a template with no `${}`) is the
 * statement's text, whitespace folded; anything else is recorded as the source
 * of the expression that builds it, so a dynamic statement is censused too and
 * has to be explained by name.
 */
export interface RawSqlSite {
  readonly file: string
  readonly line: number
  /** The statement's text, whitespace folded, or the source of the expression that builds it. */
  readonly sql: string
  /** False when `sql` is an expression's source rather than the statement's text. */
  readonly literal: boolean
}

const SQL_TEXT = /^\s*(select|insert|update|delete|replace|with|pragma|vacuum)\b/i

const foldSql = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The production sources the raw SQL census reads: the server and the sync package, minus tests. */
export function rawSqlScope(paths: readonly string[]): string[] {
  return paths.filter(
    (path) =>
      path.endsWith('.ts') &&
      (path.startsWith('apps/server/src/') || path.startsWith('packages/sync/src/')) &&
      !path.includes('.test.') &&
      !path.includes('.type-test.') &&
      !path.includes('/test-support/') &&
      !path.endsWith('/test-support.ts') &&
      !path.endsWith('.d.ts'),
  )
}

/** Every raw SQL statement in one source file, in source order. */
export function rawSqlSites(file: string, source: string): RawSqlSite[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: RawSqlSite[] = []
  const record = (node: ts.Node, argument: ts.Expression) => {
    const literal = ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
    found.push({
      file,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      sql: literal ? foldSql(argument.text) : foldSql(argument.getText(sourceFile)),
      literal,
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const [first, second] = node.arguments
      if (ts.isPropertyAccessExpression(callee) && first) {
        const method = callee.name.text
        const text = ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) ? first.text : undefined
        // A statement prepare takes the SQL alone; other `prepare` methods take more.
        if (method === 'prepare' && node.arguments.length === 1) record(node, first)
        else if (method === 'query' && text !== undefined && SQL_TEXT.test(text)) record(node, first)
      } else if (ts.isIdentifier(callee) && callee.text === 'iterate' && second) {
        record(node, second)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}
