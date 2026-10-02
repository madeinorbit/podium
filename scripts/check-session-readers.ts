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
  if (file.endsWith('packages/client-core/src/session-values.ts')) return []
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const reader = !file.includes('packages/client-core/src/') || CORE_READERS.test(file)
  const hits: string[] = []
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
    // Writes/fingerprints remain legal; reading a named legacy cell through a
    // raw cast anywhere in client-core is not a transport operation.
    let base =
      ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
        ? node.expression
        : undefined
    while (base && ts.isParenthesizedExpression(base)) base = base.expression
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      base &&
      ts.isAsExpression(base) &&
      /\bSessionMeta\b/.test(base.type.getText(ast))
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
