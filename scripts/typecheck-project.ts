/**
 * The ONE way a workspace package typechecks (POD-3890). Every package's `typecheck`
 * script is `bun <root>/scripts/typecheck-project.ts [-p <tsconfig>]` and nothing else.
 *
 * Why a runner and not a checker command in 24 manifests:
 *
 *   1. ONE CHECKER. Since POD-6251 that is `bun check`, the TypeScript 7 checker built into
 *      the Bun that runs this file — the Bun pinned in mise.toml, so the checker version is
 *      pinned with it. Measured on dev/mw (2026-11-02, 7 cores): all 30 projects in 27-29 s
 *      at a 0.73 GB peak, against 218-231 s and 5.2 GB for a cold `tsc --noEmit`, with the
 *      same file lists and byte-identical diagnostics on planted errors in every project.
 *      `bun check` keeps no incremental state, but a full check is as fast as tsc's
 *      no-change incremental rerun (32 s), so nothing was given up. The root `typescript`
 *      package stays: editors run it, and the runner refuses when it is not the exact
 *      version Bun checks with, so the editor and the gate never disagree. A workspace
 *      package that declares TypeScript 6 itself does so because it needs the JavaScript
 *      API as a LIBRARY — the audit scripts in `scripts/`, the AST-walking tests in
 *      apps/server, apps/web and apps/mobile — never to typecheck.
 *   2. THE FLAGS ARE NOT OPTIONAL. `--no-script` is forced: without it `bun check` runs a
 *      package's own `check` script instead of the checker.
 *   3. IT REFUSES TO RUN OUTSIDE TURBO. `bun run typecheck` at the root is the sanctioned
 *      entry: it takes a validation slot on this host, caps checker concurrency by free
 *      memory, keys the shared cache on the install fingerprint, and makes the run account
 *      for every project. A package script invoked by hand — `cd apps/web && bun run
 *      typecheck`, `bun run --filter @podium/web typecheck` — has none of that, so it is
 *      refused with the command that does. Turbo marks its children with TURBO_HASH; that
 *      is the whole check, the same one podium-cloud uses for its OSS tasks.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Checker {
  /** the Bun binary whose built-in checker runs */
  bin: string
  /** the TypeScript version that checker implements */
  version: string
}

/**
 * The checker is the running Bun's own. It must implement TypeScript 7 and be the exact
 * version of the root `typescript` install, which is what editors run.
 */
export function resolveChecker(
  root: string,
  bun: { bin: string; typescript: string | undefined } = {
    bin: process.execPath,
    typescript: process.versions.typescript,
  },
): { checker: Checker | null; error: string | null } {
  if (typeof bun.typescript !== 'string' || !bun.typescript.startsWith('7.')) {
    return {
      checker: null,
      error:
        `typecheck refused: this Bun (${bun.bin}) has no TypeScript 7 checker ` +
        `(process.versions.typescript is ${bun.typescript ?? 'missing'}). The repository typechecks ` +
        'with `bun check`, which needs the Bun pinned in mise.toml — run `mise install bun`.',
    }
  }
  const manifest = join(root, 'node_modules', 'typescript', 'package.json')
  if (!existsSync(manifest)) {
    return {
      checker: null,
      error: `typecheck refused: ${manifest} is missing — run \`bun run deps:repair\`.`,
    }
  }
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }
  if (version !== bun.typescript) {
    return {
      checker: null,
      error:
        `typecheck refused: \`bun check\` implements TypeScript ${bun.typescript}, but the root ` +
        `\`typescript\` your editor runs is ${version ?? 'unversioned'}. Keep the two equal: pin ` +
        '`typescript` in package.json to the version this Bun checks with, or move the Bun pin in ' +
        'mise.toml to a release that checks with yours. If the install predates the pin, run ' +
        '`bun run deps:repair` (`setup:worktree` is a frozen reconcile: it never prunes the dangling ' +
        '.bin/tsserver an old install leaves, and the topology census then refuses the gate).',
    }
  }
  return { checker: { bin: bun.bin, version }, error: null }
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

/** `bun check` plus the forced flags, then whatever the manifest passes (a -p for a second
 *  project). The tsc-era --noEmit/--incremental are dropped: `bun check` never emits and
 *  keeps no incremental state. */
export function checkerArgs(argv: string[]): string[] {
  const forced = ['check', '--no-script']
  const dropped = new Set([...forced, '--noEmit', '--incremental'])
  return [...forced, ...argv.filter((arg) => !dropped.has(arg))]
}

async function main() {
  const refusal = turboRefusal(process.env as Record<string, string | undefined>)
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  const root = join(import.meta.dir, '..')
  const { checker, error } = resolveChecker(root)
  if (!checker) {
    console.error(error)
    process.exit(1)
  }
  const proc = Bun.spawn([checker.bin, ...checkerArgs(process.argv.slice(2))], {
    cwd: process.cwd(),
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(await proc.exited)
}

if (import.meta.main) await main()
