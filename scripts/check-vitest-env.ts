/**
 * Guard: no test file may carry a path-form environment directive — the form
 * the pinned Vitest silently ignores. [POD-4728]
 *
 * The pinned Vitest (5.0.0-beta.6) reads the environment line with
 *
 *   /@(?:vitest|jest)-environment\s+([\w-]+)\b/
 *
 * (`detectCodeBlock` in its bundled `cli-api` chunk) and falls back to the
 * project config environment — usually `node` — when it does not match. The
 * character class `[\w-]` excludes `.` and `/`, so a path value such as
 * ./custom-env.ts or /abs/env.ts never matches: the file runs under the wrong
 * environment, green, with no error naming the directive. Measured on the
 * pinned version: a spec pointing at a real custom environment file ran under
 * node (`typeof window` undefined, the env's `setup()` never called) while the
 * same spec with a bare name ran under happy-dom (`typeof window` object).
 *
 * So this check mirrors the pinned parser exactly: a directive value that is
 * not a bare `[\w-]+` name is one the runner cannot see, and fails. Bare
 * names — happy-dom, jsdom, node, edge-runtime, any custom
 * `vitest-environment-*` package name — are honored and never flagged.
 *
 * Scope is deliberately the files the runner reads the directive from: names
 * containing `.test.` or `.spec.` under the code roots. A directive in docs
 * prose, a config comment, or a non-test helper is inert — vitest never looks
 * there — so flagging it would be noise. `__fixtures__` is skipped like the
 * shadowing sweep's, so a committed parser fixture cannot fail the gate; the
 * vitest suite below plus a temp-file run are the fail-then-clean evidence.
 *
 * Run: `bun run lint:vitest-env` (wired into `bun run lint`).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOTS = ['apps', 'packages', 'scripts', 'tests', 'services', 'tooling'] as const
const SKIP_DIR = new Set(['node_modules', 'dist', '.git', 'coverage', 'out', '__fixtures__'])

/**
 * The pinned parser's shape, kept as a live reference (not executed against
 * whole files here — the per-line scan below is what reports WHERE).
 * `[\w-]` is the whole story: no `.`, no `/`, so no path ever matches.
 */
export const PINNED_ENV_VALUE = /^[\w-]+$/

/** A file the runner reads an environment directive from. */
export function isTestLikePath(name: string): boolean {
  return name.includes('.test.') || name.includes('.spec.')
}

export interface EnvDirective {
  line: number
  /** Raw value token, stripped of docblock-close/quotes/trailing punctuation. */
  value: string
}

/** `@vitest-environment` and `@jest-environment` parse identically upstream. */
const DIRECTIVE_RE = /@(?:vitest|jest)-environment\s+([^\s]+)/g

/** Strip a docblock close, surrounding quotes/backticks, trailing `,`/`;`. */
export function cleanDirectiveValue(raw: string): string {
  let value = raw
  if (value.endsWith('*/')) value = value.slice(0, -2)
  value = value.replace(/^['"`]+|['"`]+$/g, '')
  value = value.replace(/[,;]+$/g, '')
  return value
}

/** Every directive occurrence with a value token, with line numbers. */
export function extractDirectiveValues(source: string): EnvDirective[] {
  const out: EnvDirective[] = []
  const lines = source.split('\n')
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? ''
    DIRECTIVE_RE.lastIndex = 0
    for (const m of line.matchAll(DIRECTIVE_RE)) {
      const raw = m[1] ?? ''
      out.push({ line: n + 1, value: cleanDirectiveValue(raw) })
    }
  }
  return out
}

/**
 * True when the value is one the pinned parser cannot see — exactly the
 * values its `([\w-]+)` group cannot match, plus the empty string a
 * quote-only token strips down to. A `false` here means the runner honors
 * the line, so these names must never fail the gate.
 */
export function isIgnoredEnvironmentValue(value: string): boolean {
  return !PINNED_ENV_VALUE.test(value)
}

export interface EnvFinding {
  file: string
  line: number
  value: string
}

/** The ignored directives in one source text. Pure — used by the tests. */
export function scanSource(file: string, source: string): EnvFinding[] {
  return extractDirectiveValues(source)
    .filter((d) => isIgnoredEnvironmentValue(d.value))
    .map((d) => ({ file, line: d.line, value: d.value }))
}

/** Walk roots; return the ignored directives in test-like files. */
export function findIgnoredEnvDirectives(repoRoot: string): EnvFinding[] {
  const findings: EnvFinding[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP_DIR.has(name)) continue
      const full = join(dir, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (!st.isFile() || !isTestLikePath(name)) continue
      let source: string
      try {
        source = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      findings.push(...scanSource(relative(repoRoot, full).split(sep).join('/'), source))
    }
  }
  for (const root of ROOTS) {
    const abs = join(repoRoot, root)
    if (existsSync(abs)) walk(abs)
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
}

export function formatEnvReport(findings: readonly EnvFinding[], scanned: number): string {
  if (findings.length === 0) {
    return `ok: no ignored environment directives in ${scanned} test file(s)`
  }
  const lines = [
    `ERROR: ${findings.length} environment directive(s) the pinned vitest silently ignores.`,
    'Its parser only sees a bare name ([\\w-]+): happy-dom, jsdom, node. A path',
    'value (./env, ../env, /abs/env) never matches, so the file runs under the',
    'project default instead — green and wrong. Use a bare environment name.',
    '',
    ...findings.map((f) => `  IGNORED: ${f.file}:${f.line} value '${f.value}'`),
  ]
  return lines.join('\n')
}

function countTestFiles(repoRoot: string): number {
  let count = 0
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP_DIR.has(name)) continue
      const full = join(dir, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (st.isFile() && isTestLikePath(name)) count++
    }
  }
  for (const root of ROOTS) {
    const abs = join(repoRoot, root)
    if (existsSync(abs)) walk(abs)
  }
  return count
}

export function main(argv: readonly string[] = []): number {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const only = argv.filter((a) => !a.startsWith('-'))
  if (only.length > 0) {
    const findings = only.flatMap((f) => scanSource(f, readFileSync(f, 'utf8')))
    if (findings.length === 0) {
      console.log(`ok: no ignored environment directives in ${only.length} file(s)`)
      return 0
    }
    console.error(formatEnvReport(findings, only.length))
    return 1
  }
  const findings = findIgnoredEnvDirectives(repoRoot)
  const scanned = countTestFiles(repoRoot)
  if (findings.length === 0) {
    console.log(formatEnvReport(findings, scanned))
    return 0
  }
  console.error(formatEnvReport(findings, scanned))
  return 1
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
