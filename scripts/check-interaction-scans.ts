/** Source-only interaction census. No Program, inherited ignores, or baseline writer.
 * Every acquisition and downstream collection operation is an independent entry;
 * REQUIRED REPAIR is debt, not evidence that the operation has been repaired.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix, relative } from 'node:path'
import ts from 'typescript'

export const INTERACTION_ROOTS = [
  'apps/web/src', 'apps/mobile/src', 'apps/mobile/app',
  'packages/client-graph/src', 'packages/client-core/src',
] as const
export const MANIFEST = 'scripts/interaction-scan-census.json'
const DOMAIN = /(?:issue|session|lane|worktree|transcript|message|record|tab)s?/i
const COLLECTION = /^(?:all|known|resident).*(?:issue|session|lane|worktree|transcript|message|record|tab)|^(?:issues|sessions|lanes|worktrees|transcripts|messages|records|tabs)$/i
const CONSUMERS = new Set(['find', 'findIndex', 'filter', 'some', 'every', 'reduce', 'reduceRight', 'sort', 'toSorted', 'map', 'flatMap', 'forEach'])
// These return an addressed answer, a scalar, or an explicitly capped window.
// Other literal questions (including boardIssues) and unknown/dynamic questions
// remain acquisitions: an indexed identity list is still collection work.
const ADDRESSED = new Set(['issueMentionMatches', 'mobileIssueTargets', 'headerRecentSession', 'sessionReference', 'commandIssueSessions', 'containingIssues', 'spawnIssues'])
const SCALARS = new Set(['count', 'counts', 'activity', 'has', 'contains', 'revision', 'readerRevision', 'readerContains', 'linkedIssueId', 'nextSession', 'row', 'get', 'session', 'issue'])

type Fn = ts.FunctionLikeDeclaration & { body: ts.ConciseBody }
type Scope = { parent?: Scope; bindings: Map<string, Binding>; fn?: Fn }
type Binding = { node: ts.Node; init?: ts.Expression; path?: string[]; imported?: { file: string; name: string }; namespace?: string }
type Origin = { file: string; holder: string; rule: string; tokens: string; gate: string[] }
type Value = { origins: Set<string>; fields: Map<string, Value>; callable?: Fn; closure?: Context; literal?: ts.Expression }
type Context = Map<ts.Node, Value>
export type Scan = Origin & { fingerprint: string; origin: string[]; count: number; lines: number[] }
export type Classification = 'ingest' | 'visible output' | 'bounded local work' | 'REQUIRED REPAIR'
export type CensusEntry = Omit<Scan, 'lines'> & {
  classification: Classification; owner: string; trigger: string; bound: string; reason: string; guard: string
}
export type Census = { version: 1; roots: string[]; entries: CensusEntry[] }
const empty = (): Value => ({ origins: new Set(), fields: new Map() })
function merge(...values: Value[]): Value {
  const out = empty()
  for (const value of values) {
    for (const origin of value.origins) out.origins.add(origin)
    for (const [key, field] of value.fields) out.fields.set(key, merge(out.fields.get(key) ?? empty(), field))
    if (value.callable) { out.callable = value.callable; out.closure = value.closure }
    if (value.literal) out.literal = value.literal
  }
  return out
}
function origins(value: Value): Set<string> {
  return new Set([...value.origins, ...[...value.fields.values()].flatMap(v => [...origins(v)])])
}
function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression
  return node
}
function name(node: ts.Node | undefined): string {
  if (!node) return ''
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ? node.text : ''
}
function access(node: ts.Expression): { base: ts.Expression; key: string } | undefined {
  node = unwrap(node)
  if (ts.isPropertyAccessExpression(node)) return { base: node.expression, key: node.name.text }
  if (ts.isElementAccessExpression(node)) return { base: node.expression, key: name(node.argumentExpression) }
  return undefined
}
/** Token tuples retain literal values and predicates; comments/positions vanish. */
export function normalized(node: ts.Node): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, node.getText())
  const tokens: [number, string][] = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push([token, scanner.getTokenValue() || scanner.getTokenText()])
  }
  return JSON.stringify(tokens)
}
function holder(node: ts.Node): string {
  const names: string[] = []
  for (let at: ts.Node | undefined = node; at && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isFunctionLike(at) || ts.isClassDeclaration(at) || ts.isVariableDeclaration(at) || ts.isPropertyAssignment(at)) {
      const label = 'name' in at ? name(at.name as ts.Node) : ''
      if (label) names.unshift(label)
      else if (ts.isFunctionLike(at)) {
        const parent = at.parent
        if (ts.isCallExpression(parent)) names.unshift(`${name(parent.expression) || access(parent.expression)?.key || 'call'}:callback`)
        else names.unshift('callback')
      }
    }
  }
  return names.join('/') || '<module>'
}
function exits(node: ts.Node): boolean {
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true
  return ts.isBlock(node) && !!node.statements.length && exits(node.statements[node.statements.length - 1]!)
}
/** Gates include branch polarity, loop bounds, switches, and preceding exits.
 * This deliberately prefers review noise over treating removal of a gate as safe.
 */
function gates(node: ts.Node): string[] {
  const out: string[] = []
  for (let child = node, parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isConditionalExpression(parent)) out.unshift(`${child === parent.whenFalse ? 'else' : 'then'}:${normalized(parent.condition)}`)
    if (ts.isIfStatement(parent) && child !== parent.expression) out.unshift(`${child === parent.elseStatement ? 'else' : 'then'}:${normalized(parent.expression)}`)
    if (ts.isBinaryExpression(parent) && child === parent.right && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) out.unshift(`${parent.operatorToken.getText()}:${normalized(parent.left)}`)
    if (ts.isCaseClause(parent)) out.unshift(`case:${normalized(parent.expression)}`)
    if (ts.isDefaultClause(parent)) out.unshift('default')
    if (ts.isSwitchStatement(parent)) out.unshift(`switch:${normalized(parent.expression)}`)
    if (ts.isForStatement(parent) && parent.condition) out.unshift(`loop:${normalized(parent.condition)}`)
    if (ts.isWhileStatement(parent) || ts.isDoStatement(parent)) out.unshift(`loop:${normalized(parent.expression)}`)
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      for (const statement of parent.statements) {
        if (statement === child || statement.end > child.pos) break
        if (ts.isIfStatement(statement) && (exits(statement.thenStatement) || (statement.elseStatement && exits(statement.elseStatement)))) out.unshift(`exit:${normalized(statement)}`)
      }
    }
  }
  return out
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity = (hit: Omit<Scan, 'fingerprint' | 'count' | 'lines'>) => hash(hit)

export function productionFiles(root: string): string[] {
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlink in production root: ${relative(root, path)}`)
    return entry.isDirectory() ? walk(path) : /\.tsx?$/.test(path) && !/\.(?:test|spec)\./.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [path] : []
  })
  return INTERACTION_ROOTS.flatMap(directory => {
    const path = join(root, directory)
    if (!existsSync(path)) throw new Error(`Missing production root: ${directory}`)
    return walk(path)
  }).sort()
}

/** Lexical bindings, lazy helper returns and import/re-export resolution. Context
 * substitution lets generic helpers carry taint without tainting an unrelated
 * same-name local. No compiler type checker or whole-repository Program exists.
 */
export function scanSources(sources: Record<string, string>): Scan[] {
  const files = new Map(Object.entries(sources).map(([file, text]) => [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)]))
  const scopes = new Map<ts.Node, Scope>()
  const fileScopes = new Map<string, Scope>()
  const exports = new Map<string, Map<string, Binding>>()
  const stars = new Map<string, string[]>()
  const bindings: Binding[] = []
  const functions: Fn[] = []
  const candidates: ts.Node[] = []
  const resolveModule = (from: string, module: string): string | undefined => {
    let base = module.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), module)) : module.replace(/^@podium\/(client-core|client-graph)(?:\/|$)/, 'packages/$1/src/')
    if (base.endsWith('/')) base += 'index'
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base.replace(/\.js$/, '.ts')]) if (files.has(candidate)) return candidate
    return undefined
  }
  const declare = (pattern: ts.BindingName, node: ts.Node, scope: Scope, init?: ts.Expression, path: string[] = []): void => {
    if (ts.isIdentifier(pattern)) {
      const binding: Binding = { node, init, path }
      scope.bindings.set(pattern.text, binding); bindings.push(binding)
    } else for (const element of pattern.elements) if (ts.isBindingElement(element)) {
      declare(element.name, element, scope, init, [...path, name(element.propertyName ?? element.name) || String(pattern.elements.indexOf(element))])
    }
  }
  for (const [file, ast] of files) {
    const root: Scope = { bindings: new Map() }
    fileScopes.set(file, root); exports.set(file, new Map()); stars.set(file, [])
    const build = (node: ts.Node, scope: Scope): void => {
      scopes.set(node, scope)
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const target = resolveModule(file, node.moduleSpecifier.text)
        if (target && node.importClause) {
          const named = node.importClause.namedBindings
          if (named && ts.isNamedImports(named)) for (const element of named.elements) scope.bindings.set(element.name.text, { node: element, imported: { file: target, name: (element.propertyName ?? element.name).text } })
          if (named && ts.isNamespaceImport(named)) scope.bindings.set(named.name.text, { node: named, namespace: target })
          if (node.importClause.name) scope.bindings.set(node.importClause.name.text, { node: node.importClause, imported: { file: target, name: 'default' } })
        }
      }
      if (ts.isExportDeclaration(node)) {
        const target = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? resolveModule(file, node.moduleSpecifier.text) : file
        if (target && node.exportClause && ts.isNamedExports(node.exportClause)) for (const element of node.exportClause.elements) exports.get(file)!.set(element.name.text, { node: element, imported: { file: target, name: (element.propertyName ?? element.name).text } })
        if (target && !node.exportClause) stars.get(file)!.push(target)
      }
      if (ts.isVariableDeclaration(node)) {
        let target = scope
        // var belongs to the containing function/module; let/const to its block.
        if (ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped)) while (target.parent && !target.fn) target = target.parent
        declare(node.name, node, target, node.initializer)
      }
      if (ts.isFunctionDeclaration(node) && node.name) scope.bindings.set(node.name.text, { node })
      if (ts.isClassDeclaration(node) && node.name) scope.bindings.set(node.name.text, { node })
      let inner = scope
      if ((ts.isFunctionLike(node) && 'body' in node && node.body) || ts.isBlock(node) || ts.isCatchClause(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
        inner = { parent: scope, bindings: new Map(), fn: ts.isFunctionLike(node) ? node as Fn : undefined }
        if (ts.isFunctionLike(node) && 'body' in node && node.body) {
          functions.push(node as Fn)
          for (const parameter of node.parameters) declare(parameter.name, parameter, inner, parameter.initializer)
          if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name) inner.bindings.set(node.name.text, { node })
        }
        if (ts.isCatchClause(node) && node.variableDeclaration) declare(node.variableDeclaration.name, node.variableDeclaration, inner)
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isSpreadElement(node) || ts.isSpreadAssignment(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) candidates.push(node)
      ts.forEachChild(node, child => build(child, inner))
    }
    build(ast, root)
    for (const statement of ast.statements) {
      if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const isDefault = ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) exports.get(file)!.set(declaration.name.text, root.bindings.get(declaration.name.text)!)
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) exports.get(file)!.set(isDefault ? 'default' : statement.name.text, root.bindings.get(statement.name.text)!)
      }
      if (ts.isExportAssignment(statement)) exports.get(file)!.set('default', { node: statement, init: statement.expression })
    }
  }
  const lookup = (node: ts.Node, key: string): Binding | undefined => {
    for (let scope = scopes.get(node); scope; scope = scope.parent) { const binding = scope.bindings.get(key); if (binding) return binding }
    return undefined
  }
  const exported = (file: string, key: string, seen = new Set<string>()): Binding | undefined => {
    if (seen.has(`${file}:${key}`)) return undefined
    seen.add(`${file}:${key}`)
    const binding = exports.get(file)?.get(key) ?? fileScopes.get(file)?.bindings.get(key)
    if (binding?.imported) return exported(binding.imported.file, binding.imported.name, seen)
    if (binding) return binding
    for (const target of stars.get(file) ?? []) { const found = exported(target, key, seen); if (found) return found }
    return undefined
  }
  const originDetails = new Map<string, Origin>()
  const hits = new Map<string, Scan>()
  const emitted = new Set<string>()
  const acquisition = (node: ts.Node, rule: string): Value => {
    const detail = { file: node.getSourceFile().fileName, holder: holder(node), rule, tokens: normalized(node), gate: gates(node) }
    const key = hash(detail)
    originDetails.set(key, detail)
    record(node, rule, [key])
    return { ...empty(), origins: new Set([key]) }
  }
  const record = (node: ts.Node, rule: string, taint: Iterable<string>): void => {
    const origin = [...taint].filter(id => originDetails.has(id)).sort()
    if (!origin.length) return
    const detail = { file: node.getSourceFile().fileName, holder: holder(node), rule, tokens: normalized(node), gate: gates(node), origin }
    const fingerprint = identity(detail)
    const occurrence = `${fingerprint}:${node.pos}:${node.end}`
    if (emitted.has(occurrence)) return
    emitted.add(occurrence)
    const line = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1
    const old = hits.get(fingerprint)
    if (old) { old.count++; old.lines.push(line) } else hits.set(fingerprint, { ...detail, fingerprint, count: 1, lines: [line] })
  }
  const busy = new Set<ts.Node>()
  const bindingBusy = new Set<Binding>()
  const memo = new Map<ts.Node, Value>()
  const evalBinding = (binding: Binding | undefined, context: Context): Value => {
    if (!binding) return empty()
    const supplied = context.get(binding.node)
    if (supplied) return supplied
    if (bindingBusy.has(binding)) return empty()
    bindingBusy.add(binding)
    let value: Value
    if (binding.imported) value = evalBinding(exported(binding.imported.file, binding.imported.name), context)
    else if (binding.init) value = evaluate(binding.init, context)
    else if (ts.isFunctionLike(binding.node) && 'body' in binding.node && binding.node.body) value = { ...empty(), callable: binding.node as Fn, closure: context }
    else if (ts.isParameter(binding.node) && (COLLECTION.test(binding.node.name.getText()) || (binding.node.type && DOMAIN.test(binding.node.type.getText()) && /(?:\[\]|Array|Map|Set|Record)/.test(binding.node.type.getText())))) value = acquisition(binding.node, 'collection-input')
    else value = empty()
    for (const key of binding.path ?? []) value = value.fields.get(key) ?? { ...value, callable: undefined }
    bindingBusy.delete(binding)
    return value
  }
  const invoke = (value: Value, args: Value[], context: Context): Value => {
    const fn = value.callable
    if (!fn || busy.has(fn)) return empty()
    busy.add(fn)
    const next = new Map(value.closure ?? context)
    fn.parameters.forEach((parameter, index) => {
      const supplied = args[index] ?? (parameter.initializer ? evaluate(parameter.initializer, context) : empty())
      if (ts.isIdentifier(parameter.name)) next.set(parameter, supplied)
      else {
        const bind = (pattern: ts.BindingName, data: Value): void => {
          if (ts.isIdentifier(pattern)) return
          for (const element of pattern.elements) if (ts.isBindingElement(element)) {
            const field = data.fields.get(name(element.propertyName ?? element.name)) ?? data
            next.set(element, field); bind(element.name, field)
          }
        }
        bind(parameter.name, supplied)
      }
    })
    const returned: Value[] = []
    if (!ts.isBlock(fn.body)) returned.push(evaluate(fn.body, next))
    else {
      const visit = (node: ts.Node): void => {
        if (node !== fn.body && ts.isFunctionLike(node)) return
        if (ts.isReturnStatement(node) && node.expression) returned.push(evaluate(node.expression, next))
        ts.forEachChild(node, visit)
      }
      visit(fn.body)
    }
    busy.delete(fn)
    return merge(...returned)
  }
  const evaluate = (raw: ts.Expression, context: Context = new Map()): Value => {
    const node = unwrap(raw)
    if (!context.size && memo.has(node)) return memo.get(node)!
    let value = empty()
    if (ts.isIdentifier(node)) value = evalBinding(lookup(node, node.text), context)
    else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) value = { ...empty(), callable: node as Fn, closure: context }
    else if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) value.literal = node
    else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) value.fields.set(name(property.name), evaluate(property.initializer, context))
        if (ts.isShorthandPropertyAssignment(property)) value.fields.set(property.name.text, evaluate(property.name, context))
        if (ts.isMethodDeclaration(property) && property.body) value.fields.set(name(property.name), { ...empty(), callable: property as Fn, closure: context })
        if (ts.isSpreadAssignment(property)) value = merge(value, evaluate(property.expression, context))
      }
      value.literal = node
    } else if (ts.isArrayLiteralExpression(node)) value = merge(...node.elements.map(element => ts.isSpreadElement(element) ? evaluate(element.expression, context) : evaluate(element as ts.Expression, context)))
    else if (ts.isConditionalExpression(node)) value = merge(evaluate(node.whenTrue, context), evaluate(node.whenFalse, context))
    else if (ts.isBinaryExpression(node)) {
      value = merge(evaluate(node.left, context), evaluate(node.right, context))
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const binding = lookup(node.left, node.left.text)
        if (binding) context.set(binding.node, evaluate(node.right, context))
      }
    } else if (ts.isAwaitExpression(node)) value = evaluate(node.expression, context)
    else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const field = access(node)!
      const base = evaluate(field.base, context)
      const namespace = ts.isIdentifier(field.base) ? lookup(field.base, field.base.text)?.namespace : undefined
      if (namespace) value = evalBinding(exported(namespace, field.key), context)
      else if (base.fields.has(field.key)) value = base.fields.get(field.key)!
      else if (['length', 'size'].includes(field.key)) value = empty()
      else if (COLLECTION.test(field.key) && !base.origins.size) value = acquisition(node, 'collection-property')
      else if (field.key && SCALARS.has(field.key)) value = empty()
      else value = { ...base, callable: undefined }
      // tables[entity] and store rows remain broad even for a dynamic entity.
      const parentAccess = access(field.base)
      if (parentAccess && ['tables', 'collections', 'store'].includes(parentAccess.key)) value = acquisition(node, 'table-property')
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const field = access(node.expression)
      const method = field?.key ?? name(node.expression)
      const receiver = field ? evaluate(field.base, context) : empty()
      const callee = evaluate(node.expression, context)
      const args = [...node.arguments ?? []].map(argument => ts.isSpreadElement(argument) ? evaluate(argument.expression, context) : evaluate(argument, context))
      const question = args[0]?.literal
      const kindProperty = question && ts.isObjectLiteralExpression(question) ? question.properties.find(p => ts.isPropertyAssignment(p) && name(p.name) === 'kind') as ts.PropertyAssignment | undefined : undefined
      const kindValue = kindProperty ? evaluate(kindProperty.initializer, context).literal : undefined
      const kind = kindValue ? name(kindValue) : ''
      if (['ids', 'readerIds', 'queryIds'].includes(method) && !ADDRESSED.has(kind)) value = acquisition(node, kind ? `question:${kind}` : 'dynamic-question')
      else if (['issues', 'sessions'].includes(method) && !node.arguments?.length && (field || !callee.callable)) value = acquisition(node, `zero-arg:${method}`)
      else if (/^(?:all|known|resident)/i.test(method) && DOMAIN.test(method) && !callee.callable) value = acquisition(node, `enumerator:${method}`)
      else if (['keys', 'values', 'entries', 'forEach'].includes(method) && origins(receiver).size) value = merge(acquisition(node, `enumerate:${method}`), receiver)
      else if (field && ts.isIdentifier(field.base) && field.base.text === 'Object' && !lookup(field.base, 'Object') && ['keys', 'values', 'entries'].includes(method) && args[0] && origins(args[0]).size) value = merge(acquisition(node, `enumerate:Object.${method}`), args[0])
      else if (SCALARS.has(method) || (['ids', 'readerIds', 'queryIds'].includes(method) && ADDRESSED.has(kind))) value = empty()
      else if (callee.callable) value = invoke(callee, args, context)
      else if (method === 'useCallback') value = args[0] ?? empty()
      else if (method === 'slice' && args[0]?.literal && ts.isNumericLiteral(args[0].literal) && args[1]?.literal && ts.isNumericLiteral(args[1].literal)) {
        // The scan being sliced is still recorded; a numeric window is bounded.
        record(node, 'bounded-window', origins(receiver)); value = empty()
      } else {
        const callbackResults = args.filter(argument => argument.callable).map(argument => invoke(argument, [], context))
        value = merge(receiver, ...args, ...callbackResults)
      }
      const taint = origins(receiver)
      if (CONSUMERS.has(method)) record(node, `consume:${method}`, taint)
      if ((ts.isNewExpression(node) && ['Map', 'Set'].includes(method) && !lookup(node.expression, method)) || (field?.key === 'from' && ts.isIdentifier(field.base) && field.base.text === 'Array' && !lookup(field.base, 'Array'))) record(node, `materialize:${method}`, args[0] ? origins(args[0]) : [])
      if (!CONSUMERS.has(method) && !SCALARS.has(method)) for (const argument of args) record(node, 'forward-collection', origins(argument))
      if (['find', 'findIndex', 'some', 'every', 'reduce', 'reduceRight'].includes(method)) value = empty()
    }
    if (!context.size) memo.set(node, value)
    return value
  }
  // Visit all candidates, not only expressions reachable from exported returns.
  for (const node of candidates) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) evaluate(node)
    else if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) record(node, 'spread', origins(evaluate(node.expression)))
    else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) record(node, ts.isForOfStatement(node) ? 'loop:for-of' : 'loop:for-in', origins(evaluate(node.expression)))
    else {
      const parts: Value[] = []
      const walk = (child: ts.Node): void => {
        if (child !== node && (ts.isBlock(child) || ts.isFunctionLike(child))) return
        if (ts.isIdentifier(child) || ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) parts.push(evaluate(child as ts.Expression))
        ts.forEachChild(child, walk)
      }
      walk(node); record(node, 'loop', origins(merge(...parts)))
    }
  }
  return [...hits.values()].sort((a, b) => a.file.localeCompare(b.file) || a.holder.localeCompare(b.holder) || a.fingerprint.localeCompare(b.fingerprint))
}

export function scanRepository(root = process.cwd()): Scan[] {
  return scanSources(Object.fromEntries(productionFiles(root).map(path => [relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8')])))
}
function sameKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === keys.sort().join(',')
}
export function checkCensus(scans: Scan[], manifest: unknown): string[] {
  const errors: string[] = []
  if (!manifest || typeof manifest !== 'object' || !sameKeys(manifest, ['version', 'roots', 'entries'])) return ['Malformed census envelope']
  const census = manifest as Census
  if (census.version !== 1 || !Array.isArray(census.roots) || JSON.stringify(census.roots) !== JSON.stringify(INTERACTION_ROOTS) || !Array.isArray(census.entries)) return ['Malformed census version/roots/entries']
  const actual = new Map(scans.map(scan => [scan.fingerprint, scan]))
  const seen = new Set<string>()
  for (const [index, entry] of census.entries.entries()) {
    const label = `Census entry ${index + 1}`
    if (!entry || typeof entry !== 'object' || !sameKeys(entry, ['fingerprint', 'file', 'holder', 'rule', 'tokens', 'gate', 'origin', 'count', 'classification', 'owner', 'trigger', 'bound', 'reason', 'guard'])) { errors.push(`${label}: malformed fields`); continue }
    if (!['ingest', 'visible output', 'bounded local work', 'REQUIRED REPAIR'].includes(entry.classification) || !/^POD-\d+$/.test(entry.owner) || !['file', 'holder', 'rule', 'tokens', 'trigger', 'bound', 'reason', 'guard'].every(field => typeof entry[field as keyof CensusEntry] === 'string' && String(entry[field as keyof CensusEntry]).trim().length > 0) || !Number.isSafeInteger(entry.count) || entry.count < 1 || !Array.isArray(entry.gate) || !entry.gate.every(gate => typeof gate === 'string') || !Array.isArray(entry.origin) || !entry.origin.length || !entry.origin.every(origin => /^[a-f0-9]{64}$/.test(origin)) || new Set(entry.origin).size !== entry.origin.length || JSON.stringify(entry.origin) !== JSON.stringify([...entry.origin].sort()) || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) { errors.push(`${label}: malformed metadata`); continue }
    if (!INTERACTION_ROOTS.some(root => entry.file.startsWith(`${root}/`)) || entry.file.includes('..') || entry.file.includes('*')) errors.push(`${label}: invalid production file`)
    const detail = { file: entry.file, holder: entry.holder, rule: entry.rule, tokens: entry.tokens, gate: entry.gate, origin: entry.origin }
    if (identity(detail) !== entry.fingerprint) errors.push(`${label}: fingerprint does not match evidence`)
    if (seen.has(entry.fingerprint)) errors.push(`${label}: duplicate fingerprint ${entry.fingerprint}`)
    seen.add(entry.fingerprint)
    const scan = actual.get(entry.fingerprint)
    if (!scan) errors.push(`${entry.file} ${entry.holder} ${entry.rule}: stale census entry ${entry.fingerprint}`)
    else if (scan.count !== entry.count) errors.push(`${entry.file}:${scan.lines.join(',')} ${entry.holder} ${entry.rule}: multiplicity ${scan.count}, expected ${entry.count}`)
  }
  for (const scan of scans) if (!seen.has(scan.fingerprint)) errors.push(`${scan.file}:${scan.lines.join(',')} ${scan.holder} ${scan.rule}: NEW/CHANGED scan ${scan.fingerprint}`)
  return errors
}
if (import.meta.main) {
  try {
    const argv = process.argv.slice(2)
    if (argv.some(arg => !['--report', '--json'].includes(arg))) throw new Error('Only --report/--json supported; no baseline acceptance command')
    const scans = scanRepository()
    if (argv.includes('--report')) console.log(JSON.stringify(scans, null, 2))
    else {
      const census: unknown = JSON.parse(readFileSync(join(process.cwd(), MANIFEST), 'utf8'))
      const errors = checkCensus(scans, census)
      if (argv.includes('--json')) console.log(JSON.stringify({ scans, errors }, null, 2))
      else {
        for (const error of errors) console.error(error)
        const repair = (census as Census).entries?.filter(entry => entry.classification === 'REQUIRED REPAIR') ?? []
        console.log(`Interaction scan census: ${scans.length} fingerprints, ${scans.reduce((sum, scan) => sum + scan.count, 0)} occurrences; ${repair.length} REQUIRED REPAIR entries remain (not fixes); ${errors.length} ratchet errors`)
      }
      if (errors.length) process.exitCode = 1
    }
  } catch (error) { console.error(String(error)); process.exitCode = 1 }
}
