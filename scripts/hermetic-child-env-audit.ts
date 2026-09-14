#!/usr/bin/env bun

/**
 * Enforce the child-environment boundary for test files.
 *
 * `test-hermetic-env.ts` makes the current test process safe, and an omitted `env` lets a
 * child inherit that safe process environment. A hand-written `env` object replaces the
 * environment instead; unless it is made with `hermeticChildEnv()`, it drops the state and
 * temp roots that keep the child out of the operator's files. This audit makes the helper the
 * only sanctioned way to construct an explicit child environment in a test file.
 *
 * The roster is derived from the filesystem, not a maintained list. The classifier uses the
 * TypeScript AST, so a method named `spawn` in a test fixture, a comment, or a string does not
 * become a child-process finding. It reports every direct node:child_process/Bun child call;
 * inherited calls remain in the census so the coverage boundary is visible.
 *
 * Scope: direct calls visible in test-file source. Playwright/browser launch configuration,
 * child processes started by imported production helpers, and dynamically assembled source
 * strings are outside this detector. The resolver guard, where present, is the separate
 * runner-agnostic defence for paths that reach the live-state resolver.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const CHILD_APIS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
])

const TEST_FILE = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/
const PRUNED = new Set([
  '.git',
  '.turbo',
  '.worktrees',
  'coverage',
  'dist',
  'dist-bun',
  'node_modules',
  'target',
])

export type ChildEnvKind = 'inherited' | 'helper' | 'curated'

export interface ChildCall {
  readonly file: string
  readonly line: number
  readonly api: string
  readonly kind: ChildEnvKind
}

export interface ChildEnvFinding extends ChildCall {
  readonly reason: string
}

export interface ChildEnvCensus {
  readonly testFiles: number
  readonly calls: readonly ChildCall[]
  readonly findings: readonly ChildEnvFinding[]
}

interface EnvProperty {
  readonly value: ts.Expression | undefined
}

const stringValue = (node: ts.Node | undefined): string | undefined =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined

const identifier = (node: ts.Node | undefined): string | undefined =>
  node && ts.isIdentifier(node) ? node.text : undefined

const propertyName = (node: ts.PropertyName | undefined): string | undefined =>
  node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined

const isChildModule = (node: ts.Node | undefined): boolean =>
  stringValue(node)?.replace(/^node:/, '') === 'child_process'

const isProcessEnv = (node: ts.Expression | undefined): boolean =>
  Boolean(
    node &&
      ts.isPropertyAccessExpression(node) &&
      identifier(node.expression) === 'process' &&
      node.name.text === 'env',
  )

const hasProcessEnvSpread = (node: ts.Expression | undefined): boolean =>
  Boolean(
    node &&
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) => ts.isSpreadAssignment(property) && isProcessEnv(property.expression),
      ),
  )

/** Return the explicit `env` property, preserving the distinction from no property. */
const envProperty = (node: ts.Expression | undefined): EnvProperty | undefined => {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === 'env') {
      return { value: property.initializer }
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'env') {
      return { value: property.name }
    }
  }
  return undefined
}

const childCall = (
  node: ts.CallExpression,
  named: Map<string, string>,
  namespaces: Set<string>,
): string | undefined => {
  if (ts.isIdentifier(node.expression)) return named.get(node.expression.text)
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined
  const api = node.expression.name.text
  if (!CHILD_APIS.has(api)) return undefined
  const owner = identifier(node.expression.expression)
  if (owner === 'Bun' || (owner && namespaces.has(owner))) return api
  if (
    ts.isCallExpression(node.expression.expression) &&
    identifier(node.expression.expression.expression) === 'require' &&
    isChildModule(node.expression.expression.arguments[0])
  ) {
    return api
  }
  return undefined
}

const helperCall = (node: ts.CallExpression, helperNames: Set<string>): boolean =>
  ts.isIdentifier(node.expression) && helperNames.has(node.expression.text)

/** Find an options object or an options variable, scanning from the call's right edge. */
const explicitEnv = (
  args: readonly ts.Expression[],
  declarations: Map<string, ts.Expression | undefined>,
): EnvProperty | undefined => {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index]
    const direct = envProperty(arg)
    if (direct) return direct
    const name = identifier(arg)
    if (name && declarations.has(name)) {
      const declared = envProperty(declarations.get(name))
      if (declared) return declared
    }
  }
  return undefined
}

const discoverTestFiles = (root: string): string[] => {
  const files: string[] = []
  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (PRUNED.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && TEST_FILE.test(entry.name)) files.push(full)
    }
  }
  walk(root)
  return files.sort()
}

export function analyzeTestSource(
  file: string,
  source: string,
): {
  readonly calls: readonly ChildCall[]
  readonly findings: readonly ChildEnvFinding[]
} {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const named = new Map<string, string>()
  const namespaces = new Set<string>()
  const helperNames = new Set(['hermeticChildEnv'])
  const declarations = new Map<string, ts.Expression | undefined>()
  const helperFunctions = new Set<string>()

  const bindImport = (pattern: ts.NamedImports | ts.ObjectBindingPattern): void => {
    for (const element of pattern.elements) {
      if (ts.isImportSpecifier(element)) {
        const local = element.name.text
        const imported = element.propertyName?.text ?? local
        if (CHILD_APIS.has(imported)) named.set(local, imported)
        if (imported === 'hermeticChildEnv') helperNames.add(local)
        continue
      }
      if (!ts.isBindingElement(element)) continue
      const local = identifier(element.name)
      const imported = propertyName(element.propertyName) ?? local
      if (!local || !imported) continue
      if (CHILD_APIS.has(imported)) named.set(local, imported)
      if (imported === 'hermeticChildEnv') helperNames.add(local)
    }
  }

  const isDynamicChildImport = (node: ts.Expression | undefined): boolean => {
    if (!node || !ts.isCallExpression(node)) return false
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
      return isChildModule(node.arguments[0])
    return identifier(node.expression) === 'require' && isChildModule(node.arguments[0])
  }

  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isChildModule(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      else if (bindings && ts.isNamedImports(bindings)) {
        bindImport(bindings)
      }
    }
    if (ts.isVariableDeclaration(node)) {
      const name = identifier(node.name)
      if (name) {
        declarations.set(name, node.initializer)
        if (node.initializer && isDynamicChildImport(node.initializer)) namespaces.add(name)
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isBindingElement(element)) continue
          const local = identifier(element.name)
          const imported = propertyName(element.propertyName) ?? local
          if (local && imported && CHILD_APIS.has(imported)) named.set(local, imported)
          if (local) declarations.set(local, element.initializer)
        }
        if (node.initializer && isDynamicChildImport(node.initializer)) bindImport(node.name)
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      if (containsHelper(node.body, helperNames)) helperFunctions.add(node.name.text)
    }
    if (
      ts.isVariableDeclaration(node) &&
      identifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      containsHelper(node.initializer.body, helperNames)
    ) {
      helperFunctions.add(identifier(node.name) as string)
    }
    ts.forEachChild(node, collect)
  }

  collect(sourceFile)

  const resolveKind = (
    value: ts.Expression | undefined,
    seen = new Set<string>(),
  ): ChildEnvKind => {
    if (hasProcessEnvSpread(value)) return 'inherited'
    if (!value || isProcessEnv(value)) return 'inherited'
    if (ts.isCallExpression(value)) {
      if (helperCall(value, helperNames)) return 'helper'
      const called = identifier(value.expression)
      if (called && helperFunctions.has(called)) return 'helper'
    }
    if (ts.isIdentifier(value) && declarations.has(value.text) && !seen.has(value.text)) {
      const next = new Set(seen).add(value.text)
      const initializer = declarations.get(value.text)
      if (initializer) return resolveKind(initializer, next)
    }
    return ts.isObjectLiteralExpression(value) ? 'curated' : 'curated'
  }

  const calls: ChildCall[] = []
  const findings: ChildEnvFinding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const api = childCall(node, named, namespaces)
      if (api) {
        const base = {
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          api,
        }
        const env = explicitEnv(node.arguments, declarations)
        const kind: ChildEnvKind = env ? resolveKind(env.value) : 'inherited'
        const call = { ...base, kind }
        calls.push(call)
        if (kind === 'curated') {
          findings.push({
            ...call,
            reason: 'explicit child env is not built with hermeticChildEnv()',
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { calls, findings }
}

function containsHelper(node: ts.Node, helperNames: Set<string>): boolean {
  let found = false
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && helperCall(child, helperNames)) found = true
    if (!found) ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

export function censusTestChildren(repoRoot: string): ChildEnvCensus {
  const files = discoverTestFiles(repoRoot)
  const reports = files.map((file) => analyzeTestSource(file, readFileSync(file, 'utf8')))
  return {
    testFiles: files.length,
    calls: reports.flatMap((report) => report.calls),
    findings: reports.flatMap((report) => report.findings),
  }
}

export function formatChildEnvReport(census: ChildEnvCensus): string {
  const counts = {
    inherited: census.calls.filter((call) => call.kind === 'inherited').length,
    helper: census.calls.filter((call) => call.kind === 'helper').length,
    curated: census.calls.filter((call) => call.kind === 'curated').length,
  }
  const lines = [
    `hermetic child env: ${census.testFiles} test files, ${census.calls.length} direct child calls`,
    `  inherited=${counts.inherited} helper=${counts.helper} curated=${counts.curated}`,
  ]
  if (census.findings.length > 0) {
    lines.push(
      `ERROR: ${census.findings.length} test child call(s) pass an explicit env without hermeticChildEnv():`,
      ...census.findings.map(
        (finding) =>
          `  ${relative(process.cwd(), finding.file)}:${finding.line} ${finding.api} — ${finding.reason}`,
      ),
    )
  }
  return lines.join('\n')
}

function main(): number {
  const root = resolve(import.meta.dirname, '..')
  const census = censusTestChildren(root)
  console.log(formatChildEnvReport(census))
  return census.findings.length === 0 ? 0 : 1
}
if (import.meta.main || process.argv[1]?.endsWith('hermetic-child-env-audit.ts'))
  process.exitCode = main()
