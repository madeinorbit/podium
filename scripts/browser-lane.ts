#!/usr/bin/env bun
/**
 * The browser lane [POD-1227]: the one runnable entry point for
 * `tests/e2e/browser/**.browser.e2e.ts` under `tests/e2e/playwright.config.ts`.
 *
 * These suites existed for months with no script, no lane and no CI job — each
 * was run once by hand by the agent that wrote it and never again, while
 * "runtime verified" in handoffs and merge commits kept borrowing their
 * authority (POD-756 counted them and did not run them). This file is the lane.
 *
 * Invoke via `bun run test:browser` or this file directly. From a live session
 * the full lane takes the shared `test:heavy` lease (POD-535).
 *
 * Hand-run one suite (until POD-536 can select for you):
 *   bun scripts/browser-lane.ts --build-only
 *   bunx playwright test --config tests/e2e/playwright.config.ts --project=chromium-pixel <suite>
 * `--build-only` does not take the lease (callers often already hold it for the
 * playwright half; nested acquire would deadlock).
 *
 * Three things live here that the Playwright config does not:
 *
 * 1. THE BUILD (POD-535 / POD-1389). The test process imports `@podium/protocol`
 *    without `--conditions=@podium/source`, so it resolves to `dist`. The
 *    harness also serves `apps/web/dist` and the Expo mobile export. Both used
 *    to rebuild inside Playwright's webServer command, so every run paid a
 *    second multi-minute chain under Playwright's wall clock and timed out at
 *    180s under host load. The lane builds once — workspace packages + web +
 *    mobile web export — then webServer only boots serve-harness (~5s).
 *
 * 2. THE LOAD PROBE. Playwright aborts the whole run when ONE file fails to
 *    import — `Total: 0 tests in 0 files`, exit non-zero, no census. That is how
 *    a single stale import in a shared helper can make 70 suites report as
 *    nothing at all. So the lane probes first, reports the unloadable suites as
 *    ERRORED (they are broken, and named as broken), and runs the rest, so one
 *    rotten import cannot hide the state of the other 69.
 *
 * 3. THE LEASE. Serializes against other heavy agent lanes that take
 *    `test:heavy`. Does not guarantee a quiet host — other processes still run
 *    outside the lease — and does not cover the fixed Playwright port (8799);
 *    that collision is a separate shared resource.
 *
 * Quarantine lives in ./browser-quarantine.ts — a list, printed every run, not a
 * `testIgnore` glob nobody can see.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { QUARANTINE } from './browser-quarantine'
import { runWithHeavyTestLease, shouldAcquireHeavyTestLease } from './test-heavy'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const BROWSER_DIR = fileURLToPath(new URL('../tests/e2e/browser/', import.meta.url))
const CONFIG = 'tests/e2e/playwright.config.ts'
/** Set on the re-entered child so we do not try to acquire the lease twice. */
const LEASE_HELD_ENV = 'PODIUM_BROWSER_LANE_HEAVY_HELD'
const BUILD_ONLY_FLAG = '--build-only'

const run = (cmd: string, args: string[], capture = false) =>
  spawnSync(cmd, args, { cwd: ROOT, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })

/** Positional args are regexes matched against the test file path — escape the dots. */
const filterFor = (suite: string) => `browser/${suite.replaceAll('.', '\\.')}$`

const playwright = (args: string[], capture = false) =>
  run('bunx', ['playwright', 'test', '--config', CONFIG, ...args], capture)

/**
 * Workspace packages + web for the test process and harness UI; mobile web
 * export for phone projects. Shared by the full lane and `--build-only` so
 * hand-runs and the lane cannot drift (POD-535).
 */
function buildBrowserDeps(): number {
  // Order: root `bun run build` is packages/* then @podium/web (POD-1389).
  // Mobile is not in the root build — export it separately.
  console.log('\nbuilding workspace packages + web (test process + harness UI)…')
  const built = run('bun', ['run', 'build'], true)
  if (built.status !== 0) {
    console.error(built.stdout ?? '')
    console.error(built.stderr ?? '')
    console.error('browser lane: package build failed — no suite can load. Stopping.')
    return 1
  }
  console.log('building @podium/mobile web export (served at /mobile)…')
  const mobile = run('bun', ['run', '--filter', '@podium/mobile', 'build:web'], true)
  if (mobile.status !== 0) {
    console.error(mobile.stdout ?? '')
    console.error(mobile.stderr ?? '')
    console.error('browser lane: mobile web export failed — phone projects cannot load. Stopping.')
    return 1
  }
  return 0
}

function runLane(playwrightArgs: string[]): number {
  const suites = readdirSync(BROWSER_DIR)
    .filter((f) => f.endsWith('.browser.e2e.ts'))
    .sort()

  /** A stale entry (renamed or deleted suite) silently quarantines nothing, so it fails loudly. */
  const stale = QUARANTINE.filter((q) => !suites.includes(q.suite))
  if (stale.length > 0) {
    console.error(
      `browser lane: quarantine names ${stale.length} suite(s) that do not exist:\n` +
        stale.map((q) => `  - ${q.suite}`).join('\n') +
        '\nRemove the entry or fix the filename.',
    )
    return 2
  }

  const excluded = new Set(QUARANTINE.map((q) => q.suite))
  const candidates = suites.filter((s) => !excluded.has(s))

  console.log(`\n━━━ browser lane — ${suites.length} suites found ━━━`)
  if (QUARANTINE.length > 0) {
    console.log(`QUARANTINED (${QUARANTINE.length}, not run):`)
    for (const q of QUARANTINE) console.log(`  - ${q.suite}\n      ${q.reason}`)
  } else {
    console.log('QUARANTINED: none — every suite runs.')
  }

  const built = buildBrowserDeps()
  if (built !== 0) return built

  // One whole-set probe first (fast, no webServer); only bisect per file if it trips.
  console.log('probing that every suite imports…')
  const unloadable: string[] = []
  if (playwright(['--list', ...candidates.map(filterFor)], true).status !== 0) {
    for (const suite of candidates) {
      const probe = playwright(['--list', filterFor(suite)], true)
      if (probe.status !== 0) {
        const why = `${probe.stdout ?? ''}${probe.stderr ?? ''}`
          .split('\n')
          .find((l) => l.startsWith('Error:'))
        unloadable.push(suite)
        console.log(`  ERRORED (does not import): ${suite}\n      ${why ?? 'unknown import error'}`)
      }
    }
  }

  const running = candidates.filter((s) => !unloadable.includes(s))
  console.log(
    `\nrunning ${running.length} suites (${unloadable.length} errored on import, ` +
      `${QUARANTINE.length} quarantined)\n`,
  )

  const result = playwright([...playwrightArgs, ...running.map(filterFor)])

  console.log(`\n━━━ browser lane census ━━━`)
  console.log(`  suites found:        ${suites.length}`)
  console.log(`  quarantined:         ${QUARANTINE.length}`)
  console.log(
    `  errored on import:   ${unloadable.length}${unloadable.length ? ` (${unloadable.join(', ')})` : ''}`,
  )
  console.log(`  handed to playwright:${running.length}  → see the run summary above for pass/fail`)

  // An import error is a red lane even when Playwright's own run was clean: those
  // suites did not run, and a lane that reports 0 failures for a suite it never
  // loaded is the exact instrument this issue exists to remove.
  return result.status === 0 && unloadable.length === 0 ? 0 : 1
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const buildOnly = argv.includes(BUILD_ONLY_FLAG)
  const playwrightArgs = argv.filter((a) => a !== BUILD_ONLY_FLAG)

  // Hand-run path (POD-503): build once, then bunx playwright with a suite filter.
  // Do NOT take the lease here — callers often already hold test:heavy for the
  // playwright half; nested acquire deadlocks on the same lock.
  if (buildOnly) {
    console.log('━━━ browser lane — build-only (hand-run prep) ━━━')
    const code = buildBrowserDeps()
    if (code === 0) {
      console.log(
        [
          '',
          'browser lane: build-only done. Hand-run playwright next, e.g.:',
          '  bunx playwright test --config tests/e2e/playwright.config.ts --project=chromium-pixel <suite-regex>',
          'Use --project=equals form (space form swallows the next arg as a project name).',
        ].join('\n'),
      )
    }
    return code
  }

  // Live sessions re-enter under test:heavy so bare `bun scripts/browser-lane.ts`
  // and `bun run test:browser` both serialize. Nested acquire would deadlock if
  // we already hold the lease via the re-entry env flag.
  if (shouldAcquireHeavyTestLease(process.env) && process.env[LEASE_HELD_ENV] !== '1') {
    console.log('browser lane: acquiring test:heavy lease for this session…')
    return runWithHeavyTestLease([process.execPath, import.meta.path, ...argv], {
      cwd: ROOT,
      env: { ...process.env, [LEASE_HELD_ENV]: '1' },
    })
  }
  return runLane(playwrightArgs)
}

process.exit(await main())
