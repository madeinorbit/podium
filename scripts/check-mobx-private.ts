/** MobX's private exports belong only to keyedComputed's one tracking check. */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const HELPER = 'packages/mobx-helpers/src/keyed-computed.ts'
const privateName = (name: string) => name.startsWith('_') || name.endsWith('_')

export function mobxPrivateUses(source: string, file: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const hits: string[] = [], namespaces = new Set<string>()
  const moduleOf = (node: ts.Expression): string | undefined => {
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) return moduleOf(node.expression)
    if (ts.isIdentifier(node) && namespaces.has(node.text)) return 'mobx'
    if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) return node.arguments[0].text
    return undefined
  }
  const report = (node: ts.Node, name: string) => {
    const line = ast.getLineAndCharacterOfPosition(node.getStart()).line + 1
    hits.push(`${file}:${line}: private MobX API ${name}; use @podium/mobx-helpers or public MobX APIs`)
  }
  const inspectName = (node: ts.Node, name: string, importOnly = false) => {
    if (privateName(name) && !(importOnly && file === HELPER && name === '_isComputingDerivation')) report(node, name)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier
      if (spec && ts.isStringLiteralLike(spec)) {
        if (spec.text.startsWith('mobx/')) report(node, spec.text)
        if (spec.text === 'mobx') {
          if (ts.isImportDeclaration(node)) {
            if (node.importClause?.name) namespaces.add(node.importClause.name.text)
            const bindings = node.importClause?.namedBindings
            if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
            if (bindings && ts.isNamedImports(bindings))
              for (const entry of bindings.elements) inspectName(entry, (entry.propertyName ?? entry.name).text, true)
          } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const entry of node.exportClause.elements) inspectName(entry, (entry.propertyName ?? entry.name).text)
          } else report(node, 'namespace re-export')
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && moduleOf(node.initializer) === 'mobx') {
      if (ts.isIdentifier(node.name)) namespaces.add(node.name.text)
      if (ts.isObjectBindingPattern(node.name)) for (const entry of node.name.elements) {
        const name = entry.propertyName ?? entry.name
        if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) inspectName(entry, name.text)
      }
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && moduleOf(node.expression) === 'mobx') {
      const name = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) inspectName(node, name.text)
    }
    if (ts.isCallExpression(node)) {
      const module = moduleOf(node)
      if (module?.startsWith('mobx/')) report(node, module)
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.getText(ast) === 'Reflect.get' &&
        node.arguments[0] && moduleOf(node.arguments[0]) === 'mobx' &&
        node.arguments[1] && ts.isStringLiteralLike(node.arguments[1])) inspectName(node, node.arguments[1].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return hits
}

export function checkMobxPrivate(root = process.cwd()): string[] {
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'target', 'vendor'].includes(entry.name)) return []
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : []
  })
  return walk(root).flatMap(path => mobxPrivateUses(readFileSync(path, 'utf8'), relative(root, path).replaceAll('\\', '/')))
}

if (import.meta.main) {
  const hits = checkMobxPrivate()
  for (const hit of hits) console.error(hit)
  console.log(`MobX private API boundary: ${hits.length} violations`)
  if (hits.length) process.exitCode = 1
}
