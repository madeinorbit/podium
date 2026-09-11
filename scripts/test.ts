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
 * The environment hole is the same one typecheck closes (POD-1343, POD-2774): turbo's
 * key covers tracked file content but is blind to the install, so a missing, dangling,
 * or externally resolved package — workspace or third-party — can replay a stale green,
 * and two differently linked worktrees can share one cache identity.
 * A cached green in a broken environment is not evidence. Rather than restate
 * that logic, this imports typecheck.ts's census/fingerprint/force-decision directly — one
 * definition, so the two entry points cannot drift apart.
 *
 * What each cache key covers is declared in turbo.json. The web/mobile tasks
 * include their source-imported workspace packages and the scripts task includes
 * the repository trees its architecture/configuration audits read. The environment
 * fingerprint below is global to every task, so install/linker drift is a miss too.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runWithHeavyTestLease } from './test-heavy'
import { admissionRefusal, decideForce, readCensus, turboEnv } from './typecheck'
import { workspaceDirectories } from './workspace-resolution-census'

const REFUSAL = `\
uncached test run refused.

The cache key already covers the suite's own files, the workspace package
sources it imports, bun.lock, tooling/tsconfig, and the install environment
(effective install configuration, install topology, and the workspace resolution
census via PODIUM_CHECK_ENV_HASH), so installs, linker changes, and base swaps are
noticed automatically — a real
change is a MISS without any help.

If you still believe the cache is wrong, state why:

  bun run test:web -- --uncached-because="<what the cache is missing>"

and consider filing the reason as an issue — a real gap in the cache key should
be closed there, not worked around with --force forever.`

const FOCUSED_TEST_PACKAGES = new Set(['@podium/web', '@podium/mobile'])

/** Every task `turbo run test` will attempt: one per workspace declaring the script. */
export function expectedTestTasks(root: string): string[] {
  const tasks: string[] = []
  for (const directory of workspaceDirectories(root)) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name?: string
      scripts?: Record<string, string>
    }
    if (typeof manifest.name === 'string' && manifest.scripts?.test) {
      tasks.push(`${manifest.name}#test`)
    }
  }
  return tasks.sort()
}

/**
 * The sweep is not a default (POD-3890). It is the one lane whose cost is the whole
 * repository — every package's unit task, serially, under the host-wide heavy lease —
 * and an agent reaches for it because it is called `test:full`, not because the change
 * needs it. So a bare run is refused with the map of what it would do and the focused
 * lane that almost always answers the question instead. The same shape as the cache
 * refusal in scripts/typecheck.ts: state the reason, and the run goes ahead.
 */
export function fullSweepRefusal(root: string): string {
  const tasks = expectedTestTasks(root)
  return `\
full test sweep refused: say why the focused lanes are not enough.

WHAT THIS RUNS. \`turbo run test\` over every package that owns a unit lane —
${tasks.length} tasks, one at a time, each capped at two vitest workers:

  ${tasks.join('\n  ')}

(@podium/server is five import-graph shards plus their reconciliation; @podium/web is
the happy-dom suite; @podium/scripts includes the repository audits that read every
tree under apps/, packages/, services/ and tests/.) The run holds the host-wide
\`test:heavy\` lease for its whole duration, so every other heavy lane on this machine
queues behind it. Cached tasks replay; a changed package re-runs in full.

WHAT USUALLY ANSWERS THE QUESTION INSTEAD:

  bun run test                              the lean gate: typecheck, span-effects, boot wiring
  bun run test:file -- <test files...>      exactly those files, right config, admission taken
  bun run test:related -- <source file>     the unit tests that import a changed source
  bun run test:changed                      unit tests touched since HEAD
  bun run test:lane -- <lane> [args]        one named lane: node, normalized-wire, web, mobile,
                                            server-contracts|store|services|boundary, ...
  bun run test:affected                     the packages a change reaches, and their dependents

If the change genuinely needs suite-level evidence, state why:

  bun run test:full -- --full-because="<why the focused lanes are not enough>"

and the sweep runs. The reason is printed at the top of the run.`
}

export interface FullSweepDecision {
  reason: string | null
  forwardArgs: string[]
  error: string | null
}

/** Pure decision: did the caller own the cost of the sweep? */
export function decideFullSweep(argv: string[], root: string): FullSweepDecision {
  const forwardArgs: string[] = []
  let reason: string | null = null
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    if (arg === '--full-because') {
      reason = argv[++index] ?? ''
    } else if (arg.startsWith('--full-because=')) {
      reason = arg.slice('--full-because='.length)
    } else {
      forwardArgs.push(arg)
    }
  }
  if (reason !== null && reason.trim() === '') {
    return { reason, forwardArgs, error: 'empty --full-because reason' }
  }
  if (reason === null) return { reason, forwardArgs, error: fullSweepRefusal(root) }
  return { reason, forwardArgs, error: null }
}

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
  const refusal = admissionRefusal(census, 'test')
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  const admission = decideTestAdmission(process.argv.slice(2))
  if (admission.error) {
    console.error(`test refused: ${admission.error}`)
    process.exit(1)
  }
  let forwardArgs = admission.forwardArgs
  if (!admission.shared) {
    const sweep = decideFullSweep(forwardArgs, root)
    if (sweep.error) {
      console.error(sweep.error)
      process.exit(1)
    }
    console.error(`full sweep, reason: ${sweep.reason}`)
    forwardArgs = sweep.forwardArgs
  }
  const decision = decideForce(forwardArgs, process.env as Record<string, string | undefined>)
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
