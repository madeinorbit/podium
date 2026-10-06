/** Product time reads use DeadlineClock's tracked or explicit maintenance API. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { productionFiles } from './check-interaction-scans'

export function bareClockReads(source: string, file = 'reader.ts'): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const aliases = new Set<string>()
  const clockName = (name: string) => /clock$/i.test(name)
  const clock = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node)) return clock(node.expression)
    if (ts.isIdentifier(node)) return aliases.has(node.text) || clockName(node.text)
    if (ts.isPropertyAccessExpression(node)) return clockName(node.name.text)
    if (ts.isElementAccessExpression(node)) return ts.isStringLiteral(node.argumentExpression) && clockName(node.argumentExpression.text)
    if (ts.isCallExpression(node)) return clock(node.expression)
    return false
  }
  const visit = (node: ts.Node, read: (node: ts.Node) => void) => {
    read(node)
    ts.forEachChild(node, child => visit(child, read))
  }
  // Resolve local aliases before checking reads, including aliases of aliases.
  let count = -1
  while (count !== aliases.size) {
    count = aliases.size
    visit(ast, node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && clock(node.initializer)) aliases.add(node.name.text)
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type?.getText(ast).includes('DeadlineClock')) aliases.add(node.name.text)
    })
  }
  const errors: string[] = []
  visit(ast, node => {
    const receiver = ts.isPropertyAccessExpression(node) && node.name.text === 'current'
      ? node.expression
      : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'current'
        ? node.expression : undefined
    if (receiver && clock(receiver)) {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
      errors.push(`${file}:${line}: bare clock.current; use trackedNow(), or peekNow() with maintenance/exact-deadline ownership`)
    }
  })
  return errors
}

export function checkClockReads(root = process.cwd()): string[] {
  return productionFiles(root)
    .filter(file => file !== 'packages/mobx-helpers/src/clock.ts')
    .flatMap(file => bareClockReads(readFileSync(join(root, file), 'utf8'), file))
}

if (import.meta.main) {
  const errors = checkClockReads()
  for (const error of errors) console.error(error)
  console.log(`Clock read fence: ${errors.length} bare product reads`)
  if (errors.length) process.exitCode = 1
}
