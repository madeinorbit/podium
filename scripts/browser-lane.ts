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
 * Invoke via `bun run test:browser` (not this file bare). The package script
 * wraps this process in `scripts/test-heavy.ts` so a live session takes the
 * shared `test:heavy` lease for the whole build + webServer + run. The chain
 * fits a quiet host in ~100s; without the lease it races integration/e2e and
 * the webServer 180s cliff reappears under contention (POD-535).
 *
 * The Playwright config is used UNCHANGED. Two things live here instead:
 *
 * 1. THE BUILD. The test process imports `@podium/protocol` without
 *    `--conditions=@podium/source`, so it resolves to `dist`, which imports
 *    `@podium/model`'s `dist` — and a fresh checkout has neither. The config's
 *    `webServer` builds protocol + web for the SERVER; nothing built the
 *    packages the TEST process itself loads. Without this step every suite dies
 *    on `Cannot find module .../packages/model/dist/index.js`.
 *
 * 2. THE LOAD PROBE. Playwright aborts the whole run when ONE file fails to
 *    import — `Total: 0 tests in 0 files`, exit non-zero, no census. That is how
 *    a single stale import in a shared helper can make 70 suites report as
 *    nothing at all. So the lane probes first, reports the unloadable suites as
 *    ERRORED (they are broken, and named as broken), and runs the rest, so one
 *    rotten import cannot hide the state of the other 69.
 *
 * Quarantine lives in ./browser-quarantine.ts — a list, printed every run, not a
 * `testIgnore` glob nobody can see.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { QUARANTINE } from './browser-quarantine'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const BROWSER_DIR = fileURLToPath(new URL('../tests/e2e/browser/', import.meta.url))
const CONFIG = 'tests/e2e/playwright.config.ts'

const run = (cmd: string, args: string[], capture = false) =>
  spawnSync(cmd, args, { cwd: ROOT, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })

/** Positional args are regexes matched against the test file path — escape the dots. */
const filterFor = (suite: string) => `browser/${suite.replaceAll('.', '\\.')}$`

const playwright = (args: string[], capture = false) =>
  run('bunx', ['playwright', 'test', '--config', CONFIG, ...args], capture)

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
  process.exit(2)
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

console.log('\nbuilding workspace packages (the test process loads them from dist)…')
const built = run('bun', ['run', 'build'], true)
if (built.status !== 0) {
  console.error(built.stdout ?? '')
  console.error(built.stderr ?? '')
  console.error('browser lane: package build failed — no suite can load. Stopping.')
  process.exit(1)
}

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

const result = playwright([...process.argv.slice(2), ...running.map(filterFor)])

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
process.exit(result.status === 0 && unloadable.length === 0 ? 0 : 1)
