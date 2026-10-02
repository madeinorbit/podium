/** S2 reader boundary. Raw wire types/collections stay in transport, replica
 * and the optimistic writer; application readers use the shared SessionView. */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOTS = [
  'apps/web/src',
  'packages/client-core/src',
  'packages/client-graph/src',
  'packages/client-graph/diagnostics',
]
const CORE_READERS =
  /packages\/client-core\/src\/(?:viewmodels\/|react\/|focus\.ts|session-index\.ts|engine\/(?:actions|state|types|reactions)\.ts)/
export function sessionReaderFiles(root = process.cwd()): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory()
        ? walk(path)
        : /\.tsx?$/.test(path) &&
            !/\.(?:test|spec|frontend-perf|probe)\./.test(path) &&
            !path.includes('/test-support/')
          ? [path]
          : []
    })
  return ROOTS.flatMap((dir) => walk(join(root, dir)))
}
export function legacySessionReads(source: string, file = 'apps/web/src/example.ts'): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const reader = !file.includes('packages/client-core/src/') || CORE_READERS.test(file)
  const hits: string[] = []
  const wireNames = new Set(['SessionMeta'])
  const rawBindings = new Set<string>()
  const gather = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^@podium\/model(?:\/browser)?$/.test(node.moduleSpecifier.text)
    ) {
      const names = node.importClause?.namedBindings
      if (names && ts.isNamedImports(names))
        for (const name of names.elements) {
          if ((name.propertyName ?? name.name).text === 'SessionMeta') wireNames.add(name.name.text)
        }
    }
    ts.forEachChild(node, gather)
  }
  gather(ast)
  const gatherBindings = (node: ts.Node): void => {
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      node.type &&
      ts.isIdentifier(node.name) &&
      [...wireNames].some((name) => new RegExp(`\\b${name}\\b`).test(node.type!.getText(ast)))
    )
      rawBindings.add(node.name.text)
    ts.forEachChild(node, gatherBindings)
  }
  gatherBindings(ast)
  const visit = (node: ts.Node): void => {
    if (
      reader &&
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^@podium\/model(?:\/browser)?$/.test(node.moduleSpecifier.text)
    ) {
      const names = node.importClause?.namedBindings
      if (names && ts.isNamedImports(names))
        for (const name of names.elements) {
          if ((name.propertyName ?? name.name).text === 'SessionMeta')
            hits.push('raw SessionMeta import: use SessionView from the session-values module')
        }
    }
    if (
      reader &&
      !file.endsWith('/shared/row-source.ts') &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const name = node.expression.name.text
      const kind = node.arguments[0]
      if (
        ['row', 'rows', 'collection', 'subscribeRows'].includes(name) &&
        kind &&
        ts.isStringLiteral(kind) &&
        kind.text === 'sessions'
      ) {
        hits.push('raw sessions collection: read the shared store or row-source session view')
      }
    }
    if (
      reader &&
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal) &&
      /^@podium\/model(?:\/browser)?$/.test(node.argument.literal.text) &&
      node.qualifier?.getText(ast) === 'SessionMeta'
    )
      hits.push('inline raw SessionMeta import: use SessionView')
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      rawBindings.has(node.initializer.text)
    ) {
      for (const element of node.name.elements) {
        const field = (element.propertyName ?? element.name).getText(ast).replace(/['"]/g, '')
        if (
          [
            'readAt',
            'unread',
            'snoozedUntil',
            'displayRef',
            'machineName',
            'condition',
            'handoffTarget',
          ].includes(field)
        )
          hits.push(`raw destructured cell ${field}: use sessionValues`)
      }
    }
    // Writes/fingerprints remain legal; reading a named legacy cell through a
    // raw cast anywhere in client-core is not a transport operation.
    let base: ts.Expression | undefined =
      ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
        ? node.expression
        : undefined
    while (base && ts.isParenthesizedExpression(base)) base = base.expression
    const castType = base && ts.isAsExpression(base) ? base.type.getText(ast) : ''
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      base &&
      ((ts.isAsExpression(base) &&
        [...wireNames].some((name) => new RegExp(`\\b${name}\\b`).test(castType))) ||
        (ts.isIdentifier(base) && rawBindings.has(base.text)))
    ) {
      const field = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : ''
      if (
        [
          'readAt',
          'unread',
          'snoozedUntil',
          'displayRef',
          'machineName',
          'condition',
          'handoffTarget',
        ].includes(field)
      )
        hits.push(`raw legacy cell ${field}: use sessionValues`)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return hits
}
export function checkSessionReaders(root = process.cwd()): string[] {
  return sessionReaderFiles(root).flatMap((path) =>
    legacySessionReads(readFileSync(path, 'utf8'), relative(root, path)).map(
      (hit) => `${relative(root, path)}: ${hit}`,
    ),
  )
}
if (import.meta.main) {
  const hits = checkSessionReaders()
  for (const hit of hits) console.error(hit)
  console.log(`Session reader boundary: ${hits.length} violations`)
  if (hits.length) process.exitCode = 1
}
