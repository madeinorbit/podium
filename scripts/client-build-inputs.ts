/**
 * The cross-package inputs of the client build tasks, DERIVED from what the apps
 * actually import rather than hand-listed in turbo.json.
 *
 * Turbo hashes a task over the files it is told about. `@podium/web#build` and
 * `@podium/mobile#build` consume workspace packages from SOURCE
 * (`conditions: ['@podium/source']`, apps/web/vite.config.ts) — they never read a
 * package's `dist`, so they cannot depend on `^build` and Turbo's dependency graph
 * does not reach those sources for them. Anything outside the app directory is
 * therefore invisible to the cache key unless it is declared, and a stale client
 * would be REPLAYED for a commit that changed only a package: the "turbo only
 * follows the graph it can see" failure (spec §4.2).
 *
 * A hand-maintained list falls behind the import graph silently — nothing goes red,
 * a wrong artefact is simply served. So the list is computed here from the import
 * statements, and `client-build-inputs.test.ts` fails the build when turbo.json
 * declares less than this says it must.
 *
 * LIMIT OF THIS DERIVATION, stated so nobody reads more into a green than is there:
 * it reads `@podium/*` specifiers statically. An app that escapes its directory some
 * other way — a relative import climbing out of the app, a tsconfig "paths" alias, a
 * computed specifier — is not seen. That is the same limit `scripts/typecheck.ts`
 * documents for its own key, and it is a floor on what must be declared, never proof
 * that nothing else is missing.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type ClientApp = 'apps/web' | 'apps/mobile'
export type ClientBuildTaskId = '@podium/web#build' | '@podium/mobile#build'

/** `from '@podium/x'`, `from '@podium/x/sub'`, and `import('@podium/x')`. */
const IMPORT_RE =
  /(?:from|import)\s*\(?\s*['"](@podium\/[a-z0-9-]+)(?:\/[^'"]*)?['"]|require\(\s*['"](@podium\/[a-z0-9-]+)/g
const SOURCE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/
/** Directories that hold build OUTPUT or caches, never input. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.expo', '.turbo', '.sourcemaps'])

/** Every script the build command runs, relative to the repository root. */
const SCRIPTS: Record<ClientApp, readonly string[]> = {
  'apps/web': [
    'scripts/archive-web-sourcemaps.ts',
    'scripts/precompress-dist.ts',
    'scripts/write-web-build-stamp.ts',
    'scripts/web-bundle-budget.ts',
  ],
  'apps/mobile': ['scripts/precompress-dist.ts', 'scripts/write-web-build-stamp.ts'],
}

export const CLIENT_BUILD_TASK: Record<ClientApp, ClientBuildTaskId> = {
  'apps/web': '@podium/web#build',
  'apps/mobile': '@podium/mobile#build',
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (SOURCE_RE.test(entry.name)) out.push(path)
  }
}

/** Workspace package name → its directory relative to the repository root. */
function packageDirByName(root: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const group of ['packages', 'apps']) {
    for (const name of readdirSync(join(root, group))) {
      try {
        const { name: packageName } = JSON.parse(
          readFileSync(join(root, group, name, 'package.json'), 'utf8'),
        ) as { name?: string }
        if (packageName) map.set(packageName, `${group}/${name}`)
      } catch {
        // Not a package directory (no package.json, or unreadable) — nothing to map.
      }
    }
  }
  return map
}

/** The workspace package directories imported by the sources under `dir`. */
function directImportsOf(root: string, dir: string, byName: Map<string, string>): string[] {
  const files: string[] = []
  walk(join(root, dir), files)
  const found = new Set<string>()
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const name = match[1] ?? match[2]
      const target = name === undefined ? undefined : byName.get(name)
      if (target !== undefined) found.add(target)
    }
  }
  return [...found]
}

/**
 * Every workspace package directory `app` reaches, TRANSITIVELY, sorted, excluding
 * itself.
 *
 * Transitively is the whole point. The app bundles from source, so a package it
 * imports only through another package is just as much a source file of the build
 * as one it names itself — and a direct-imports-only list would declare
 * `packages/client-core` while missing what client-core imports, leaving a real
 * source change outside the cache key and a stale client replayed for it.
 */
export function workspaceImportsOf(root: string, app: ClientApp): string[] {
  const byName = packageDirByName(root)
  const seen = new Set<string>()
  const queue = directImportsOf(root, app, byName)
  while (queue.length > 0) {
    const dir = queue.pop() as string
    if (dir === app || seen.has(dir)) continue
    seen.add(dir)
    queue.push(...directImportsOf(root, dir, byName))
  }
  return [...seen].sort()
}

/** The `$TURBO_ROOT$` globs `turbo.json` MUST declare for this app's build task. */
export function requiredBuildInputs(root: string, app: ClientApp): string[] {
  const packages = workspaceImportsOf(root, app).flatMap((dir) => [
    `$TURBO_ROOT$/${dir}/src/**`,
    `$TURBO_ROOT$/${dir}/package.json`,
  ])
  const scripts = SCRIPTS[app].map((script) => `$TURBO_ROOT$/${script}`)
  return [...packages, ...scripts].sort()
}

/** What `turbo.json` declares today. */
export function declaredBuildInputs(root: string, task: ClientBuildTaskId): string[] {
  const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8')) as {
    tasks?: Record<string, { inputs?: string[] } | undefined>
  }
  return turbo.tasks?.[task]?.inputs ?? []
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  for (const app of ['apps/web', 'apps/mobile'] as const) {
    console.log(`${CLIENT_BUILD_TASK[app]} (${app}):`)
    for (const glob of requiredBuildInputs(root, app)) console.log(`  ${JSON.stringify(glob)},`)
  }
}
