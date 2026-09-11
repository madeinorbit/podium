/**
 * The ONE way a workspace package typechecks (POD-3890). Every package's `typecheck`
 * script is `bun <root>/scripts/typecheck-project.ts [-p <tsconfig>]` and nothing else.
 *
 * Why a runner and not `tsc --noEmit` in 24 manifests:
 *
 *   1. ONE COMPILER. TypeScript 7 is the Go compiler; the `typescript` package at the
 *      repository root is the only one that runs. A workspace package that declares
 *      TypeScript 6 itself does so because it needs the JavaScript API as a LIBRARY —
 *      the audit scripts in `scripts/`, the AST-walking tests in apps/server, apps/web
 *      and apps/mobile — never to typecheck; TypeScript 7 exports no such API. A package
 *      that imports 'typescript' without declaring it resolves the root 7.x and fails
 *      with "no exported member forEachChild". The runner resolves the root binary
 *      by path — `node_modules/.bin/tsc` is whichever install linked last — and refuses
 *      a compiler that is not a 7.x, so a stale install cannot silently typecheck with
 *      the wrong engine.
 *   2. THE FLAGS ARE NOT OPTIONAL. `--incremental` is what turns a 10s package check
 *      into 0.6s on the next run (measured on packages/commands). It is set in the shared
 *      tsconfig, but not every project extends it (apps/mobile extends Expo's), so the
 *      runner passes it on the command line where it cannot be forgotten.
 *   3. IT REFUSES TO RUN OUTSIDE TURBO. `bun run typecheck` at the root is the sanctioned
 *      entry: it takes a validation slot on this host, caps compiler concurrency by free
 *      memory, keys the shared cache on the install fingerprint, and makes the run account
 *      for every project. A package script invoked by hand — `cd apps/web && bun run
 *      typecheck`, `bun run --filter @podium/web typecheck` — has none of that, so it is
 *      refused with the command that does. Turbo marks its children with TURBO_HASH; that
 *      is the whole check, the same one podium-cloud uses for its OSS tasks.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Compiler {
  bin: string
  version: string
}

/** The root `typescript` install, which must be the 7.x Go compiler. */
export function resolveCompiler(root: string): { compiler: Compiler | null; error: string | null } {
  const manifest = join(root, 'node_modules', 'typescript', 'package.json')
  if (!existsSync(manifest)) {
    return {
      compiler: null,
      error: `typecheck refused: ${manifest} is missing — run \`bun run setup:worktree\` (or \`bun run deps:repair\`).`,
    }
  }
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }
  if (typeof version !== 'string' || !version.startsWith('7.')) {
    return {
      compiler: null,
      error:
        `typecheck refused: the root \`typescript\` is ${version ?? 'unversioned'}, not the 7.x Go compiler ` +
        'this repository typechecks with. The install is stale — run `bun run setup:worktree`.',
    }
  }
  return {
    compiler: { bin: join(root, 'node_modules', 'typescript', 'bin', 'tsc'), version },
    error: null,
  }
}

export function turboRefusal(env: Record<string, string | undefined>): string | null {
  if (env.TURBO_HASH) return null
  return `\
typecheck refused: this package script only runs under Turbo, from the repository root:

  bun run typecheck                          every project, cached
  bun run typecheck -- --filter <package>    one project (and its dependencies), cached

That entry point takes a validation slot on this host, caps how many compilers run
by free memory, keys the shared cache on the install fingerprint, and makes the run
account for every project. A package script invoked directly has none of that.`
}

/** The flags every project gets, plus whatever the manifest passes (a -p for a second project). */
export function compilerArgs(argv: string[]): string[] {
  const forced = ['--noEmit', '--incremental']
  const passthrough = argv.filter((arg) => !forced.includes(arg))
  return [...forced, ...passthrough]
}

async function main() {
  const refusal = turboRefusal(process.env as Record<string, string | undefined>)
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  const root = join(import.meta.dir, '..')
  const { compiler, error } = resolveCompiler(root)
  if (!compiler) {
    console.error(error)
    process.exit(1)
  }
  const proc = Bun.spawn([compiler.bin, ...compilerArgs(process.argv.slice(2))], {
    cwd: process.cwd(),
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(await proc.exited)
}

if (import.meta.main) await main()
