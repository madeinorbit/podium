/**
 * Production MobX escape inventory. Tags belong immediately above the call, not a function.
 *
 * The same check holds the side-state rule (POD-7454): in the client graph and
 * the replica, a Map or Set held past one call (a class field, a field set in a
 * constructor, a module-level value) is a `SideMap`/`SideSet`, so a derivation
 * that reads it is reported, or carries a reviewed allow comment naming why a
 * reader can never be stranded by it. `signalledRead` call sites, the guard's
 * reviewed escapes, are tagged and inventoried like `untracked`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { UNTRACKED_READS } from '../packages/client-graph/src/clock'

export interface UntrackedRead {
  file: string
  line: number
  tag: string | undefined
}

export function scanUntrackedReads(file: string, source: string): UntrackedRead[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const aliases = new Set(['untracked', 'signalledRead', 'sideStateUpkeep'])
  const namespaces = new Set<string>()
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const mobx = statement.moduleSpecifier.text === 'mobx'
    const bindings = statement.importClause?.namedBindings
    if (mobx && bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings))
      for (const binding of bindings.elements) {
        const imported = (binding.propertyName ?? binding.name).text
        if ((mobx && imported === 'untracked') || imported === 'signalledRead' || imported === 'sideStateUpkeep')
          aliases.add(binding.name.text)
      }
  }
  const lines = source.split(/\r?\n/)
  const reads: UntrackedRead[] = []
  const visit = (node: ts.Node, insideEscape = false): void => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression
      const escape =
        (ts.isIdentifier(expr) && aliases.has(expr.text)) ||
        (ts.isPropertyAccessExpression(expr) &&
          expr.name.text === 'untracked' &&
          ts.isIdentifier(expr.expression) &&
          namespaces.has(expr.expression.text))
      const peek = node.arguments.some((arg) => ts.isStringLiteral(arg) && arg.text === 'peek')
      if (escape || (peek && !insideEscape)) {
        const position = ts.isPropertyAccessExpression(expr)
          ? expr.name.getStart(ast)
          : node.getStart(ast)
        const line = ast.getLineAndCharacterOfPosition(position).line
        // A nested peek in an untracked call shares that call site's tag.
        const comment = /^\s*\/\/ untracked-read: ([a-z][a-z0-9-]*)\s*$/.exec(lines[line - 1] ?? '')
        reads.push({ file, line: line + 1, tag: comment?.[1] })
      }
      ts.forEachChild(node, (child) => visit(child, insideEscape || escape))
      return
    }
    ts.forEachChild(node, (child) => visit(child, insideEscape))
  }
  visit(ast)
  return reads
}

export function inventoryErrors(
  reads: readonly UntrackedRead[],
  inventory = UNTRACKED_READS,
): string[] {
  const errors: string[] = []
  const used = new Set<string>()
  for (const read of reads) {
    const at = `${read.file}:${read.line}`
    if (!read.tag) {
      errors.push(`${at}: deliberate untracked/peek read needs an untracked-read tag`)
      continue
    }
    if (!Object.hasOwn(inventory, read.tag) || !inventory[read.tag]?.trim())
      errors.push(`${at}: ${read.tag} needs a one-line reason in clock.ts UNTRACKED_READS`)
    if (used.has(read.tag)) errors.push(`${at}: duplicate call-site tag ${read.tag}`)
    used.add(read.tag)
  }
  for (const [tag, reason] of Object.entries(inventory)) {
    if (!used.has(tag)) errors.push(`clock.ts: unused inventory tag ${tag}`)
    if (!reason.trim() || /[\r\n]/.test(reason))
      errors.push(`clock.ts: ${tag} needs a one-line reason`)
  }
  return errors
}

const EXCLUDED = new Set([
  'node_modules',
  'dist',
  'build',
  'test',
  'tests',
  '__tests__',
  '__snapshots__',
  'harness',
  'diagnostics',
  '.expo',
  '.turbo',
])

/** Product source files under `directory`: no tests, fixtures, harnesses or declarations. */
function productFiles(directory: string): string[] {
  const files: string[] = []
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) {
        if (!EXCLUDED.has(entry.name)) walk(path)
        continue
      }
      if (
        !entry.isFile() ||
        !/\.[cm]?[jt]sx?$/.test(entry.name) ||
        /\.(test|spec|bench|browser)\./.test(entry.name) ||
        entry.name.endsWith('.d.ts')
      )
        continue
      files.push(path)
    }
  }
  walk(directory)
  return files
}

/** Product code only: experimental prototype arms and test/harness fixtures have their own contracts. */
export function productionUntrackedReads(root: string): UntrackedRead[] {
  const reads: UntrackedRead[] = []
  for (const directory of ['apps', 'packages'])
    for (const path of productFiles(join(root, directory)))
      reads.push(...scanUntrackedReads(relative(root, path), readFileSync(path, 'utf8')))
  return reads
}

/** Why a held Map/Set may stay plain: none of these can strand a derivation's answer. */
export const SIDE_STATE_CATEGORIES = {
  identity: 'stable objects by key; the changing facts are read from the objects, tracked',
  signal: 'a registry of the signals (atoms) readers observe, not of facts',
  declaration: 'fixed after module initialization, or a memo over fixed declarations',
  snapshot: 'immutable once built; a change builds or assigns a new one',
  scratch: "rebuilt from the current call's inputs before it is read",
} as const

export interface SideStateConstructor {
  file: string
  line: number
  collection: 'Map' | 'Set'
  /** The allow comment's category and reason, if it has one. */
  allow: { category: string; reason: string } | undefined
}

const SIDE_STATE_ALLOW = /^\s*\/\/ side-state: ([a-z]+): (.*\S)\s*$/

/**
 * Every `new Map`/`new Set` held past one call: class field initializers,
 * `this.x = ...` in a constructor, module-level declarations. A value built in
 * an expression-bodied callback of such an initializer counts; a block-bodied
 * function in it is a local scope and is not linted. The allow comment sits on
 * the line above the declaration or above the constructor itself.
 */
export function scanSideStateConstructors(file: string, source: string): SideStateConstructor[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const lines = source.split(/\r?\n/)
  const found: SideStateConstructor[] = []
  const allowAbove = (node: ts.Node) => {
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line
    const match = SIDE_STATE_ALLOW.exec(lines[line - 1] ?? '')
    return match ? { category: match[1]!, reason: match[2]! } : undefined
  }
  const collect = (holder: ts.Node, value: ts.Node): void => {
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassLike(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node) ||
        (ts.isArrowFunction(node) && ts.isBlock(node.body))
      )
        return
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'Map' || node.expression.text === 'Set')
      ) {
        found.push({
          file,
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          collection: node.expression.text,
          allow: allowAbove(node) ?? allowAbove(holder),
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(value)
  }
  const visitClasses = (node: ts.Node): void => {
    if (ts.isClassLike(node))
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member) && member.initializer)
          collect(member, member.initializer)
        if (ts.isConstructorDeclaration(member) && member.body)
          for (const statement of member.body.statements) {
            if (
              !ts.isExpressionStatement(statement) ||
              !ts.isBinaryExpression(statement.expression)
            )
              continue
            const { left, operatorToken, right } = statement.expression
            if (
              operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isPropertyAccessExpression(left) &&
              left.expression.kind === ts.SyntaxKind.ThisKeyword
            )
              collect(statement, right)
          }
      }
    ts.forEachChild(node, visitClasses)
  }
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (declaration.initializer) collect(statement, declaration.initializer)
  }
  visitClasses(ast)
  return found.sort((a, b) => a.line - b.line)
}

export function sideStateErrors(found: readonly SideStateConstructor[]): string[] {
  const errors: string[] = []
  for (const entry of found) {
    const at = `${entry.file}:${entry.line}`
    if (!entry.allow) {
      errors.push(
        `${at}: a held ${entry.collection} is a Side${entry.collection} (packages/sync/src/replica/side-state.ts), ` +
          `or carries "// side-state: <${Object.keys(SIDE_STATE_CATEGORIES).join('|')}>: <reason>" above it`,
      )
      continue
    }
    if (!Object.hasOwn(SIDE_STATE_CATEGORIES, entry.allow.category))
      errors.push(`${at}: unknown side-state category ${entry.allow.category}`)
  }
  return errors
}

/** The guarded surface: the client graph and the replica, product code only. */
export const SIDE_STATE_ROOTS = ['packages/client-graph/src', 'packages/sync/src/replica'] as const

export function productionSideState(root: string): SideStateConstructor[] {
  const found: SideStateConstructor[] = []
  for (const directory of SIDE_STATE_ROOTS)
    for (const path of productFiles(join(root, directory)))
      found.push(...scanSideStateConstructors(relative(root, path), readFileSync(path, 'utf8')))
  return found
}

if (import.meta.main) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const reads = productionUntrackedReads(root)
  const side = productionSideState(root)
  const errors = [...inventoryErrors(reads), ...sideStateErrors(side)]
  for (const error of errors) console.error(error)
  console.log(
    `Untracked-read inventory: ${reads.length} call sites; side state: ${side.length} held collections; ${errors.length} errors`,
  )
  process.exitCode = errors.length ? 1 : 0
}
