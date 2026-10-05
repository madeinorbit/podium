import ts from 'typescript'
import { isTestFile, type Violation } from './architecture-manifest'

/** Lifecycle readers use the shared predicates; payloads and reason copy remain scalar reads. */
export function checkIssuePredicates(file: string, source: string): Violation[] {
  if (isTestFile(file) || file === 'packages/client-graph/src/shared/predicates.ts') return []
  if (!['packages/client-graph/', 'packages/client-core/src/values/', 'apps/web/src/',
    'apps/mobile/src/'].some(root => file.startsWith(root))) return []

  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const aliases = new Map<string, 'stage' | 'closedReason'>()
  function scalar(node: ts.Node): 'stage' | 'closedReason' | undefined {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return scalar(node.expression)
    if (ts.isIdentifier(node)) {
      if (node.text === 'stage' || node.text === 'closedReason') return node.text
      return aliases.get(node.text)
    }
    const key = ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
        ? node.argumentExpression.text : undefined
    return key === 'stage' || key === 'closedReason' ? key : undefined
  }
  function findAliases(node: ts.Node) {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer) {
        const field = scalar(node.initializer)
        if (field) aliases.set(node.name.text, field)
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue
          const key = element.propertyName?.getText(ast) ?? element.name.text
          if (key === 'stage' || key === 'closedReason') aliases.set(element.name.text, key)
        }
      }
    }
    ts.forEachChild(node, findAliases)
  }
  findAliases(ast)

  const violations: Violation[] = []
  const equality = new Set([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken])
  function done(node: ts.Node): boolean {
    if (ts.isParenthesizedExpression(node)) return done(node.expression)
    return ts.isStringLiteral(node) && node.text === 'done'
  }
  function reason(node: ts.Node): boolean {
    return scalar(node) === 'closedReason' || (ts.isTypeOfExpression(node) && reason(node.expression))
  }
  function visit(node: ts.Node) {
    let forbidden = false
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind
      forbidden = equality.has(op) && (
        (scalar(node.left) === 'stage' && done(node.right)) ||
        (scalar(node.right) === 'stage' && done(node.left)) || reason(node.left) || reason(node.right))
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken)
        forbidden ||= reason(node.left) || reason(node.right)
    } else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      forbidden = reason(node.operand)
    } else if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ||
      ts.isConditionalExpression(node)) {
      forbidden = reason(ts.isConditionalExpression(node) ? node.condition : node.expression)
    } else if (ts.isForStatement(node) && node.condition) {
      forbidden = reason(node.condition)
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'Boolean') {
      forbidden = node.arguments.some(reason)
    }
    if (forbidden) {
      const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast))
      violations.push({ rule: 'issue-lifecycle-predicates', file, specifier: '',
        message: `Line ${line + 1}: use isFinished/isClosed from the shared predicates instead of testing stage or closedReason.` })
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return violations
}
