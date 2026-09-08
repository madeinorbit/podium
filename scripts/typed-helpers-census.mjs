// POD-3666: type-derived inventory of promise-returning helpers.
// Origin: POD-3662 artifact 4 (syntax-checked only; the graph was never executed).
//
//   NODE_OPTIONS='--max-old-space-size=8192' node scripts/typed-helpers-census.mjs \
//     --root /absolute/checkout --out /absolute/result.json
//
// Default Node heap OOMs around 2 GB while building the boundary import graph.
// One crash fix versus the artifact: NewExpression constructor text is
// `child.expression.getText()`, not `child.expression.expression.getText()`.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const args = process.argv.slice(2)
const argument = (name) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Required ${name}`); return args[i + 1] }
const root = path.resolve(argument('--root'))
const output = path.resolve(argument('--out'))
const require = createRequire(path.join(root, 'package.json'))
const ts = require('typescript')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'apps/server/test-shards.json'), 'utf8'))
const roots = manifest.shards.find(s => s.id === 'boundary')?.testFiles
if (!roots?.length) throw new Error('Empty boundary manifest')
const cfgPath = path.join(root, 'apps/server/tsconfig.json')
const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile)
if (cfg.error) throw new Error(ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n'))
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(cfgPath), {}, cfgPath)
if (parsed.errors.length) throw new Error(parsed.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n'))
const program = ts.createProgram(roots.map(f => path.join(root, f)), { ...parsed.options, noEmit: true })
const checker = program.getTypeChecker()
const sourceFiles = program.getSourceFiles().filter(f => !f.isDeclarationFile && f.fileName.startsWith(root + path.sep) && !f.fileName.includes('/node_modules/'))
const testRoots = new Set(roots)
const rel = f => path.relative(root, f.fileName).split(path.sep).join('/')
const at = n => { const sf = n.getSourceFile(); const lc = sf.getLineAndCharacterOfPosition(n.getStart(sf)); return { file: rel(sf), line: lc.line + 1, column: lc.character + 1, offset: n.getStart(sf) } }
const id = n => { const p = at(n); return `${p.file}:${p.offset}` }
const summary = t => checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation)
const promiseType = t => {
  if (t.isUnionOrIntersection()) return t.types.some(promiseType)
  const then = t.getProperty('then')
  if (!then) return false
  const d = then.valueDeclaration ?? then.declarations?.[0]
  if (!d) return false
  return checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(then, d), ts.SignatureKind.Call).length > 0
}
const uncertainType = t => Boolean(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) || (t.isUnionOrIntersection() && t.types.some(uncertainType))
const named = n => {
  if (n.name) return n.name.getText()
  const p = n.parent
  if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return p.name.getText()
  return '<anonymous callback>'
}
const isBodyFunction = n => (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n)) && n.body
const scanOwnBody = (fn, callback) => {
  const visit = n => { if (n !== fn.body && isBodyFunction(n)) return; callback(n); ts.forEachChild(n, visit) }
  visit(fn.body)
}
const inventory = [], unknownReturns = [], declarations = new Map(), noSignature = []
for (const sf of sourceFiles) {
  const visit = n => {
    if (isBodyFunction(n)) {
      const signature = checker.getSignatureFromDeclaration(n)
      if (!signature) noSignature.push(at(n))
      else {
        const type = checker.getReturnTypeOfSignature(signature)
        const base = { id: id(n), ...at(n), name: named(n), async: Boolean(n.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)), surface: testRoots.has(rel(sf)) ? 'boundary-test' : 'reachable-source', returnType: summary(type), anonymous: named(n) === '<anonymous callback>' }
        if (uncertainType(type)) unknownReturns.push(base)
        if (promiseType(type)) {
          const returns = [], calls = [], promiseConstructors = []
          scanOwnBody(n, child => {
            if (ts.isReturnStatement(child) && child.expression) returns.push({ ...at(child), expression: child.expression.getText() })
            if (ts.isNewExpression(child)) {
              let isPromise = false
              try { isPromise = promiseType(checker.getTypeAtLocation(child)) } catch {}
              if (isPromise) promiseConstructors.push({ ...at(child), expression: child.expression.getText() })
            }
            if (ts.isCallExpression(child)) {
              const sig = checker.getResolvedSignature(child)
              calls.push({ ...at(child), expression: child.expression.getText(), declaration: sig?.declaration ? id(sig.declaration) : null })
            }
          })
          if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) returns.push({ ...at(n.body), expression: n.body.getText() })
          const row = { ...base, returns, calls, promiseConstructors }
          inventory.push(row); declarations.set(row.id, row)
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}
// Derive all awaited calls, not only names matching capture/reply/dispatch.
const awaitSites = [], unresolvedAwaitCalls = []
for (const sf of sourceFiles) {
  const visit = n => {
    if (ts.isAwaitExpression(n)) {
      let expr = n.expression
      while (ts.isParenthesizedExpression(expr)) expr = expr.expression
      if (ts.isCallExpression(expr)) {
        const sig = checker.getResolvedSignature(expr), decl = sig?.declaration
        let statement = n
        while (statement.parent && !ts.isStatement(statement)) statement = statement.parent
        const block = statement.parent
        const siblings = block && 'statements' in block ? [...block.statements] : []
        const index = siblings.indexOf(statement)
        const row = { ...at(n), expression: expr.getText(), declaration: decl ? id(decl) : null, returnType: sig ? summary(checker.getReturnTypeOfSignature(sig)) : null, statement: statement.getText(), followingStatements: index < 0 ? [] : siblings.slice(index + 1).map(s => ({ ...at(s), text: s.getText() })) }
        awaitSites.push(row)
        if (!sig || uncertainType(checker.getReturnTypeOfSignature(sig))) unresolvedAwaitCalls.push(row)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}
// A review worklist, NOT an automatic proof of deadlock: direct Promise construction
// or transitive calls into it may create an externally resolved promise, or an ordinary timer.
const reachesConstruction = new Set(inventory.filter(h => h.promiseConstructors.length).map(h => h.id))
let changed = true
while (changed) { changed = false; for (const h of inventory) if (!reachesConstruction.has(h.id) && h.calls.some(c => reachesConstruction.has(c.declaration))) { reachesConstruction.add(h.id); changed = true } }
const reviewSites = awaitSites.filter(s => reachesConstruction.has(s.declaration))
const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const counts = {
  boundaryManifestFiles: roots.length, reachableSourceFiles: sourceFiles.length,
  promiseReturningFunctionsIncludingCallbacks: inventory.length,
  namedPromiseHelpers: inventory.filter(h => !h.anonymous).length,
  namedNonAsyncPromiseHelpers: inventory.filter(h => !h.anonymous && !h.async).length,
  namedBoundaryTestPromiseHelpers: inventory.filter(h => !h.anonymous && h.surface === 'boundary-test').length,
  namedReachablePromiseHelpers: inventory.filter(h => !h.anonymous && h.surface === 'reachable-source').length,
  unknownReturnTypes: unknownReturns.length, missingSignatures: noSignature.length,
  awaitedCalls: awaitSites.length, unresolvedAwaitCalls: unresolvedAwaitCalls.length,
  constructorReachableAwaitReviewSites: reviewSites.length,
}
const result = { sha, root, typescript: ts.version, scope: 'Boundary manifest roots plus non-declaration repository source in their TS import closure. Anonymous callbacks enumerated separately from named helpers. No semantic diagnostics or emit requested.', counts, rootFiles: roots, sourceFiles: sourceFiles.map(rel), inventory, unknownReturns, noSignature, awaitSites, unresolvedAwaitCalls, reviewSites, caveat: 'Type-derived inventory and syntactic call edges are review inputs, not a deadlock detector. Opaque ports, unresolved/generic types, callbacks, dynamic dispatch, and returned-promise aliases require review; zero reviewSites must never be reported as class closure.' }
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ sha, output, counts }, null, 2))
