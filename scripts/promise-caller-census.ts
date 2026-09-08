/**
 * POD-3672: derive promise-producing calls and follow their unawaited values to
 * permissive sinks. Run `bun scripts/promise-caller-census.ts > census.json`.
 * No callee-name list: promise detection uses the checker (including thenables
 * and unions); sink parameter types come from resolved signatures.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import ts from 'typescript'

export interface Finding {
  origin: string
  originEnd: number
  call: string
  sink: string
  kind: 'unknown/any parameter' | 'existence' | 'truthiness' | 'equality'
  expression: string
}

function promiseLike(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false
  if (type.isUnionOrIntersection()) return type.types.some((part) => promiseLike(checker, part))
  const constraint = checker.getBaseConstraintOfType(type)
  if (constraint && constraint !== type) return promiseLike(checker, constraint)
  // Awaited<T> differs from unconstrained T too; that is not evidence of a
  // declared promise. Require a callable then member as well as unwrapping.
  const then = checker.getPropertyOfType(type, 'then')
  const declaration = then?.valueDeclaration ?? then?.declarations?.[0]
  if (!then || !declaration || !checker.getTypeOfSymbolAtLocation(then, declaration).getCallSignatures().length)
    return false
  const awaited = checker.getAwaitedType(type)
  return awaited !== undefined && awaited !== type
}

export function census(program: ts.Program, root: string) {
  const checker = program.getTypeChecker()
  const files = program.getSourceFiles().filter((file) => !file.isDeclarationFile &&
    !path.relative(root, file.fileName).startsWith('..') &&
    !file.fileName.includes('/node_modules/'))
  const nodes: ts.Node[] = []
  const walk = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, walk) }
  files.forEach(walk)
  const origins = nodes.filter((node): node is ts.CallExpression =>
    ts.isCallExpression(node) && promiseLike(checker, checker.getTypeAtLocation(node)))
  const originSet = new Set(origins)
  const sources = new Map<ts.Node | ts.Symbol, Set<ts.CallExpression>>()
  const contained = new Map<ts.Node | ts.Symbol, Set<ts.CallExpression>>()
  const symbols = new Map<ts.Node, ts.Symbol | undefined>()
  const symbol = (node: ts.Node) => {
    if (!symbols.has(node)) symbols.set(node, checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(node) ? node.name : node))
    return symbols.get(node)
  }
  const rootCache = new Map<ts.Symbol, readonly ts.Symbol[]>()
  const roots = (value: ts.Symbol): readonly ts.Symbol[] => {
    let result = rootCache.get(value)
    if (!result) {
      const resolved = value.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(value) : value
      const candidates = checker.getRootSymbols(resolved)
      // Object-literal fresh symbols denote the same storage property. Generic
      // interface instantiations do not: collapsing Ref<number>.current and
      // Ref<Promise<void>>.current to Ref<T>.current invents impossible flows.
      const literalRoots = candidates.filter((candidate) => candidate.declarations?.some((declaration) =>
        ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)))
      result = literalRoots.length ? literalRoots : [resolved]
      rootCache.set(value, result)
    }
    return result
  }
  const symbolValues = (table: typeof sources, value: ts.Symbol) => {
    const result = new Set<ts.CallExpression>()
    for (const root of roots(value)) for (const origin of table.get(root) ?? []) result.add(origin)
    return result
  }
  for (const origin of origins) sources.set(origin, new Set([origin]))
  const joinInto = (table: typeof sources, key: ts.Node | ts.Symbol | undefined, values: Iterable<ts.CallExpression>): boolean => {
    if (!key) return false
    const incoming = [...values]
    if (!incoming.length) return false
    // Fresh object types and union projections have transient property symbols.
    // Fresh-literal writes and reads meet at checker-derived roots; generic slots retain their instantiated symbols.
    const keys = 'kind' in key ? [key] : roots(key)
    let changed = false
    for (const root of keys) {
      let target = table.get(root)
      if (!target) table.set(root, target = new Set())
      for (const value of incoming) if (!target.has(value)) { target.add(value); changed = true }
    }
    return changed
  }
  const join = (key: ts.Node | ts.Symbol | undefined, values: Iterable<ts.CallExpression>) => joinInto(sources, key, values)
  const nest = (key: ts.Node | ts.Symbol | undefined, values: Iterable<ts.CallExpression>) => joinInto(contained, key, values)
  const get = (node: ts.Node | undefined): Set<ts.CallExpression> => {
    if (!node || ts.isAwaitExpression(node)) return new Set()
    const result = new Set(sources.get(node))
    const sym = symbol(node)
    if (sym) for (const origin of symbolValues(sources, sym)) result.add(origin)
    return result
  }
  const nested = (node: ts.Node | undefined): Set<ts.CallExpression> => {
    if (!node) return new Set()
    // Await unwraps the outer promise, not promise-valued fields in its result.
    if (ts.isAwaitExpression(node)) return nested(node.expression)
    const result = new Set(contained.get(node))
    const sym = symbol(node)
    if (sym) for (const origin of symbolValues(contained, sym)) result.add(origin)
    return result
  }
  const deep = (node: ts.Node) => new Set([...get(node), ...nested(node)])
  const returns = new Map<ts.Node, ts.Expression[]>()
  for (const node of nodes) {
    if (!ts.isReturnStatement(node) || !node.expression) continue
    let owner: ts.Node | undefined = node.parent
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
    if (owner) returns.set(owner, [...returns.get(owner) ?? [], node.expression])
  }
  const projections: [ts.Expression, ts.Expression, boolean][] = []
  for (const node of nodes) {
    // Named properties already flow through their own symbols. Only indexed
    // projections need conservative container flow; tainting every property
    // would confuse a session's private promise queue with its plain state.
    if (!ts.isElementAccessExpression(node)) continue
    const type = checker.getTypeAtLocation(node)
    const direct = promiseLike(checker, type) || !!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
    if (direct || type.flags & ts.TypeFlags.Object) projections.push([node, node.expression, direct])
  }
  const parameterEdges: [ts.Symbol, ts.Expression][] = []
  const returnEdges: [ts.CallExpression, ts.Expression, boolean][] = []
  for (const node of nodes) {
    if (!ts.isCallExpression(node)) continue
    const declaration = checker.getResolvedSignature(node)?.getDeclaration()
    if (!declaration || declaration.getSourceFile().isDeclarationFile) continue
    const values = ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)
      ? [declaration.body] : returns.get(declaration) ?? []
    for (const value of values) returnEdges.push([node, value, originSet.has(node)])
    for (const [index, argument] of node.arguments.entries()) {
      const parameter = declaration.parameters[index]
      if (!parameter || parameter.dotDotDotToken) continue
      const target = symbol(parameter.name)
      if (target) parameterEdges.push([target, argument])
    }
  }
  // Monotone, flow-insensitive may-flow closure. Symbol identities preserve
  // aliases even after widening to unknown/any; no textual variable matching.
  // Direct await unwraps values. Containers retain their nested promises;
  // local parameter/return edges preserve flow through erased helper types.
  let changed = true
  let passes = 0
  while (changed) {
    changed = false
    passes++
    for (const [projection, base, direct] of projections) {
      if (direct) changed = join(projection, nested(base)) || changed
      else changed = nest(projection, nested(base)) || changed
    }
    for (const [target, argument] of parameterEdges) {
      changed = join(target, get(argument)) || changed
      changed = nest(target, nested(argument)) || changed
    }
    for (const [call, value, promised] of returnEdges) {
      changed = nest(call, nested(value)) || changed
      // A promised return assimilates a returned promise. A sync wrapper whose
      // type erased it to unknown/any does not, so retain that direct flow.
      if (!promised) changed = join(call, get(value)) || changed
    }
    for (const node of nodes) {
      let from: ts.Node[] = []
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
          ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) ||
          ts.isSatisfiesExpression(node)) from = [node.expression]
      if (ts.isConditionalExpression(node)) from = [node.whenTrue, node.whenFalse]
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind
        if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken].includes(op)) from = [node.left, node.right]
        if ([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
          ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(op)) {
          from = [node.right]
          changed = join(symbol(node.left), get(node.right)) || changed
          changed = nest(symbol(node.left), nested(node.right)) || changed
        }
        if (op === ts.SyntaxKind.CommaToken) from = [node.right]
      }
      if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) ||
          ts.isPropertyAssignment(node) || ts.isParameter(node)) && node.initializer) {
        changed = join(symbol(node.name), get(node.initializer)) || changed
        changed = nest(symbol(node.name), nested(node.initializer)) || changed
      }
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
        const type = checker.getTypeAtLocation(node.initializer)
        for (const binding of node.name.elements) {
          if (!ts.isIdentifier(binding.name) || binding.dotDotDotToken) continue
          const key = binding.propertyName?.getText().replace(/^['"]|['"]$/g, '') ?? binding.name.text
          const property = checker.getPropertyOfType(type, key)
          if (property) {
            changed = join(symbol(binding.name), symbolValues(sources, property)) || changed
            changed = nest(symbol(binding.name), symbolValues(contained, property)) || changed
          }
        }
      }
      if (ts.isShorthandPropertyAssignment(node)) {
        const value = checker.getShorthandAssignmentValueSymbol(node)
        if (value) {
          changed = join(symbol(node.name), symbolValues(sources, value)) || changed
          changed = nest(symbol(node.name), symbolValues(contained, value)) || changed
        }
      }
      for (const input of from) {
        changed = join(node, get(input)) || changed
        changed = nest(node, nested(input)) || changed
      }
      if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements)
          changed = nest(node, deep(ts.isSpreadElement(element) ? element.expression : element)) || changed
      }
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property)) changed = nest(node, deep(property.initializer)) || changed
          if (ts.isSpreadAssignment(property)) changed = nest(node, nested(property.expression)) || changed
          if (ts.isShorthandPropertyAssignment(property)) {
            const value = checker.getShorthandAssignmentValueSymbol(property)
            if (value) {
              changed = nest(node, symbolValues(sources, value)) || changed
              changed = nest(node, symbolValues(contained, value)) || changed
            }
          }
        }
      }
    }
  }
  const position = (node: ts.Node) => {
    const file = node.getSourceFile()
    const pos = file.getLineAndCharacterOfPosition(node.getStart())
    return `${path.relative(root, file.fileName)}:${pos.line + 1}:${pos.character + 1}`
  }
  const findings: Finding[] = []
  const emit = (node: ts.Node, kind: Finding['kind']) => {
    for (const origin of kind === 'unknown/any parameter' ? deep(node) : get(node)) findings.push({ origin: position(origin), originEnd: origin.end,
      call: origin.getText().replace(/\s+/g, ' ').slice(0, 240), sink: position(node), kind,
      expression: node.parent.getText().replace(/\s+/g, ' ').slice(0, 320) })
  }
  const absent = (node: ts.Node) => (checker.getTypeAtLocation(node).flags &
    (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0
  const permissive = (type: ts.Type): boolean => {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true
    if (type.isUnion()) return type.types.some(permissive)
    return false
  }
  for (const node of nodes) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const signature = checker.getResolvedSignature(node)
      const parameters = signature?.getParameters() ?? []
      for (const [index, argument] of (node.arguments ?? []).entries()) {
        const parameter = parameters[Math.min(index, parameters.length - 1)]
        if (!parameter) continue
        const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0]
        let type = checker.getTypeOfSymbolAtLocation(parameter, node)
        if (declaration && ts.isParameter(declaration) && declaration.dotDotDotToken) {
          type = checker.getIndexTypeOfType(type, ts.IndexKind.Number) ?? type
        }
        if (permissive(type)) emit(argument, 'unknown/any parameter')
      }
    }
    if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node))
      emit(node.expression, 'truthiness')
    if (ts.isConditionalExpression(node)) emit(node.condition, 'truthiness')
    if (ts.isForStatement(node) && node.condition) emit(node.condition, 'truthiness')
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      emit(node.operand, 'truthiness')
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind
      if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken].includes(op))
        emit(node.left, 'truthiness')
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken)
        emit(node.left, 'existence')
      if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(op)) {
        for (const [value, other] of [[node.left, node.right], [node.right, node.left]] as const) {
          if (ts.isTypeOfExpression(value) && ts.isStringLiteral(other) && other.text === 'undefined')
            emit(value.expression, 'existence')
          if (absent(other)) emit(value, 'existence')
          else if (!promiseLike(checker, checker.getTypeAtLocation(other)) && get(other).size === 0)
            emit(value, 'equality')
        }
      }
    }
  }
  return { findings, files: files.map((file) => path.relative(root, file.fileName)),
    calls: origins.map((origin) => `${position(origin)}@${origin.end}`), passes }
}

/** Discover configurations, rather than maintain a list that can omit a package. */
function configs(root: string): string[] {
  const result: string[] = []
  const ignored = new Set(['node_modules', '.git', '.worktrees', '.turbo', 'dist',
    'build', 'target', 'coverage', 'fixtures', '.expo', '.next'])
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name) || entry.name.startsWith('.')) continue
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (/^tsconfig(?:\.[\w-]+)?\.json$/.test(entry.name)) result.push(file)
    }
  }
  walk(root)
  return result.sort()
}

function loadConfig(config: string) {
  const loaded = ts.readConfigFile(config, ts.sys.readFile)
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(config))
  const errors = parsed.errors.filter((error) => error.code !== 18003)
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (name) => name, getNewLine: () => '\n',
  }))
  return parsed
}

if (import.meta.main && process.argv.includes('--worker')) {
  const request = JSON.parse(readFileSync(0, 'utf8')) as { config: string; files?: string[] }
  const parsed = loadConfig(request.config)
  const program = ts.createProgram(request.files ?? parsed.fileNames,
    { ...parsed.options, noEmit: true, allowJs: true })
  console.log(JSON.stringify(census(program, process.cwd())))
} else if (import.meta.main) {
  const root = process.cwd()
  const outputIndex = process.argv.indexOf('--output-dir')
  const outputDirectory = outputIndex < 0 ? undefined : process.argv[outputIndex + 1]
  if (outputDirectory) mkdirSync(outputDirectory, { recursive: true })
  const findings = new Map<string, Finding>()
  const files = new Set<string>()
  const calls = new Set<string>()
  const projects: { config: string; files: number; calls: number; passes: number }[] = []
  const run = (config: string, extra?: string[]) => {
    console.error(`census: ${path.relative(root, config)}${extra ? ' (uncovered tracked sources)' : ''}`)
    // One compiler process at a time: release all memory before the next project.
    const result = JSON.parse(execFileSync(process.execPath, [import.meta.path, '--worker'], {
      input: JSON.stringify({ config, files: extra }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })) as ReturnType<typeof census>
    if (outputDirectory) writeFileSync(path.join(outputDirectory, `${projects.length}.json`), JSON.stringify({ config: path.relative(root, config), ...result }, null, 2))
    result.findings.forEach((finding) => findings.set(`${finding.origin}@${finding.originEnd}|${finding.sink}|${finding.kind}`, finding))
    result.files.forEach((file) => files.add(file))
    result.calls.forEach((call) => calls.add(call))
    projects.push({ config: path.relative(root, config), files: result.files.length, calls: result.calls.length, passes: result.passes })
    console.error(`  ${result.files.length} files, ${result.calls.length} promise calls, ${result.findings.length} edges, ${result.passes} flow passes`)
  }
  for (const config of configs(root)) {
    if (loadConfig(config).fileNames.length) run(config)
  }
  // Config discovery alone misses standalone scripts and E2E sources. Derive
  // the remainder from tracked source files and scan with the scripts options.
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file))
  const uncovered = tracked.filter((file) => !files.has(file))
  if (uncovered.length) run(path.join(root, 'scripts/tsconfig.json'), uncovered.map((file) => path.join(root, file)))
  const sorted = [...findings.values()].sort((a, b) => a.origin.localeCompare(b.origin) || a.sink.localeCompare(b.sink))
  console.log(JSON.stringify({ projects, files: files.size, trackedSources: tracked.length,
    initiallyUncovered: uncovered, uncovered: tracked.filter((file) => !files.has(file)), promiseCalls: calls.size,
    candidateCalls: new Set(sorted.map((finding) => `${finding.origin}@${finding.originEnd}`)).size,
    sinkEdges: sorted.length, findings: sorted }, null, 2))
}
