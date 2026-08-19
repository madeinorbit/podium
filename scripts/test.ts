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
 * covers tracked file content but is blind to the install, so a missing,
 * dangling, or externally resolved workspace package can replay a stale green.
 * A cached green in a broken environment is not evidence. Rather than restate
 * that logic, this imports typecheck.ts's census/fingerprint/force-decision directly — one
 * definition, so the two entry points cannot drift apart.
 *
 * What each cache key covers is declared in turbo.json. The web/mobile tasks
 * include their source-imported workspace packages and the scripts task includes
 * the repository trees its architecture/configuration audits read. The environment
 * fingerprint below is global to every task, so install/linker drift is a miss too.
 */
import { join } from 'node:path'
import { runWithHeavyTestLease } from './test-heavy'
import { decideForce, readCensus, turboEnv } from './typecheck'

const REFUSAL = `\
uncached test run refused.

The cache key already covers the suite's own files, the workspace package
sources it imports, bun.lock, tooling/tsconfig, and the install environment
(bunfig.toml + workspace resolution census via PODIUM_CHECK_ENV_HASH), so
installs, linker changes, and base swaps are noticed automatically — a real
change is a MISS without any help.

If you still believe the cache is wrong, state why:

  bun run test:web -- --uncached-because="<what the cache is missing>"

and consider filing the reason as an issue — a real gap in the cache key should
be closed there, not worked around with --force forever.`

const FOCUSED_TEST_PACKAGES = new Set(['@podium/web', '@podium/mobile'])

export function decideTestAdmission(argv: string[]): {
  shared: boolean
  forwardArgs: string[]
  error: string | null
} {
  const forwardArgs: string[] = []
  const filters: string[] = []
  let sharedFlags = 0
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    if (arg === '--shared-admission') {
      sharedFlags++
      continue
    }
    forwardArgs.push(arg)
    if (arg === '--filter') {
      const filter = argv[++index]
      if (filter === undefined) filters.push('')
      else {
        filters.push(filter)
        forwardArgs.push(filter)
      }
    } else if (arg.startsWith('--filter=')) {
      filters.push(arg.slice('--filter='.length))
    }
  }
  if (sharedFlags === 0) return { shared: false, forwardArgs, error: null }
  if (
    sharedFlags !== 1 ||
    filters.length === 0 ||
    filters.some((filter) => !FOCUSED_TEST_PACKAGES.has(filter))
  ) {
    return {
      shared: false,
      forwardArgs,
      error:
        '--shared-admission is internal to the focused web/mobile scripts and requires ' +
        'at least one exact --filter @podium/web or --filter @podium/mobile',
    }
  }
  return { shared: true, forwardArgs, error: null }
}

async function main() {
  const root = join(import.meta.dir, '..')
  const census = readCensus(root)
  if (census.resolutionErrors.length > 0) {
    console.error(
      'test refused: workspace resolution contract failed; a cached green there would be ' +
        `unsafe (POD-1343).\n- ${census.resolutionErrors.join('\n- ')}`,
    )
    process.exit(1)
  }
  const admission = decideTestAdmission(process.argv.slice(2))
  if (admission.error) {
    console.error(`test refused: ${admission.error}`)
    process.exit(1)
  }
  const decision = decideForce(
    admission.forwardArgs,
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
  const command = [
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
  ]
  if (admission.shared) {
    const proc = Bun.spawn(command, {
      cwd: root,
      env: turboEnv(root, census),
      stdio: ['inherit', 'inherit', 'inherit'],
    })
    process.exit(await proc.exited)
  }
  process.exit(
    await runWithHeavyTestLease(command, {
      cwd: root,
      label: 'full package tests',
      env: turboEnv(root, census),
    }),
  )
}

if (import.meta.main) await main()
