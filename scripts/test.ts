/**
 * Cached entry point for the per-package test lanes (POD-1687). `bun run
 * test:web`, `test:mobile` and `test:cached` land here.
 *
 * Only apps/web and apps/mobile are routed through turbo: they are genuinely
 * per-package, so a cache key can describe them honestly. The root-level lanes
 * (test:unit, test:integration, test:bun, ...) still always execute for real —
 * they reach shared state that no package-scoped hash covers.
 *
 * The environment hole is the same one typecheck closes (POD-1343): turbo's key
 * covers tracked file content but is blind to the install, so a missing or
 * dangling node_modules/@podium keeps replaying a stale green. A cached green in
 * a broken environment is not evidence. Rather than restate that logic, this
 * imports typecheck.ts's census/fingerprint/force-decision directly — one
 * definition, so the two entry points cannot drift apart.
 *
 * What the cache key covers for these lanes is wider than the package dir,
 * because both suites reach outside it: apps/web/test/shell.structure.test.ts
 * reads packages/client-core/src off disk, and both suites import @podium/*
 * packages as SOURCE via the `@podium/source` condition. `dependsOn: ["^test"]`
 * does not carry that content in — the dependency packages have no `test`
 * script, so there is no task hash to chain from. turbo.json therefore declares
 * those sources as explicit $TURBO_ROOT$ inputs. See the per-package overrides
 * `@podium/web#test` / `@podium/mobile#test`.
 */
import { join } from 'node:path'
import { decideForce, fingerprint, readCensus } from './typecheck'

const REFUSAL = `\
uncached test run refused.

The cache key already covers the suite's own files, the workspace package
sources it imports, bun.lock, tooling/tsconfig, and the install environment
(bunfig.toml + node_modules/@podium census via PODIUM_CHECK_ENV_HASH), so
installs, linker changes, and base swaps are noticed automatically — a real
change is a MISS without any help.

If you still believe the cache is wrong, state why:

  bun run test:web -- --uncached-because="<what the cache is missing>"

and consider filing the reason as an issue — a real gap in the cache key should
be closed there, not worked around with --force forever.`

async function main() {
  const root = join(import.meta.dir, '..')
  const census = readCensus(root)
  const healthy = census.links.filter((l) => !l.endsWith('!DANGLING'))
  if (healthy.length === 0) {
    console.error(
      'test refused: node_modules/@podium has no usable workspace links — this ' +
        'checkout is not installed, and a cached green here would not be evidence ' +
        '(POD-1343). Run `bun install` first.',
    )
    process.exit(1)
  }
  const decision = decideForce(
    process.argv.slice(2),
    process.env as Record<string, string | undefined>,
  )
  if (decision.forceRequested && decision.reason === null) {
    console.error(REFUSAL)
    process.exit(1)
  }
  if (decision.error) {
    console.error(decision.error)
    process.exit(1)
  }
  if (decision.reason) console.error(`uncached run, reason: ${decision.reason}`)
  const proc = Bun.spawn(
    [join(root, 'node_modules', '.bin', 'turbo'), 'run', 'test', ...decision.forwardArgs],
    {
      cwd: root,
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env, PODIUM_CHECK_ENV_HASH: fingerprint(census), TURBO_FORCE: undefined },
    },
  )
  process.exit(await proc.exited)
}

if (import.meta.main) await main()
