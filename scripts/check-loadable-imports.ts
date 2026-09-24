#!/usr/bin/env bun
/**
 * Every module the tests/e2e tree LOADS must exist (POD-4664).
 *
 * tests/e2e sits outside the product typecheck projects, so a module deleted
 * under it goes unnoticed until someone starts the suite: POD-4472 deleted
 * apps/daemon/src/codex-hooks.ts, serve-harness.ts still imported it, and every
 * browser suite failed at webServer start for days while every gate stayed green.
 * The e2e package's typecheck fully typechecks only the harness core (the files
 * every browser suite loads — see tests/e2e/tsconfig.json); the rest of the tree
 * has drifted types that no gate has read in months. This is the check that the
 * whole tree can still START: each runtime import — static, re-export, side-effect
 * and dynamic, but not type-only, which is erased before anything loads — must
 * resolve the way the harness resolves it, with the `@podium/source` condition
 * (workspace packages as TypeScript source, no build needed).
 *
 * It runs as the second half of `@podium/e2e#typecheck`, so `bun run typecheck`
 * (and so `bun run test`) fails on it. It resolves; it does not typecheck. A
 * deleted NAMED EXPORT is only caught in the harness core.
 *
 * Usage: bun --conditions=@podium/source scripts/check-loadable-imports.ts [--root <dir>]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const DEFAULT_ROOT = join(REPO_ROOT, 'tests/e2e')
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|mjs|js)$/
/** Generated or installed, never authored: Playwright output and the link farm. */
const SKIPPED_DIRS = new Set(['node_modules', 'test-results', 'playwright-report', 'blob-report'])
const BUILTIN = /^(?:node|bun):/

export interface UnresolvedImport {
  file: string
  specifier: string
  reason: string
}

export type Resolve = (specifier: string, fromDir: string) => string

export function sourceFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name))
      } else if (SOURCE_EXTENSIONS.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(join(dir, entry.name))
      }
    }
  }
  walk(root)
  return files.sort()
}

export function unresolvedImports(
  root: string,
  resolve: Resolve = (specifier, fromDir) => Bun.resolveSync(specifier, fromDir),
): UnresolvedImport[] {
  const transpiler = new Bun.Transpiler({ loader: 'tsx' })
  const failures: UnresolvedImport[] = []
  for (const file of sourceFiles(root)) {
    const imports = transpiler.scanImports(readFileSync(file, 'utf8'))
    for (const { path: specifier } of imports) {
      if (BUILTIN.test(specifier)) continue
      try {
        resolve(specifier, dirname(file))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failures.push({ file: relative(root, file), specifier, reason })
      }
    }
  }
  return failures
}

/** Without the source condition a workspace package resolves to its build output,
 *  which a fresh checkout does not have — every package import would "fail". */
function sourceConditionActive(): boolean {
  try {
    return Bun.resolveSync('@podium/model', DEFAULT_ROOT).endsWith('.ts')
  } catch {
    return false
  }
}

if (import.meta.main) {
  const rootFlag = process.argv.indexOf('--root')
  const root = rootFlag === -1 ? DEFAULT_ROOT : join(process.cwd(), process.argv[rootFlag + 1] ?? '')
  if (!sourceConditionActive()) {
    console.error(
      'check-loadable-imports: run with --conditions=@podium/source (workspace packages must resolve to source)',
    )
    process.exit(2)
  }
  const failures = unresolvedImports(root)
  if (failures.length > 0) {
    console.error(`check-loadable-imports: ${failures.length} import(s) under ${relative(REPO_ROOT, root) || root} do not resolve:`)
    for (const failure of failures) console.error(`  ${failure.file}: '${failure.specifier}' — ${failure.reason}`)
    process.exit(1)
  }
  console.log(`check-loadable-imports: every runtime import under ${relative(REPO_ROOT, root) || root} resolves (${sourceFiles(root).length} files)`)
}
