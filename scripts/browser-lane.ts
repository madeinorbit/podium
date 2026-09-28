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
 * Five things live here that the Playwright config does not:
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
 * 3. SUITE SELECTION + ZERO-TEST REFUSAL [POD-536]. Playwright ORs positional
 *    path filters, so a hand-passed file path cannot narrow a run that already
 *    appends every suite. Agents then bypass the lane and hit two silent-green
 *    traps: `--project foo` (space form) swallowing a following positional as a
 *    second project name, and piping playwright through tail/grep so the shell
 *    reports the filter's exit status. The lane owns selection via `--suite`
 *    (matched against the discovered list; no match is an error) and refuses to
 *    exit 0 when zero tests were listed for the selected set.
 *
 * 4. THE LEASE. Serializes against other heavy agent lanes that take
 *    `test:heavy`. Does not guarantee a quiet host — other processes still run
 *    outside the lease — and does not cover the fixed Playwright port (8799);
 *    that collision is a separate shared resource. `--build-only` does not take
 *    the lease (callers often already hold it for a hand-run playwright half).
 *
 * 5. THE PREFLIGHT [POD-4752]. Before building, the lane asks Playwright
 *    whether each selected project's browser is supported and installed on
 *    this host, and SKIPS projects whose browser can never run here (webkit
 *    on ubuntu26.04 failed every test with `Playwright does not support
 *    webkit`, drowning the real failures). A supported-but-not-installed
 *    browser is a loud setup error, never a skip; anything unclassifiable
 *    still runs, so the preflight can never hide a real failure.
 *
 * Quarantine lives in ./browser-quarantine.ts — a list, printed every run, not a
 * `testIgnore` glob nobody can see.
 *
 * Usage:
 *   bun run test:browser
 *   bun run test:browser -- --suite clipboard
 *   bun run test:browser -- --suite clipboard --suite tabs --project=chromium-pixel
 *   bun scripts/browser-lane.ts --build-only   # hand-run prep only; prefer --suite
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { QUARANTINE } from './browser-quarantine'
import { runWithHeavyTestLease, shouldAcquireHeavyTestLease } from './test-heavy'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const BROWSER_DIR = fileURLToPath(new URL('../tests/e2e/browser/', import.meta.url))
const CONFIG = 'tests/e2e/playwright.config.ts'
/** Set on the re-entered child so we do not try to acquire the lease twice. */
const LEASE_HELD_ENV = 'PODIUM_BROWSER_LANE_HEAVY_HELD'
export const BUILD_ONLY_FLAG = '--build-only'

const run = (cmd: string, args: string[], capture = false) =>
  spawnSync(cmd, args, { cwd: ROOT, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })

/** Positional args are regexes matched against the test file path — escape the dots. */
export const filterFor = (suite: string) => `browser/${suite.replaceAll('.', '\\.')}$`

const playwright = (args: string[], capture = false) =>
  run('bunx', ['playwright', 'test', '--config', CONFIG, ...args], capture)

/**
 * Workspace packages + web for the test process and harness UI; mobile web
 * export for phone projects. Shared by the full lane and `--build-only` so
 * hand-runs and the lane cannot drift (POD-535).
 */
export function buildBrowserDeps(): number {
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
  const mobile = run('bun', ['run', '--filter', '@podium/mobile', 'build'], true)
  if (mobile.status !== 0) {
    console.error(mobile.stdout ?? '')
    console.error(mobile.stderr ?? '')
    console.error('browser lane: mobile web export failed — phone projects cannot load. Stopping.')
    return 1
  }
  return 0
}

/**
 * Normalize a --suite value to a discovered filename.
 * Accepts `clipboard`, `clipboard.browser.e2e`, or `clipboard.browser.e2e.ts`
 * (optional path prefix is stripped).
 */
export function normalizeSuiteSelector(selector: string): string {
  const base = selector.trim().replace(/\\/g, '/').split('/').pop() ?? selector.trim()
  if (base.endsWith('.browser.e2e.ts')) return base
  if (base.endsWith('.browser.e2e')) return `${base}.ts`
  if (base.endsWith('.ts')) return base
  return `${base}.browser.e2e.ts`
}

export type LaneArgs = {
  /** Empty means "every non-quarantined suite". */
  suiteSelectors: string[]
  /** Remaining argv to forward to Playwright (flags like --project, --grep). */
  forward: string[]
  help: boolean
  buildOnly: boolean
}

/**
 * Pull lane-owned flags out of argv. `--suite` / `--suite=` may repeat.
 * `--build-only` is the hand-run prep path (POD-535). Everything else is
 * forwarded to Playwright unchanged.
 */
export function parseLaneArgs(argv: string[]): LaneArgs {
  const suiteSelectors: string[] = []
  const forward: string[] = []
  let help = false
  let buildOnly = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--help' || a === '-h') {
      help = true
      continue
    }
    if (a === BUILD_ONLY_FLAG) {
      buildOnly = true
      continue
    }
    if (a === '--suite') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('-')) {
        // Missing value: leave a blank so resolveSelectedSuites errors clearly.
        suiteSelectors.push('')
        if (value !== undefined) i--
      } else {
        suiteSelectors.push(value)
      }
      continue
    }
    if (a.startsWith('--suite=')) {
      suiteSelectors.push(a.slice('--suite='.length))
      continue
    }
    forward.push(a)
  }
  return { suiteSelectors, forward, help, buildOnly }
}

export type SuiteSelection =
  | { ok: true; suites: string[] }
  | { ok: false; error: string }

/**
 * Resolve --suite selectors against the discovered suite filenames.
 * No match is a hard error (never silently fall back to the full lane).
 * An empty selector list means "all of `available`".
 */
export function resolveSelectedSuites(
  selectors: string[],
  available: readonly string[],
  quarantined: ReadonlySet<string> = new Set(),
): SuiteSelection {
  if (selectors.length === 0) return { ok: true, suites: [...available] }

  const selected: string[] = []
  const seen = new Set<string>()
  for (const raw of selectors) {
    if (!raw || !raw.trim()) {
      return {
        ok: false,
        error:
          'browser lane: --suite requires a suite name (e.g. --suite clipboard or --suite clipboard.browser.e2e.ts)',
      }
    }
    const name = normalizeSuiteSelector(raw)
    if (!available.includes(name) && !quarantined.has(name)) {
      const hint = available
        .filter((s) => s.includes(raw.replace(/\.browser\.e2e(\.ts)?$/, '') || raw))
        .slice(0, 8)
      const hintLine =
        hint.length > 0
          ? `\nDid you mean:\n${hint.map((h) => `  - ${h}`).join('\n')}`
          : `\n${available.length} suites are available; list them with: bun run test:browser -- --help`
      return {
        ok: false,
        error: `browser lane: --suite "${raw}" matched no discovered suite (normalized: ${name}).${hintLine}`,
      }
    }
    if (quarantined.has(name)) {
      return {
        ok: false,
        error:
          `browser lane: --suite "${raw}" is quarantined and will not run.\n` +
          `Remove it from scripts/browser-quarantine.ts first, or pick another suite.`,
      }
    }
    if (!seen.has(name)) {
      seen.add(name)
      selected.push(name)
    }
  }
  return { ok: true, suites: selected }
}

/** Parse Playwright `--list` summary line: `Total: N tests in M files`. */
export function parseListTotal(output: string): number | null {
  const m = output.match(/Total:\s+(\d+)\s+tests?\b/i)
  return m ? Number(m[1]) : null
}

/**
 * Whether the lane may report success. Playwright's own exit is necessary but
 * not sufficient: an empty selection, import-errored suites, or a listed total
 * of zero must never read as green (POD-536 silent-success hazard).
 */
export function laneMaySucceed(input: {
  playwrightStatus: number | null
  unloadableCount: number
  runningSuiteCount: number
  /** null = could not parse; only hard-fail on an explicit 0. */
  listedTests: number | null
}): { ok: true } | { ok: false; reason: string } {
  if (input.playwrightStatus !== 0) {
    return { ok: false, reason: `playwright exited ${input.playwrightStatus ?? 'null'}` }
  }
  if (input.unloadableCount > 0) {
    return {
      ok: false,
      reason: `${input.unloadableCount} suite(s) failed to import`,
    }
  }
  if (input.runningSuiteCount === 0) {
    return { ok: false, reason: 'no suites handed to playwright' }
  }
  if (input.listedTests === 0) {
    return {
      ok: false,
      reason: 'zero tests listed for the selected suites — refusing success',
    }
  }
  return { ok: true }
}

/**
 * THE PREFLIGHT (5) [POD-4752]. Playwright's own answer per project browser:
 *
 * - `unsupported` — Playwright ships no binary for this host (its
 *   `BrowserType.executablePath()` returns ''). The project can never go
 *   green here, so the lane SKIPS it with one clear line instead of failing
 *   every test in it.
 * - `missing` — supported on this host but the browser is not installed. A
 *   setup error to report loudly, never a skip: running a partial lane over
 *   it would read as coverage.
 * - `ready` / `unknown` — run. Anything the lane cannot classify must still
 *   execute, so the preflight can never hide a project that IS supported
 *   but fails.
 *
 * API used: the public `BrowserType.executablePath()` from `@playwright/test`
 * (chromium/firefox/webkit). It is empty exactly when Playwright has no
 * executable path for this host — the same condition that fails a run with
 * `Playwright does not support <browser> on <host>`. No OS-name parsing in
 * the lane. Project browsers come from the Playwright config's resolved
 * `use.defaultBrowserType`, with the `<browser>-<form>` name prefix as
 * fallback.
 */
export type BrowserSupport =
  | { kind: 'ready' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'missing'; detail: string }
  | { kind: 'unknown'; detail: string }

export type BrowserSupportProbe = (browser: string) => BrowserSupport

export type ConfiguredProject = { name: string; browser: string | null }

/**
 * Pure classifier behind probeBrowserSupport. `executablePath` is what
 * Playwright's `BrowserType.executablePath()` returned ('' = no build for
 * this host); `installed` is whether that path exists on disk.
 */
export function decideBrowserSupport(
  browser: string,
  executablePath: string,
  installed: boolean,
): BrowserSupport {
  if (!executablePath) {
    return {
      kind: 'unsupported',
      reason: `Playwright does not support ${browser} on this host`,
    }
  }
  if (!installed) {
    return {
      kind: 'missing',
      detail:
        `browser "${browser}" is supported on this host but its executable is missing ` +
        `(${executablePath}); install it with: bunx playwright install ${browser}`,
    }
  }
  return { kind: 'ready' }
}

const KNOWN_BROWSERS = new Set(['chromium', 'firefox', 'webkit'])

/**
 * Project browser from the config's device type, else the `<browser>-<form>`
 * name prefix. Null means undeterminable — the project runs anyway.
 */
export function browserForProject(name: string, defaultBrowserType?: string): string | null {
  if (defaultBrowserType && KNOWN_BROWSERS.has(defaultBrowserType)) return defaultBrowserType
  const prefix = name.split('-')[0] ?? ''
  if (KNOWN_BROWSERS.has(prefix)) return prefix
  return null
}

export type ProjectPreflight = {
  runnable: string[]
  skipped: { project: string; browser: string; reason: string }[]
  missing: { project: string; browser: string; detail: string }[]
}

/**
 * Partition the selected projects by probe answer. `selected` null means
 * every configured project; names matching nothing configured pass through
 * to runnable so Playwright itself rejects them (never silently dropped).
 * Each distinct browser is probed exactly once.
 */
export function preflightProjects(
  configured: readonly ConfiguredProject[],
  selected: readonly string[] | null,
  probe: BrowserSupportProbe,
): ProjectPreflight {
  const byName = new Map(configured.map((p) => [p.name, p]))
  const names = selected ?? configured.map((p) => p.name)
  const answers = new Map<string, BrowserSupport>()
  const answerFor = (browser: string): BrowserSupport => {
    const hit = answers.get(browser)
    if (hit) return hit
    const answer = probe(browser)
    answers.set(browser, answer)
    return answer
  }
  const runnable: string[] = []
  const skipped: ProjectPreflight['skipped'] = []
  const missing: ProjectPreflight['missing'] = []
  for (const name of names) {
    const project = byName.get(name)
    if (!project || project.browser === null) {
      runnable.push(name)
      continue
    }
    const answer = answerFor(project.browser)
    if (answer.kind === 'unsupported') {
      skipped.push({ project: name, browser: project.browser, reason: answer.reason })
    } else if (answer.kind === 'missing') {
      missing.push({ project: name, browser: project.browser, detail: answer.detail })
    } else {
      // ready AND unknown run: an unclassifiable browser must never vanish.
      runnable.push(name)
    }
  }
  return { runnable, skipped, missing }
}

/**
 * Read the `--project` selection out of args forwarded to Playwright.
 * `--project=name` takes one name; the bare `--project` form is variadic, so
 * every following non-flag token is a project name (which is also why the
 * lane docs insist on the equals form).
 */
export function projectFilterFromForward(forward: readonly string[]): {
  explicit: string[]
  hasFilter: boolean
} {
  const explicit: string[] = []
  let hasFilter = false
  for (let i = 0; i < forward.length; i++) {
    const arg = forward[i]
    if (arg === undefined) continue
    if (arg === '--project') {
      hasFilter = true
      let next = forward[i + 1]
      while (next !== undefined && !next.startsWith('-')) {
        explicit.push(next)
        i++
        next = forward[i + 1]
      }
      continue
    }
    if (arg.startsWith('--project=')) {
      hasFilter = true
      explicit.push(arg.slice('--project='.length))
    }
  }
  return { explicit, hasFilter }
}

/**
 * Drop every `--project` selection (equals and variadic space forms) so the
 * lane can narrow the run to the preflight's runnable set.
 */
export function stripProjectFlags(forward: readonly string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < forward.length; i++) {
    const arg = forward[i]
    if (arg === undefined) continue
    if (arg === '--project') {
      let next = forward[i + 1]
      while (next !== undefined && !next.startsWith('-')) {
        i++
        next = forward[i + 1]
      }
      continue
    }
    if (arg.startsWith('--project=')) continue
    kept.push(arg)
  }
  return kept
}

type PlaywrightBrowserType = { executablePath: () => string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Ask Playwright whether `browser` can run on this host. Lazy-imports
 * `@playwright/test` (already a root devDependency) so unit tests importing
 * this module never load the runner; the decision itself stays in
 * decideBrowserSupport, which takes fakes.
 */
export async function probeBrowserSupport(browser: string): Promise<BrowserSupport> {
  let browserType: PlaywrightBrowserType | undefined
  try {
    const playwrightTest = (await import('@playwright/test')) as unknown as Record<
      string,
      PlaywrightBrowserType | undefined
    >
    browserType = playwrightTest[browser]
  } catch (error) {
    return { kind: 'unknown', detail: `could not load @playwright/test: ${messageOf(error)}` }
  }
  if (!browserType || typeof browserType.executablePath !== 'function') {
    return { kind: 'unknown', detail: `no Playwright executable named "${browser}"` }
  }
  let executablePath: string
  try {
    executablePath = browserType.executablePath()
  } catch (error) {
    return {
      kind: 'unknown',
      detail: `could not resolve the ${browser} executable: ${messageOf(error)}`,
    }
  }
  return decideBrowserSupport(browser, executablePath, existsSync(executablePath))
}

type PlaywrightConfigShape = {
  projects?: readonly { name?: string; use?: { defaultBrowserType?: string } }[]
}

/**
 * The configured projects with their browsers, straight from the Playwright
 * config Playwright itself will run — never a hardcoded list. Imported
 * lazily by file URL so the scripts typecheck does not absorb tests/e2e/*,
 * and with PODIUM_E2E_RUN_ID restored afterwards: importing the config mints
 * a run id as a side effect (ensureHarnessRunId), and the lane's children
 * must keep minting their own.
 */
export async function loadConfiguredProjects(): Promise<ConfiguredProject[]> {
  const configPath = fileURLToPath(new URL('../tests/e2e/playwright.config.ts', import.meta.url))
  const savedRunId = process.env.PODIUM_E2E_RUN_ID
  try {
    const configUrl = pathToFileURL(configPath).href
    const mod = (await import(configUrl)) as { default?: PlaywrightConfigShape }
    const projects = mod.default?.projects ?? []
    return projects.flatMap((p) => {
      if (!p.name) return []
      return [{ name: p.name, browser: browserForProject(p.name, p.use?.defaultBrowserType) }]
    })
  } finally {
    if (savedRunId === undefined) delete process.env.PODIUM_E2E_RUN_ID
    else process.env.PODIUM_E2E_RUN_ID = savedRunId
  }
}

function printHelp(suites: readonly string[]): void {
  console.log(`browser lane — run Playwright suites under tests/e2e/browser/

Usage:
  bun run test:browser [-- --suite <name>]... [playwright args...]
  bun scripts/browser-lane.ts --build-only

Lane-owned flags:
  --suite <name>   Run only this suite (repeatable). Accepts the short stem
                   (clipboard) or the full filename (clipboard.browser.e2e.ts).
                   Unknown names error out; they never silently run everything.
  --build-only     Build packages + web + mobile export, then exit (hand-run
                   prep when you must bypass the lane). Does not take test:heavy.
  -h, --help       Show this help and the discovered suite list.

Preferred one-suite path (builds + selects + probes inside the lane):
  bun run test:browser -- --suite clipboard --project=chromium-pixel

Playwright args (forwarded unchanged) examples:
  --project=chromium-pixel   Prefer the equals form: --project is variadic, so
                             --project chromium-pixel <filter> treats <filter>
                             as a second project name (zero tests, easy to miss
                             if the shell pipes away the exit status).
  --grep <regex>             Filter tests by title within the selected suites.

Do not pipe this command through tail/grep/head without pipefail — the filter's
exit status will mask Playwright's. Prefer redirecting to a file.

Projects whose browser Playwright cannot run on this host are SKIPPED with one
clear line each (and named in the census) instead of failing every test in
them. A supported-but-not-installed browser is a loud setup error, never a skip.

Discovered suites (${suites.length}):
${suites.map((s) => `  ${s.replace(/\.browser\.e2e\.ts$/, '')}`).join('\n')}
`)
}

async function runLane(args: LaneArgs): Promise<number> {
  const suites = readdirSync(BROWSER_DIR)
    .filter((f) => f.endsWith('.browser.e2e.ts'))
    .sort()

  if (args.help) {
    printHelp(suites)
    return 0
  }

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
  const selection = resolveSelectedSuites(
    args.suiteSelectors,
    suites.filter((s) => !excluded.has(s)),
    excluded,
  )
  if (!selection.ok) {
    console.error(selection.error)
    return 2
  }

  // When --suite was given, only those; otherwise every non-quarantined suite.
  const candidates = selection.suites

  console.log(`\n━━━ browser lane — ${suites.length} suites found ━━━`)
  if (args.suiteSelectors.length > 0) {
    console.log(
      `SELECTED (${candidates.length}):\n` + candidates.map((s) => `  - ${s}`).join('\n'),
    )
  }
  if (QUARANTINE.length > 0) {
    console.log(`QUARANTINED (${QUARANTINE.length}, not run):`)
    for (const q of QUARANTINE) console.log(`  - ${q.suite}\n      ${q.reason}`)
  } else {
    console.log('QUARANTINED: none — every suite is eligible.')
  }

  if (candidates.length === 0) {
    console.error(
      'browser lane: nothing to run (every suite is quarantined or the selection is empty).',
    )
    return 1
  }

  // THE PREFLIGHT (5): ask Playwright per project browser before paying for a
  // build. Unsupported projects are skipped with one clear line each and the
  // run is narrowed to the runnable set; a supported-but-not-installed
  // browser aborts loudly before the build. When the config cannot be read at
  // all, proceed unfiltered — the Playwright run itself will fail loudly.
  const configured = await loadConfiguredProjects().catch((error) => {
    console.log(
      `browser lane preflight: could not read Playwright projects ` +
        `(${messageOf(error)}) — running every project unfiltered.`,
    )
    return null
  })
  let effectiveForward = args.forward
  let projectArgs: string[] = []
  let skipped: ProjectPreflight['skipped'] = []
  if (configured !== null) {
    const { explicit, hasFilter } = projectFilterFromForward(args.forward)
    const selected = hasFilter && explicit.length > 0 ? explicit : null
    const wanted = selected ?? configured.map((p) => p.name)
    const browsers = [
      ...new Set(
        wanted.flatMap((name) => {
          const found = configured.find((p) => p.name === name)
          return found && found.browser !== null ? [found.browser] : []
        }),
      ),
    ]
    const answers = new Map<string, BrowserSupport>()
    for (const browser of browsers) answers.set(browser, await probeBrowserSupport(browser))
    const unknown: BrowserSupport = {
      kind: 'unknown',
      detail: 'browser was not probed',
    }
    const preflight = preflightProjects(
      configured,
      selected,
      (browser): BrowserSupport => answers.get(browser) ?? unknown,
    )
    skipped = preflight.skipped
    if (skipped.length > 0) {
      console.log('preflight: skipping projects Playwright cannot run on this host:')
      for (const s of skipped) console.log(`  ${s.project} skipped: ${s.reason}`)
    } else {
      console.log(
        `preflight: all ${preflight.runnable.length} selected project(s) supported on this host.`,
      )
    }
    if (preflight.missing.length > 0) {
      for (const m of preflight.missing) console.error(`browser lane: ${m.detail}`)
      console.error(
        `browser lane: ${preflight.missing.length} project(s) target a browser that is ` +
          `supported on this host but not installed — refusing to run a partial lane.`,
      )
      return 1
    }
    if (preflight.runnable.length === 0) {
      console.error(
        'browser lane: every selected project is unsupported on this host — nothing to run.',
      )
      return 1
    }
    if (skipped.length > 0) {
      // Narrow this run to the runnable set (equals form — never the variadic
      // space form that swallows the next token as a project name).
      effectiveForward = stripProjectFlags(args.forward)
      projectArgs = preflight.runnable.map((p) => `--project=${p}`)
      console.log(`preflight: running projects: ${preflight.runnable.join(', ')}`)
    }
  }

  const built = buildBrowserDeps()
  if (built !== 0) return built

  // One whole-set probe first (fast, no webServer); only bisect per file if it trips.
  console.log('probing that every selected suite imports…')
  const unloadable: string[] = []
  const listProbe = playwright(['--list', ...projectArgs, ...candidates.map(filterFor)], true)
  if (listProbe.status !== 0) {
    for (const suite of candidates) {
      const probe = playwright(['--list', ...projectArgs, filterFor(suite)], true)
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
  const listOutput = `${listProbe.stdout ?? ''}${listProbe.stderr ?? ''}`
  // When the whole-set probe failed we bisected; re-list the runnable set so the
  // zero-test guard sees the count that will actually execute.
  let listedTests = parseListTotal(listOutput)
  if (unloadable.length > 0 && running.length > 0) {
    const rerun = playwright(['--list', ...projectArgs, ...running.map(filterFor)], true)
    listedTests = parseListTotal(`${rerun.stdout ?? ''}${rerun.stderr ?? ''}`)
  } else if (unloadable.length > 0 && running.length === 0) {
    listedTests = 0
  }

  console.log(
    `\nrunning ${running.length} suites (${unloadable.length} errored on import, ` +
      `${QUARANTINE.length} quarantined` +
      (args.suiteSelectors.length > 0 ? `, ${args.suiteSelectors.length} --suite selector(s)` : '') +
      (projectArgs.length > 0 ? `, ${projectArgs.length} project(s)` : '') +
      `)` +
      (listedTests !== null ? ` — ${listedTests} tests listed` : '') +
      `\n`,
  )

  if (running.length === 0) {
    console.error('browser lane: every selected suite failed to import — nothing to run.')
    return 1
  }

  if (listedTests === 0) {
    console.error(
      'browser lane: zero tests listed for the selected suites — refusing to report success.\n' +
        'Check --suite / --grep / --project filters. Prefer --project=name (equals form).',
    )
    return 1
  }

  const result = playwright([...effectiveForward, ...projectArgs, ...running.map(filterFor)])

  console.log(`\n━━━ browser lane census ━━━`)
  console.log(`  suites found:        ${suites.length}`)
  if (args.suiteSelectors.length > 0) {
    console.log(`  selected via --suite:${candidates.length}`)
  }
  console.log(`  quarantined:         ${QUARANTINE.length}`)
  console.log(
    `  skipped (unsupported on this host): ${skipped.length}` +
      (skipped.length ? ` (${skipped.map((s) => s.project).join(', ')})` : ''),
  )
  console.log(
    `  errored on import:   ${unloadable.length}${unloadable.length ? ` (${unloadable.join(', ')})` : ''}`,
  )
  console.log(
    `  handed to playwright:${running.length}` +
      (listedTests !== null ? `  (${listedTests} tests listed)` : '') +
      `  → see the run summary above for pass/fail`,
  )

  // An import error is a red lane even when Playwright's own run was clean: those
  // suites did not run, and a lane that reports 0 failures for a suite it never
  // loaded is the exact instrument POD-1227 existed to remove. Zero listed tests
  // is the POD-536 silent-success signature and is also red.
  const verdict = laneMaySucceed({
    playwrightStatus: result.status,
    unloadableCount: unloadable.length,
    runningSuiteCount: running.length,
    listedTests,
  })
  if (!verdict.ok) {
    console.error(`browser lane: refusing success — ${verdict.reason}`)
    return 1
  }
  return 0
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const args = parseLaneArgs(argv)

  // Hand-run prep path (POD-535 / POD-503): build once, then optionally bunx
  // playwright. Prefer `bun run test:browser -- --suite <name>` (POD-536) so
  // selection, probe, and build stay in one process. Do NOT take the lease here
  // — callers often already hold test:heavy for the playwright half; nested
  // acquire deadlocks on the same lock.
  if (args.buildOnly) {
    if (args.suiteSelectors.length > 0) {
      console.error(
        'browser lane: --build-only cannot be combined with --suite.\n' +
          'Use `bun run test:browser -- --suite <name>` for a selected run (builds included),\n' +
          'or `--build-only` alone for hand-run prep.',
      )
      return 2
    }
    console.log('━━━ browser lane — build-only (hand-run prep) ━━━')
    const code = buildBrowserDeps()
    if (code === 0) {
      console.log(
        [
          '',
          'browser lane: build-only done.',
          'Preferred next step (stays on the lane):',
          '  bun run test:browser -- --suite <stem> --project=chromium-pixel',
          'Hand-run playwright only if you must bypass the lane:',
          '  bunx playwright test --config tests/e2e/playwright.config.ts --project=chromium-pixel <suite-regex>',
          'Use --project=equals form (space form swallows the next arg as a project name).',
        ].join('\n'),
      )
    }
    return code
  }

  // Live sessions re-enter under test:heavy so bare `bun scripts/browser-lane.ts`
  // and `bun run test:browser` both serialize. Nested acquire would deadlock if
  // we already hold the lease via the re-entry env flag. Help exits before the
  // lease so listing suites stays cheap.
  if (args.help) {
    const suites = readdirSync(BROWSER_DIR)
      .filter((f) => f.endsWith('.browser.e2e.ts'))
      .sort()
    printHelp(suites)
    return 0
  }

  if (shouldAcquireHeavyTestLease(process.env) && process.env[LEASE_HELD_ENV] !== '1') {
    console.log('browser lane: acquiring test:heavy lease for this session…')
    return runWithHeavyTestLease([process.execPath, import.meta.path, ...argv], {
      cwd: ROOT,
      env: { ...process.env, [LEASE_HELD_ENV]: '1' },
    })
  }
  return runLane(args)
}

if (import.meta.main) process.exit(await main())
