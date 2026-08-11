import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const REPO = resolve(import.meta.dirname, '..')
const ROOT = resolve(REPO, 'apps/server/src/relay.ts')
const OUTPUT = resolve(REPO, 'docs/architecture/server-construction-order.md')
const SERVER_SRC = resolve(REPO, 'apps/server/src')

/**
 * A body large enough that its statement ORDER carries meaning. Anything at or
 * above this must be an enrolled site below, so the next load-bearing wiring
 * body cannot appear unwatched the way `wireSessionLifecycle` did (POD-1411).
 */
const ENROLLMENT_THRESHOLD = 40

/**
 * Composition sites the audit walks. `constructor` sites are `const`-declaration
 * assemblies (the relay root). `wiring` sites assign onto a write-surface bag —
 * the shape a decomposed constructor body takes once it moves out of the class
 * and the compiler's definite-assignment analysis stops covering it.
 */
export interface CompositionSite {
  id: string
  file: string
  kind: 'constructor' | 'wiring'
  /** Class name for a `constructor` site, function name for a `wiring` site. */
  container: string
  /** Write-surface variable for a `wiring` site (e.g. `bag`). */
  bag?: string
  /**
   * Whether a thunk closing over an already-constructed local is a defect here.
   * True at the relay root, where every dependency is available eagerly and a
   * thunk hides a cycle. False where cross-aggregate edges are late-bound on
   * purpose and say so.
   */
  banDeferredClosures?: boolean
  note: string
}

export const SITES: CompositionSite[] = [
  {
    id: 'relay-root',
    file: 'apps/server/src/relay.ts',
    kind: 'constructor',
    container: 'SessionRegistry',
    banDeferredClosures: true,
    note: 'The top-level composition root.',
  },
  {
    id: 'start-server',
    file: 'apps/server/src/server.ts',
    kind: 'constructor',
    container: 'startServer',
    note: 'Process boot. Its own comments call the order load-bearing ("Order matters between these two"), and nothing was checking it.',
  },
  {
    id: 'session-store',
    file: 'apps/server/src/store.ts',
    kind: 'constructor',
    container: 'SessionStore',
    note: 'The per-aggregate repository composition. Cross-aggregate edges are late-bound lambdas by design, so only eager reads are ordered here.',
  },
  {
    id: 'session-lifecycle-wiring',
    file: 'apps/server/src/modules/sessions/session-wiring.ts',
    kind: 'wiring',
    container: 'wireSessionLifecycle',
    bag: 'bag',
    note: "SessionLifecycle's constructor body, moved out of the class (POD-1396). The `as any` write surface disables TypeScript's definite-assignment analysis, so this walk is the only thing checking its order.",
  },
]

export interface AssemblyStep {
  name: string
  dependencies: string[]
  line: number
}

export interface AssemblyAudit {
  steps: AssemblyStep[]
  propertyAssignments: { name: string; line: number }[]
  /** Wiring sites only: reads reached through a closure, which are late by design. */
  deferredReads?: number
}

function classConstructor(source: ts.SourceFile, className: string): ts.ConstructorDeclaration {
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue
    const declaration = statement.members.find(ts.isConstructorDeclaration)
    if (declaration?.body) return declaration
  }
  throw new Error(`${className} constructor not found`)
}

function hasClass(source: ts.SourceFile, name: string): boolean {
  return source.statements.some(
    (statement) => ts.isClassDeclaration(statement) && statement.name?.text === name,
  )
}

function namedFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) {
      return statement
    }
  }
  throw new Error(`${name} function not found`)
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

/** Crossing one of these means the code below runs later, not here. */
function isDeferringFunction(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node)
  )
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function collectNonNullAssertions(body: ts.Node, source: ts.SourceFile): void {
  const found: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isNonNullExpression(node)) found.push(node)
    if (ts.isVariableDeclaration(node) && node.exclamationToken) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(body)
  if (found.length > 0) {
    throw new Error(
      `composition root contains non-null late binding(s) at line(s) ${found
        .map((node) => lineOf(source, node))
        .join(', ')}`,
    )
  }
}

function auditConstructorBody(
  body: ts.Block,
  source: ts.SourceFile,
  banDeferredClosures = true,
): AssemblyAudit {
  const declarations: { name: string; node: ts.VariableDeclaration; line: number }[] = []
  const propertyWrites = new Map<string, ts.PropertyAccessExpression>()

  const visitFacts = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isThisProperty(node.left)
    ) {
      propertyWrites.set(node.left.name.text, node.left)
    }
    ts.forEachChild(node, visitFacts)
  }
  visitFacts(body)
  collectNonNullAssertions(body, source)

  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      declarations.push({
        name: declaration.name.text,
        node: declaration,
        line: lineOf(source, declaration),
      })
    }
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
    if (banDeferredClosures && deferredServiceClosures.size > 0) {
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

  const visitPropertyReads = (node: ts.Node, deferred: boolean): void => {
    if (isThisProperty(node)) {
      const write = propertyWrites.get(node.name.text)
      const isWrite =
        ts.isBinaryExpression(node.parent) &&
        node.parent.left === node &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      // A deferred read runs after the whole body, so it is only a defect where
      // thunks are banned outright; an eager one reads undefined, always.
      if (write && !isWrite && (!deferred || banDeferredClosures)) {
        if (node.getStart(source) < write.getStart(source)) {
          throw new Error(
            `this.${node.name.text} is read at line ${lineOf(source, node)} before assignment at line ${lineOf(source, write)}`,
          )
        }
      }
    }
    const nowDeferred = deferred || isDeferringFunction(node)
    ts.forEachChild(node, (child) => visitPropertyReads(child, nowDeferred))
  }
  visitPropertyReads(body, false)

  return {
    steps,
    propertyAssignments: [...propertyWrites]
      .map(([name, node]) => ({ name, line: lineOf(source, node) }))
      .sort((a, b) => a.line - b.line),
  }
}

/** `bag.foo` (and the base of `bag.foo.bar`) → `foo`; anything else → undefined. */
function bagProperty(node: ts.Node, bag: string): string | undefined {
  if (!ts.isPropertyAccessExpression(node)) return undefined
  if (!ts.isIdentifier(node.expression) || node.expression.text !== bag) return undefined
  return node.name.text
}

/**
 * Walks a wiring body. The rule is the one TypeScript applied to this code
 * before it left the class: a read evaluated AT WIRING TIME must follow its
 * assignment, while a read inside a closure is deferred and therefore fine —
 * that is the intended late-binding pattern, not a defect.
 */
function auditWiringBody(body: ts.Block, source: ts.SourceFile, bag: string): AssemblyAudit {
  collectNonNullAssertions(body, source)

  const order: { name: string; line: number; index: number }[] = []
  const assignedAt = new Map<string, number>()
  for (const statement of body.statements) {
    if (!ts.isExpressionStatement(statement)) continue
    const expression = statement.expression
    if (
      !ts.isBinaryExpression(expression) ||
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      continue
    }
    const name = bagProperty(expression.left, bag)
    if (!name || assignedAt.has(name)) continue
    assignedAt.set(name, order.length)
    order.push({ name, line: lineOf(source, expression), index: order.length })
  }

  let deferredReads = 0
  const readsIn = (node: ts.Node, position: number, self: string | undefined): Set<string> => {
    const direct = new Set<string>()
    const visit = (current: ts.Node, deferred: boolean): void => {
      if (ts.isTypeNode(current)) return
      const property = bagProperty(current, bag)
      if (property !== undefined && assignedAt.has(property)) {
        const target = assignedAt.get(property) as number
        if (deferred) deferredReads += 1
        else if (target >= position && property !== self) {
          throw new Error(
            `${bag}.${property} is read at line ${lineOf(source, current)} before its assignment at line ${order[target]?.line}`,
          )
        } else if (property !== self) direct.add(property)
      }
      const nowDeferred =
        deferred ||
        ts.isArrowFunction(current) ||
        ts.isFunctionExpression(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isGetAccessor(current)
      ts.forEachChild(current, (child) => visit(child, nowDeferred))
    }
    visit(node, false)
    return direct
  }

  const steps: AssemblyStep[] = []
  let position = 0
  for (const statement of body.statements) {
    if (!ts.isExpressionStatement(statement)) continue
    const expression = statement.expression
    const isAssignment =
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    const name = isAssignment ? bagProperty(expression.left, bag) : undefined
    if (!isAssignment || name === undefined) {
      // A bare statement still executes here, so its direct reads are checked
      // at this position even though it constructs nothing.
      readsIn(statement, position, undefined)
      continue
    }
    if (assignedAt.get(name) !== position) {
      // Re-assignment of an already-recorded name; check its reads, record nothing.
      readsIn(expression.right, position, name)
      continue
    }
    const dependencies = readsIn(expression.right, position, name)
    steps.push({
      name,
      dependencies: [...dependencies].sort(),
      line: order[position]?.line ?? lineOf(source, expression),
    })
    position += 1
  }

  return { steps, propertyAssignments: [], deferredReads }
}

export function auditConstructionSource(text: string, path = ROOT): AssemblyAudit {
  const site = SITES.find((candidate) => resolve(REPO, candidate.file) === resolve(path))
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if (site?.kind === 'wiring') {
    const fn = namedFunction(source, site.container)
    return auditWiringBody(fn.body as ts.Block, source, site.bag ?? 'bag')
  }
  const container = site?.container ?? 'SessionRegistry'
  const body = hasClass(source, container)
    ? classConstructor(source, container).body
    : namedFunction(source, container).body
  if (!body) throw new Error(`${container} has no body`)
  return auditConstructorBody(body, source, site ? (site.banDeferredClosures ?? false) : true)
}

export function auditSite(site: CompositionSite): AssemblyAudit {
  const path = resolve(REPO, site.file)
  return auditConstructionSource(readFileSync(path, 'utf8'), path)
}

export function auditServerConstruction(path = ROOT): AssemblyAudit {
  return auditConstructionSource(readFileSync(path, 'utf8'), path)
}

/**
 * The enrollment gate. A composition body only stays watched if it is on the
 * SITES list, so anything big enough to have load-bearing order must enroll.
 */
export interface UnenrolledBody {
  file: string
  container: string
  statements: number
  line: number
}

function serverSourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) serverSourceFiles(path, found)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(path)
  }
  return found
}

export function findUnenrolledBodies(threshold = ENROLLMENT_THRESHOLD): UnenrolledBody[] {
  const enrolled = new Set(SITES.map((site) => `${resolve(REPO, site.file)}::${site.container}`))
  const unenrolled: UnenrolledBody[] = []
  for (const path of serverSourceFiles(SERVER_SRC)) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const consider = (body: ts.Block | undefined, container: string, node: ts.Node): void => {
      if (!body || body.statements.length < threshold) return
      if (enrolled.has(`${path}::${container}`)) return
      unenrolled.push({
        file: relative(REPO, path),
        container,
        statements: body.statements.length,
        line: lineOf(source, node),
      })
    }
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        for (const member of node.members) {
          if (ts.isConstructorDeclaration(member)) consider(member.body, node.name.text, member)
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name) consider(node.body, node.name.text, node)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return unenrolled.sort((a, b) => b.statements - a.statements)
}

function renderSite(site: CompositionSite, audit: AssemblyAudit): string[] {
  const deferred =
    audit.deferredReads === undefined
      ? 'Deferred service closures: 0.'
      : `Deferred (closure) reads: ${audit.deferredReads}, allowed by design.`
  return [
    `## ${site.container} — \`${site.file}\``,
    '',
    site.note,
    '',
    `Verified ${site.kind === 'wiring' ? 'wiring assignments' : 'constructor declarations'}: ${audit.steps.length}. Forward dependencies: 0. ${deferred} Non-null late bindings: 0.`,
    '',
    `| Order | ${site.kind === 'wiring' ? 'Assignment' : 'Declaration'} | Earlier dependencies read at wiring time | Source line |`,
    '|---:|---|---|---:|',
    ...audit.steps.map(
      (step, index) =>
        `| ${index + 1} | \`${step.name}\` | ${
          step.dependencies.length ? step.dependencies.map((name) => `\`${name}\``).join(', ') : '—'
        } | ${step.line} |`,
    ),
    '',
    ...(audit.propertyAssignments.length > 0
      ? [
          `Field assignment order (${audit.propertyAssignments.length}); an eager read of any of these above its own line fails the audit:`,
          '',
          '| Order | Field | Source line |',
          '|---:|---|---:|',
          ...audit.propertyAssignments.map(
            (assignment, index) =>
              `| ${index + 1} | \`this.${assignment.name}\` | ${assignment.line} |`,
          ),
          '',
        ]
      : []),
  ]
}

function render(): string {
  return [
    '# Server construction order',
    '',
    '> Generated by `bun scripts/server-construction-order.ts --write`; checked without `--write`.',
    '> The audit walks initializer closures too, so a thunk that captures a later service fails.',
    `> Every constructor or function body in \`apps/server/src\` with ${ENROLLMENT_THRESHOLD}+ statements must be`,
    '> an enrolled site here, or the audit fails (POD-1411).',
    '',
    ...SITES.flatMap((site) => renderSite(site, auditSite(site))),
  ].join('\n')
}

function main(): void {
  const unenrolled = findUnenrolledBodies()
  if (unenrolled.length > 0) {
    throw new Error(
      `unwatched composition body/bodies with ${ENROLLMENT_THRESHOLD}+ statements; enroll in SITES or split:\n${unenrolled
        .map((body) => `  ${body.file}:${body.line} ${body.container} (${body.statements})`)
        .join('\n')}`,
    )
  }
  const content = render()
  if (process.argv.includes('--write')) {
    writeFileSync(OUTPUT, content)
    console.log(`wrote ${relative(REPO, OUTPUT)}`)
  } else if (!existsSync(OUTPUT) || readFileSync(OUTPUT, 'utf8') !== content) {
    throw new Error('construction-order document is missing or stale; run with --write')
  } else {
    console.log(`server construction order is topological and current across ${SITES.length} sites`)
  }
}

if (import.meta.main) main()
