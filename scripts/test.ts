/**
 * Cached entry point for the package-owned test lanes (POD-1687/POD-1689). `bun
 * run test`, `test:web`, `test:mobile` and `test:cached` land here.
 *
 * Every default unit suite now has a package owner and a real turbo task. The
 * root-level integration, acceptance, e2e, browser, multi-instance, and agent
 * smoke lanes remain explicit opt-ins because they spawn real processes, browsers,
 * or agent CLIs and cannot share this unit-task cache safely.
 *
 * Package tasks are deliberately run one at a time. Each Vitest task is already
 * capped at two workers, and serial task execution keeps the default safe on the
 * shared six-core host instead of multiplying that cap by the number of packages.
 *
 * The environment hole is the same one typecheck closes (POD-1343): turbo's key
 * covers tracked file content but is blind to the install, so a missing or
 * dangling node_modules/@podium keeps replaying a stale green. A cached green in
 * a broken environment is not evidence. Rather than restate that logic, this
 * imports typecheck.ts's census/fingerprint/force-decision directly — one
 * definition, so the two entry points cannot drift apart.
 *
 * What each cache key covers is declared in turbo.json. The web/mobile tasks
 * include their source-imported workspace packages and the scripts task includes
 * the repository trees its architecture/configuration audits read. The environment
 * fingerprint below is global to every task, so install/linker drift is a miss too.
 */
import { join } from 'node:path'
import { runWithHeavyTestLease } from './test-heavy'
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
  process.exit(
    await runWithHeavyTestLease(
      [
        join(root, 'node_modules', '.bin', 'turbo'),
        'run',
        'test',
        '--concurrency=1',
        // Report every lane's failures, not just the first one's. This became load-bearing
        // when POD-520 split @podium/server into five shard tasks: without it Turbo stops
        // at the first failing shard, so a red in `contracts` hides whatever `store`,
        // `services` and `boundary` would have said — a full run used to show all of them
        // at once because the server was a single task. `dependencies-successful` (not
        // `always`) so a task whose dependency failed is still skipped; the run is red
        // either way, this only decides how much of the picture you get for the CPU spent.
        '--continue=dependencies-successful',
        ...decision.forwardArgs,
      ],
      {
        cwd: root,
        env: { ...process.env, PODIUM_CHECK_ENV_HASH: fingerprint(census), TURBO_FORCE: undefined },
      },
    ),
  )
}

if (import.meta.main) await main()
