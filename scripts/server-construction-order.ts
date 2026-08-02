import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const REPO = resolve(import.meta.dirname, '..')
const ROOT = resolve(REPO, 'apps/server/src/relay.ts')
const OUTPUT = resolve(REPO, 'docs/architecture/server-construction-order.md')

export interface AssemblyStep {
  name: string
  dependencies: string[]
  line: number
}

export interface AssemblyAudit {
  steps: AssemblyStep[]
  propertyAssignments: { name: string; line: number }[]
}

function sessionRegistryConstructor(source: ts.SourceFile): ts.ConstructorDeclaration {
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== 'SessionRegistry') continue
    const constructor = statement.members.find(ts.isConstructorDeclaration)
    if (constructor?.body) return constructor
  }
  throw new Error('SessionRegistry constructor not found')
}

function isThisProperty(node: ts.Node): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword
}

function isPropertyName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier)
  )
}

export function auditConstructionSource(text: string, path = ROOT): AssemblyAudit {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const constructor = sessionRegistryConstructor(source)
  if (!constructor.body) throw new Error('SessionRegistry constructor has no body')

  const declarations: { name: string; node: ts.VariableDeclaration; line: number }[] = []
  const propertyWrites = new Map<string, ts.PropertyAccessExpression>()
  const nonNullAssertions: ts.Node[] = []

  const visitFacts = (node: ts.Node): void => {
    if (ts.isNonNullExpression(node)) nonNullAssertions.push(node)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isThisProperty(node.left)
    ) {
      propertyWrites.set(node.left.name.text, node.left)
    }
    ts.forEachChild(node, visitFacts)
  }
  visitFacts(constructor.body)

  for (const statement of constructor.body.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      if (declaration.exclamationToken) nonNullAssertions.push(declaration)
      declarations.push({
        name: declaration.name.text,
        node: declaration,
        line: source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1,
      })
    }
  }

  if (nonNullAssertions.length > 0) {
    const locations = nonNullAssertions.map(
      (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    )
    throw new Error(
      `composition root contains non-null late binding(s) at line(s) ${locations.join(', ')}`,
    )
  }

  const positions = new Map(declarations.map((declaration, index) => [declaration.name, index]))
  const steps: AssemblyStep[] = declarations.map((declaration, index) => {
    const dependencies = new Set<string>()
    const deferredServiceClosures = new Set<string>()
    const visit = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) return
      if (
        ts.isArrowFunction(node) &&
        node.parameters.length === 0 &&
        ts.isIdentifier(node.body) &&
        positions.has(node.body.text)
      ) {
        deferredServiceClosures.add(node.body.text)
      }
      if (ts.isIdentifier(node) && !isPropertyName(node) && positions.has(node.text)) {
        dependencies.add(node.text)
      }
      ts.forEachChild(node, visit)
    }
    if (declaration.node.initializer) visit(declaration.node.initializer)
    dependencies.delete(declaration.name)
    const future = [...dependencies].filter(
      (dependency) => (positions.get(dependency) ?? -1) > index,
    )
    if (future.length > 0) {
      throw new Error(
        `${declaration.name} at line ${declaration.line} depends on later service(s): ${future.join(', ')}`,
      )
    }
    if (deferredServiceClosures.size > 0) {
      throw new Error(
        `${declaration.name} at line ${declaration.line} wraps constructed service ${[
          ...deferredServiceClosures,
        ].join(', ')} in a deferred closure`,
      )
    }
    return {
      name: declaration.name,
      dependencies: [...dependencies].sort(),
      line: declaration.line,
    }
  })

  const visitPropertyReads = (node: ts.Node): void => {
    if (isThisProperty(node)) {
      const write = propertyWrites.get(node.name.text)
      const isWrite =
        ts.isBinaryExpression(node.parent) &&
        node.parent.left === node &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      if (write && !isWrite && node.getStart(source) < write.getStart(source)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        const writeLine = source.getLineAndCharacterOfPosition(write.getStart(source)).line + 1
        throw new Error(
          `this.${node.name.text} is read at line ${line} before assignment at line ${writeLine}`,
        )
      }
    }
    ts.forEachChild(node, visitPropertyReads)
  }
  visitPropertyReads(constructor.body)

  return {
    steps,
    propertyAssignments: [...propertyWrites]
      .map(([name, node]) => ({
        name,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      }))
      .sort((a, b) => a.line - b.line),
  }
}

export function auditServerConstruction(path = ROOT): AssemblyAudit {
  return auditConstructionSource(readFileSync(path, 'utf8'), path)
}

function render(audit: AssemblyAudit): string {
  return [
    '# Server construction order',
    '',
    '> Generated by `bun scripts/server-construction-order.ts --write`; checked without `--write`.',
    '> The audit walks initializer closures too, so a thunk that captures a later service fails.',
    '',
    `Root: \`${relative(REPO, ROOT)}\``,
    '',
    `Verified constructor declarations: ${audit.steps.length}. Forward dependencies: 0. Deferred service closures: 0. Non-null late bindings: 0.`,
    '',
    '| Order | Declaration | Earlier declaration dependencies | Source line |',
    '|---:|---|---|---:|',
    ...audit.steps.map(
      (step, index) =>
        `| ${index + 1} | \`${step.name}\` | ${
          step.dependencies.length ? step.dependencies.map((name) => `\`${name}\``).join(', ') : '—'
        } | ${step.line} |`,
    ),
    '',
  ].join('\n')
}

function main(): void {
  const content = render(auditServerConstruction())
  if (process.argv.includes('--write')) {
    writeFileSync(OUTPUT, content)
    console.log(`wrote ${relative(REPO, OUTPUT)}`)
  } else if (!existsSync(OUTPUT) || readFileSync(OUTPUT, 'utf8') !== content) {
    throw new Error('construction-order document is missing or stale; run with --write')
  } else {
    console.log('server construction order is topological and current')
  }
}

if (import.meta.main) main()
