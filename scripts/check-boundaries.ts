/**
 * Dependency-boundary lint (Phase 0 guardrail — see ARCHITECTURE.md "Dependency
 * direction" and docs/offline-sync-architecture.md §4).
 *
 * Rules enforced over apps/, packages/ and scripts/ source:
 *
 *  1. No app→app imports. Grandfathered allowance: `apps/web` may import from
 *     `@podium/server` **type-only** (the `AppRouter` type for the tRPC client).
 *  2. `@podium/agent-bridge` may only be imported by `apps/daemon`, `scripts/`,
 *     and its own package (including its tests). Servers read transcripts via
 *     `@podium/transcript` instead.
 *  3. `@podium/protocol` and `@podium/core` are leaf packages — they import no
 *     other workspace package. `@podium/transcript` is a near-leaf: it may
 *     import only `@podium/protocol`.
 *  4. `packages/*` never import from `apps/*` (by name or by relative path).
 *
 * Run: `bun run lint:boundaries` (wired into `bun run lint`). Exits non-zero
 * with a readable violation list. Pure matching logic is exported for the
 * vitest suite in `scripts/check-boundaries.test.ts`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Grandfathered violations. Do NOT add entries — fix the dependency instead.
// ---------------------------------------------------------------------------

/**
 * Empty since Phase 3 extracted transcript parsing into `@podium/transcript`
 * (apps/server now imports that instead of agent-bridge). Kept so the stale-
 * entry warning machinery stays exercised. Do NOT add entries — fix the
 * dependency instead.
 *
 * NOTE: `apps/server/src/model-probe.ts` and `apps/web/src/derive.ts` mention
 * agent-bridge only in comments — a real import appearing there fails the check.
 */
const GRANDFATHERED_AGENT_BRIDGE = new Set<string>([])

/**
 * The one allowed app→app edge: apps/web imports the `AppRouter` *type* from
 * apps/server for its tRPC client. Type-only — erased at build; there is no
 * runtime dependency. Any runtime import of @podium/server from apps/web (or
 * any other app→app import) is a violation.
 */
const APP_TO_APP_TYPE_ONLY_ALLOWED = new Set<string>(['apps/web -> @podium/server'])

// ---------------------------------------------------------------------------
// Workspace map
// ---------------------------------------------------------------------------

const APP_PACKAGES: Record<string, string> = {
  '@podium/daemon': 'apps/daemon',
  '@podium/desktop': 'apps/desktop',
  '@podium/mobile': 'apps/mobile',
  '@podium/server': 'apps/server',
  '@podium/web': 'apps/web',
}

const LEAF_PACKAGES = new Set<string>(['packages/protocol', 'packages/core'])

/**
 * Near-leaf packages: may import ONLY the listed workspace packages (plus node
 * builtins/external deps). `@podium/transcript` is pure parsing/paging over
 * protocol types — it must never grow IO/harness dependencies.
 */
const RESTRICTED_PACKAGE_DEPS: Record<string, ReadonlySet<string>> = {
  'packages/transcript': new Set(['packages/protocol']),
}

export interface ImportRef {
  specifier: string
  /** true when the import is fully erased at build (`import type` / all-`type` specifiers). */
  typeOnly: boolean
}

export interface Violation {
  file: string
  specifier: string
  rule: string
  message: string
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/** Strip // line comments, block comments, and string-free noise conservatively. */
export function stripComments(source: string): string {
  // Good enough for import scanning: template literals containing `import ... from`
  // are vanishingly rare in this repo, and false negatives only under-report.
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const IMPORT_RE =
  // import ... from '...'; export ... from '...'; import '...'; require('...'); import('...')
  // The clause (group 2) may span lines but never contains quotes or semicolons,
  // so one statement's clause can't swallow a neighbouring statement.
  /(?:\b(import|export)\s+([^'";]*?)\s+from\s*|\bimport\s*(?=['"])|\b(?:require|import)\s*\(\s*)['"]([^'"]+)['"]/g

/** True when an import/export clause is fully type-only (erased at build). */
export function clauseIsTypeOnly(clause: string): boolean {
  const c = clause.trim()
  if (/^type\s/.test(c) && !/^type\s*\{?\s*,/.test(c)) {
    // `import type { X }`, `import type X`, `export type { X }` — but a default
    // import alongside (`import type X, { Y }`) is still fully type-only in TS.
    return true
  }
  // `import { type A, type B } from` — type-only iff every named specifier is
  // `type`-prefixed and there is no default/namespace import.
  const named = c.match(/^\{([\s\S]*)\}$/)
  if (!named) return false
  const specs = named[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return specs.length > 0 && specs.every((s) => /^type\s/.test(s))
}

/** Extract all module specifiers (with type-only flags) from a TS/TSX source. */
export function extractImports(source: string): ImportRef[] {
  const stripped = stripComments(source)
  const refs: ImportRef[] = []
  for (const m of stripped.matchAll(IMPORT_RE)) {
    const clause = m[2]
    const specifier = m[3]
    if (!specifier) continue
    refs.push({ specifier, typeOnly: clause !== undefined ? clauseIsTypeOnly(clause) : false })
  }
  return refs
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Workspace a repo-relative file path belongs to: 'apps/x', 'packages/y' or 'scripts'. */
export function workspaceOf(file: string): string {
  const parts = file.split('/')
  if (parts[0] === 'apps' || parts[0] === 'packages') return `${parts[0]}/${parts[1]}`
  if (parts[0] === 'scripts') return 'scripts'
  return parts[0]
}

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(file) || /\/(test|tests|__tests__)\//.test(file)
}

/** Workspace a specifier points at, or null for external/std imports. */
function targetWorkspace(file: string, specifier: string): string | null {
  if (specifier.startsWith('@podium/')) {
    const name = specifier.split('/').slice(0, 2).join('/')
    if (name in APP_PACKAGES) return APP_PACKAGES[name]
    return `packages/${name.slice('@podium/'.length)}`
  }
  if (specifier.startsWith('.')) {
    const abs = resolve('/', dirname(file), specifier)
    const rel = relative('/', abs).split(sep).join('/')
    return workspaceOf(rel)
  }
  return null
}

/** Check one file's imports against all boundary rules. Pure — used by tests. */
export function checkFile(file: string, source: string): Violation[] {
  const violations: Violation[] = []
  const from = workspaceOf(file)
  for (const ref of extractImports(source)) {
    const to = targetWorkspace(file, ref.specifier)
    if (to === null || to === from) continue

    // Rule 4: packages never import from apps.
    if (from.startsWith('packages/') && to.startsWith('apps/')) {
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'packages-no-apps',
        message: `${file}: packages must never import from apps (imports '${ref.specifier}')`,
      })
      continue
    }

    // Rule 3: protocol and core are leaf packages.
    if (LEAF_PACKAGES.has(from) && (to.startsWith('packages/') || to.startsWith('apps/'))) {
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'leaf-package',
        message: `${file}: ${from} is a leaf package and must not import workspace package '${ref.specifier}'`,
      })
      continue
    }

    // Rule 3b: near-leaf packages with an explicit allowed-deps list.
    const restricted = RESTRICTED_PACKAGE_DEPS[from]
    if (
      restricted &&
      (to.startsWith('packages/') || to.startsWith('apps/')) &&
      !restricted.has(to)
    ) {
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'restricted-package-deps',
        message: `${file}: ${from} may only import ${[...restricted].join(', ')} among workspace packages (imports '${ref.specifier}')`,
      })
      continue
    }

    // Rule 1: no app→app imports (grandfathered: web→server type-only).
    // Test files are exempt: e2e tests legitimately compose several apps
    // (e.g. apps/server/src/issue-relay-e2e.test.ts drives daemon code) and
    // are never shipped, so they don't create a runtime dependency edge.
    if (from.startsWith('apps/') && to.startsWith('apps/') && !isTestFile(file)) {
      const edge = `${from} -> @podium/${to.slice('apps/'.length)}`
      if (APP_TO_APP_TYPE_ONLY_ALLOWED.has(edge) && ref.typeOnly) continue
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'no-app-to-app',
        message: APP_TO_APP_TYPE_ONLY_ALLOWED.has(edge)
          ? `${file}: runtime import of '${ref.specifier}' — only type-only imports of @podium/server are allowed from apps/web`
          : `${file}: app→app import of '${ref.specifier}' is forbidden`,
      })
      continue
    }

    // Rule 2: agent-bridge importers are restricted.
    if (to === 'packages/agent-bridge') {
      const allowed =
        from === 'apps/daemon' || from === 'scripts' || from === 'packages/agent-bridge'
      if (allowed) continue
      if (GRANDFATHERED_AGENT_BRIDGE.has(file)) continue
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'agent-bridge-consumers',
        message: `${file}: '@podium/agent-bridge' may only be imported by apps/daemon, scripts/, or its own tests (Phase 3 extracts @podium/transcript for the grandfathered server cases)`,
      })
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// Walker + main
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.expo', 'coverage', 'target'])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(full)
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield full
    }
  }
}

export function runCheck(repoRoot: string): {
  violations: Violation[]
  staleGrandfathers: string[]
} {
  const violations: Violation[] = []
  const agentBridgeImporters = new Set<string>()
  for (const rootDir of ['apps', 'packages', 'scripts']) {
    for (const abs of walk(join(repoRoot, rootDir))) {
      const file = relative(repoRoot, abs).split(sep).join('/')
      const source = readFileSync(abs, 'utf8')
      violations.push(...checkFile(file, source))
      if (extractImports(source).some((r) => r.specifier.startsWith('@podium/agent-bridge')))
        agentBridgeImporters.add(file)
    }
  }
  const staleGrandfathers = [...GRANDFATHERED_AGENT_BRIDGE].filter(
    (f) => !agentBridgeImporters.has(f),
  )
  return { violations, staleGrandfathers }
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const start = performance.now()
  const { violations, staleGrandfathers } = runCheck(repoRoot)
  const ms = Math.round(performance.now() - start)
  for (const f of staleGrandfathers) {
    console.warn(
      `warning: grandfathered agent-bridge entry '${f}' no longer imports it — remove it from GRANDFATHERED_AGENT_BRIDGE in scripts/check-boundaries.ts`,
    )
  }
  if (violations.length > 0) {
    console.error(`Dependency-boundary violations (${violations.length}):\n`)
    for (const v of violations) console.error(`  [${v.rule}] ${v.message}`)
    console.error('\nSee ARCHITECTURE.md "Dependency direction" for the rules.')
    process.exit(1)
  }
  console.log(`boundaries OK (${ms}ms)`)
}

if (import.meta.main) main()
