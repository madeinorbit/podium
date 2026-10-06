/** Production MobX escape inventory. Tags belong immediately above the call, not a function. */
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
  const aliases = new Set(['untracked'])
  const namespaces = new Set<string>()
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== 'mobx') continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements)
      if ((binding.propertyName ?? binding.name).text === 'untracked') aliases.add(binding.name.text)
  }
  const lines = source.split(/\r?\n/)
  const reads: UntrackedRead[] = []
  const visit = (node: ts.Node, insideEscape = false): void => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression
      const escape = ts.isIdentifier(expr) && aliases.has(expr.text)
        || ts.isPropertyAccessExpression(expr) && expr.name.text === 'untracked'
          && ts.isIdentifier(expr.expression) && namespaces.has(expr.expression.text)
      const peek = node.arguments.some(arg => ts.isStringLiteral(arg) && arg.text === 'peek')
      if (escape || (peek && !insideEscape)) {
        const position = ts.isPropertyAccessExpression(expr) ? expr.name.getStart(ast) : node.getStart(ast)
        const line = ast.getLineAndCharacterOfPosition(position).line
        // A nested peek in an untracked call shares that call site's tag.
        const comment = /^\s*\/\/ untracked-read: ([a-z][a-z0-9-]*)\s*$/.exec(lines[line - 1] ?? '')
        reads.push({ file, line: line + 1, tag: comment?.[1] })
      }
      ts.forEachChild(node, child => visit(child, insideEscape || escape))
      return
    }
    ts.forEachChild(node, child => visit(child, insideEscape))
  }
  visit(ast)
  return reads
}

export function inventoryErrors(reads: readonly UntrackedRead[], inventory = UNTRACKED_READS): string[] {
  const errors: string[] = []
  const used = new Set<string>()
  for (const read of reads) {
    const at = `${read.file}:${read.line}`
    if (!read.tag) { errors.push(`${at}: deliberate untracked/peek read needs an untracked-read tag`); continue }
    if (!Object.hasOwn(inventory, read.tag) || !inventory[read.tag]?.trim())
      errors.push(`${at}: ${read.tag} needs a one-line reason in clock.ts UNTRACKED_READS`)
    if (used.has(read.tag)) errors.push(`${at}: duplicate call-site tag ${read.tag}`)
    used.add(read.tag)
  }
  for (const [tag, reason] of Object.entries(inventory)) {
    if (!used.has(tag)) errors.push(`clock.ts: unused inventory tag ${tag}`)
    if (!reason.trim() || /[\r\n]/.test(reason)) errors.push(`clock.ts: ${tag} needs a one-line reason`)
  }
  return errors
}

/** Product code only: experimental prototype arms and test/harness fixtures have their own contracts. */
export function productionUntrackedReads(root: string): UntrackedRead[] {
  const reads: UntrackedRead[] = []
  const excluded = new Set(['node_modules', 'dist', 'build', 'test', 'tests', '__tests__', '__snapshots__',
    'harness', 'diagnostics', '.expo', '.turbo'])
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { if (!excluded.has(entry.name)) walk(path); continue }
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)
        || /\.(test|spec|bench|browser)\./.test(entry.name) || entry.name.endsWith('.d.ts')) continue
      reads.push(...scanUntrackedReads(relative(root, path), readFileSync(path, 'utf8')))
    }
  }
  walk(join(root, 'apps'))
  walk(join(root, 'packages'))
  return reads
}

if (import.meta.main) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const reads = productionUntrackedReads(root)
  const errors = inventoryErrors(reads)
  for (const error of errors) console.error(error)
  console.log(`Untracked-read inventory: ${reads.length} call sites; ${errors.length} errors`)
  process.exitCode = errors.length ? 1 : 0
}
