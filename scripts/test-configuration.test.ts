import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import desktopConfig from '../apps/desktop/vitest.config'
import mobileConfig from '../apps/mobile/vitest.config'
import serverBoundaryConfig from '../apps/server/vitest.boundary.config'
import serverPackageConfig from '../apps/server/vitest.config'
import serverContractsConfig from '../apps/server/vitest.contracts.config'
import normalizedWirePackageConfig from '../apps/server/vitest.normalized-wire.config'
import serverServicesConfig from '../apps/server/vitest.services.config'
import serverStoreConfig from '../apps/server/vitest.store.config'
import webConfig from '../apps/web/vitest.config'
import frontendPerfConfig from '../apps/web/vitest.frontend-perf.config'
import phase3BrowserConfig from '../tests/e2e/.phase3-playwright.config'
import browserConfig from '../tests/e2e/playwright.config'
import acceptanceConfig from '../vitest.acceptance.config'
import agentSmokeConfig from '../vitest.agent-smoke.config'
import rootConfig, { resolveTestWorkerLimit, sharedVitestConfig } from '../vitest.config'
import integrationConfig from '../vitest.integration.config'
import { ptySmokeTests, realAgentSmokeTests } from '../vitest.smoke-requirements'
import unitConfig, { normalizedWireTests } from '../vitest.unit.config'
import { REAL_AGENT_CLIS } from './agent-smoke-reporter'
import { QUARANTINE } from './browser-quarantine'
import { HEAVY_LANES, ORACLE_LANES } from './oracle'
import { runWithHeavyTestLease } from './test-heavy'
import scriptsConfig from './vitest.config'

type Project =
  | string
  | {
      test?: {
        name?: string
        exclude?: string[]
        include?: string[]
        retry?: number
        minWorkers?: number
        maxWorkers?: number
        fileParallelism?: boolean
        sequence?: { groupOrder?: number }
        setupFiles?: string[]
        globalSetup?: string[]
      }
    }
type Config = {
  test?: {
    name?: string
    env?: Record<string, string>
    exclude?: string[]
    include?: string[]
    projects?: Project[]
    retry?: number
    passWithNoTests?: boolean
    minWorkers?: number
    maxWorkers?: number
    fileParallelism?: boolean
    setupFiles?: string[]
    globalSetup?: string[]
    testTimeout?: number
  }
}

const config = (value: unknown): Config => value as Config
const repoRoot = new URL('../', import.meta.url)
/** The five POD-520 cache shards, which together are the @podium/server test lane. */
const serverShardConfigs = [
  ['contracts', serverContractsConfig],
  ['store', serverStoreConfig],
  ['services', serverServicesConfig],
  ['boundary', serverBoundaryConfig],
  ['normalized-wire', normalizedWirePackageConfig],
] as const
const sharedSetupFiles = sharedVitestConfig.test.setupFiles.map((file) =>
  fileURLToPath(new URL(file, repoRoot)),
)

const smokeTestFiles = (dir: URL, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (['.git', '.worktrees', 'node_modules'].includes(entry.name)) return []
      return smokeTestFiles(new URL(`${entry.name}/`, dir), relative)
    }
    return /\.smoke\.test\.(?:ts|tsx)$/.test(entry.name) ? [relative] : []
  })
const namedProject = (value: unknown, name: string) => {
  const project = config(value).test?.projects?.find(
    (candidate): candidate is Exclude<Project, string> =>
      typeof candidate !== 'string' && candidate.test?.name === name,
  )
  if (!project) throw new Error(`${name} Vitest project is missing`)
  return project
}
const nodeProject = (value: unknown) => namedProject(value, 'node')
const webServerEntry = (value: unknown): { command: string; timeout?: number } => {
  const webServer = (value as { webServer?: unknown }).webServer
  const server = Array.isArray(webServer) ? webServer[0] : webServer
  if (!server || typeof server !== 'object' || !('command' in server)) {
    throw new Error('Playwright webServer command is missing')
  }
  const command = (server as { command: unknown }).command
  if (typeof command !== 'string') throw new Error('Playwright webServer command is not a string')
  const timeout = (server as { timeout?: unknown }).timeout
  if (timeout !== undefined && typeof timeout !== 'number') {
    throw new Error('Playwright webServer timeout is not a number')
  }
  return { command, timeout: timeout as number | undefined }
}
const webServerCommand = (value: unknown): string => webServerEntry(value).command

describe('test lane configuration', () => {
  it('never collects ignored nested worktrees', () => {
    expect(nodeProject(rootConfig).test?.exclude).toContain('**/.worktrees/**')
  })

  it('fails Vitest and Bun cases that lose their isolated state root', () => {
    expect(nodeProject(rootConfig).test?.setupFiles).toEqual([
      './test-hermetic-env.ts',
      './test-hermetic-vitest-hooks.ts',
      // POD-523: pre-migrated store fixture. Listed here (rather than only in the
      // server package) because every lane that collects apps/server must make the
      // same real-chain-vs-clone decision per file.
      './test-pre-migrated-store.ts',
    ])
    const bunfig = readFileSync(new URL('../bunfig.toml', import.meta.url), 'utf8')
    expect(bunfig).toContain('preload = ["./test-hermetic-env.ts", "./test-hermetic-bun-hooks.ts"]')
  })

  it('keeps web and mobile on the shared Vitest hardening', () => {
    expect(config(webConfig).test?.setupFiles, 'web lost hermetic setup files').toEqual(
      sharedSetupFiles,
    )
    // Mobile keeps the shared hermetic pair and adds `one-react.ts` last so a
    // dual-React checkout fails with a message that names the fix (3c11c8f43).
    expect(config(mobileConfig).test?.setupFiles, 'mobile lost hermetic setup files').toEqual([
      ...sharedSetupFiles,
      fileURLToPath(new URL('../apps/mobile/test/one-react.ts', import.meta.url)),
    ])
    for (const [name, appConfig] of [
      ['web', webConfig],
      ['mobile', mobileConfig],
    ] as const) {
      expect(config(appConfig).test?.testTimeout, `${name} lost the shared timeout`).toBe(
        sharedVitestConfig.test.testTimeout,
      )
    }
  })

  it('builds the pre-migrated schema image in every lane that collects apps/server', () => {
    // POD-523. The setupFile decides per test FILE whether to clone or migrate; this
    // globalSetup is what gives it something to clone. A lane that lost it does not
    // fail — every store quietly goes back to replaying 54 migrations — so the
    // config is asserted here and the runtime effect in
    // apps/server/src/pre-migrated-store-wiring.test.ts.
    const globalSetup = [fileURLToPath(new URL('test-pre-migrated-schema.ts', repoRoot))]
    expect(sharedVitestConfig.test.globalSetup).toEqual(globalSetup)
    for (const [name, lane] of [
      ['root node', nodeProject(rootConfig)],
      ['unit node', nodeProject(unitConfig)],
      ['integration', config(integrationConfig)],
      ['server package', config(serverPackageConfig)],
      ['server normalized-wire', config(normalizedWirePackageConfig)],
    ] as const) {
      expect(lane.test?.globalSetup, `${name} lost the schema image globalSetup`).toEqual(
        globalSetup,
      )
    }
  })

  it('keeps package-owned lanes on shared Vitest hardening', () => {
    for (const packageConfig of [scriptsConfig, desktopConfig]) {
      expect(config(packageConfig).test?.setupFiles).toEqual(sharedVitestConfig.test.setupFiles)
      expect(config(packageConfig).test?.maxWorkers).toBe(sharedVitestConfig.test.maxWorkers)
    }
    // Sorted: the shard's include comes from the generated manifest, which is sorted,
    // while normalizedWireTests is written in run order. Same two files either way.
    expect([...(config(normalizedWirePackageConfig).test?.include ?? [])].sort()).toEqual(
      [...normalizedWireTests].sort(),
    )
    expect(config(normalizedWirePackageConfig).test?.fileParallelism).toBe(false)
    expect(config(normalizedWirePackageConfig).test?.maxWorkers).toBe(1)
  })

  it('keeps every server shard on the shared hermetic setup and worker cap [POD-520]', () => {
    // The split turned one server lane into five. Each is a separate Vitest invocation, so
    // each can lose the hardening on its own: the env scrubber that keeps a suite off the
    // live instance, POD-523's store fixture, and the two-worker cap that keeps the shared
    // six-core host survivable when Turbo runs the shards back to back.
    for (const [name, shardConfig] of serverShardConfigs) {
      expect(config(shardConfig).test?.setupFiles, `${name} lost hermetic setup`).toEqual(
        sharedVitestConfig.test.setupFiles,
      )
      expect(config(shardConfig).test?.globalSetup, `${name} lost the schema image`).toEqual([
        fileURLToPath(new URL('test-pre-migrated-schema.ts', repoRoot)),
      ])
      expect(config(shardConfig).test?.testTimeout).toBe(sharedVitestConfig.test.testTimeout)
      expect(config(shardConfig).test?.retry, `${name} gained a retry`).toBe(0)
      // An explicit file list that collects nothing means the manifest and the filesystem
      // disagree. That has to be a failure, or a mis-generated shard passes as a green.
      expect(config(shardConfig).test?.passWithNoTests, `${name} would pass empty`).toBe(false)
      // normalized-wire is the deliberately serialized one; the rest keep the shared cap.
      const serialized = name === 'normalized-wire'
      expect(config(shardConfig).test?.maxWorkers).toBe(serialized ? 1 : 2)
    }
  })

  it('keeps retries out of the default project and scopes them to integration', () => {
    expect(nodeProject(rootConfig).test?.retry).toBeUndefined()
    expect(nodeProject(unitConfig).test?.retry).toBe(0)
    expect(namedProject(unitConfig, 'normalized-wire').test?.retry).toBe(0)
    expect(config(integrationConfig).test?.retry).toBe(1)
  })
  it('caps forked lanes for the shared host', () => {
    const rootNode = nodeProject(rootConfig).test
    expect(rootNode?.fileParallelism).toBe(true)
    expect(rootNode?.minWorkers).toBe(1)
    expect(rootNode?.maxWorkers).toBe(2)
    expect(config(integrationConfig).test?.minWorkers).toBe(1)
    expect(config(integrationConfig).test?.maxWorkers).toBe(2)
    for (const appConfig of [webConfig, mobileConfig]) {
      expect(config(appConfig).test?.maxWorkers).toBe(sharedVitestConfig.test.maxWorkers)
    }
  })

  it('defaults worker limits safely and accepts explicit host overrides', () => {
    expect(resolveTestWorkerLimit(undefined)).toBe(2)
    expect(resolveTestWorkerLimit('6')).toBe(6)
    expect(resolveTestWorkerLimit(' auto ')).toBeUndefined()
    expect(() => resolveTestWorkerLimit('0')).toThrow(
      'PODIUM_TEST_WORKERS must be a positive integer or "auto"',
    )
  })

  it('runs normalized-wire load guards after the parallel unit pool', () => {
    const regular = nodeProject(unitConfig).test
    const normalized = namedProject(unitConfig, 'normalized-wire').test
    expect(regular?.exclude).toEqual(expect.arrayContaining(normalizedWireTests))
    expect(regular?.sequence?.groupOrder).toBe(0)
    expect(normalized?.include).toEqual(normalizedWireTests)
    expect(normalized?.fileParallelism).toBe(false)
    expect(normalized?.maxWorkers).toBe(1)
    expect(normalized?.sequence?.groupOrder).toBe(1)
  })

  it('keeps deterministic integration and real-agent smoke scopes explicit', () => {
    expect(config(integrationConfig).test?.include).toContain('apps/daemon/src/daemon.test.ts')
    for (const test of ptySmokeTests) {
      expect(nodeProject(unitConfig).test?.exclude).toContain(test)
      expect(config(integrationConfig).test?.include).toContain(test)
      expect(config(agentSmokeConfig).test?.include).not.toContain(test)
    }
    for (const test of realAgentSmokeTests) {
      expect(nodeProject(unitConfig).test?.exclude).toContain(test)
      expect(config(integrationConfig).test?.include).not.toContain(test)
      expect(config(agentSmokeConfig).test?.include).toContain(test)
    }
    expect(smokeTestFiles(new URL('../', import.meta.url)).sort()).toEqual(
      [...ptySmokeTests, ...realAgentSmokeTests].sort(),
    )
    expect(config(integrationConfig).test?.projects).toBeUndefined()
    expect(config(acceptanceConfig).test?.include).toEqual([
      'scripts/loop-split-load.integration.test.ts',
    ])
    expect(config(acceptanceConfig).test?.fileParallelism).toBe(false)
    expect(config(acceptanceConfig).test?.maxWorkers).toBe(1)
    // The smoke config must NOT set PODIUM_REAL_CLI via test.env: vitest writes test.env
    // into worker process.env before files load, which would defeat the opt-in gate and
    // launch real agent CLIs on a bare `vitest run --config vitest.agent-smoke.config.ts`.
    // The opt-in lives in the `test:smoke:agents` script instead (asserted below).
    expect(config(agentSmokeConfig).test?.env?.PODIUM_REAL_CLI).toBeUndefined()
    expect(config(agentSmokeConfig).test?.projects).toBeUndefined()
    expect(config(agentSmokeConfig).test?.exclude).toContain('apps/web/**')
  })
  it('keeps an all-five turn-and-resume case in the real-agent lane', () => {
    const source = readFileSync(
      new URL('../apps/daemon/src/headless-drivers.smoke.test.ts', import.meta.url),
      'utf8',
    )
    const kind = {
      claude: 'claude-code',
      codex: 'codex',
      opencode: 'opencode',
      cursor: 'cursor',
      grok: 'grok',
    } as const
    for (const cli of REAL_AGENT_CLIS) expect(source).toContain(`agent: '${kind[cli]}'`)
  })

  it('keeps the frontend performance lane deterministic and explicit', () => {
    expect(config(frontendPerfConfig).test?.include).toEqual([
      'src/perf/large-state.frontend-perf.tsx',
    ])
    expect(config(frontendPerfConfig).test?.retry).toBe(0)
    expect(config(frontendPerfConfig).test?.maxWorkers).toBe(1)
    expect(config(frontendPerfConfig).test?.fileParallelism).toBe(false)
  })

  it('routes the default unit lane through cached package tasks', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.test).toBe('bun scripts/test.ts')
    expect(pkg.scripts['test:unit']).toBe('bun scripts/test.ts')
    expect(pkg.scripts.test).not.toContain('vitest.unit.config.ts')
    expect(pkg.scripts.test).not.toContain('test:web')
    expect(pkg.scripts.test).not.toContain('test:bun:unit')
    expect(pkg.scripts.test).not.toContain('test:integration')
    expect(pkg.scripts.test).not.toContain('test:smoke:agents')
    expect(pkg.scripts['test:integration']).toContain('test:acceptance')
    expect(pkg.scripts['test:acceptance:process']).toContain(
      'loop-split-process.acceptance.bun.test.ts',
    )
    expect(pkg.scripts['test:perf:frontend']).toBe('bun run --cwd apps/web test:perf:large-state')
    expect(pkg.scripts['test:e2e']).toContain('NODE_OPTIONS=--conditions=@podium/source')
    expect(pkg.scripts['test:smoke:agents']).toContain('PODIUM_REAL_CLI=1')
  })

  it('fails the whole command when a shard fails, even though the aggregate is skipped [POD-520]', () => {
    // The inverse of the trap above, and the one that would be invisible to every other
    // guard here because they all reason about the task GRAPH rather than the process.
    //
    // With `--continue`, three red shards leave `@podium/server#test` skipped — the task
    // Turbo was actually asked to run never executes, so it never fails. If Turbo then
    // exited 0 on the grounds that the requested task did not fail, `bun run test` would
    // report success on a lane with three failing shards and CI would stop failing.
    // Observed twice on real cold runs (exit=1), and pinned here on a fixture so it stays
    // an assertion rather than a memory: a dependency task fails, the dependent is not
    // run, and the exit code is still non-zero.
    const fixture = mkdtempSync(join(tmpdir(), 'podium-turbo-exit-'))
    try {
      mkdirSync(join(fixture, 'packages/a'), { recursive: true })
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({
          name: 'fixture-root',
          private: true,
          packageManager: 'bun@1.2.0',
          workspaces: ['packages/*'],
        }),
      )
      writeFileSync(
        join(fixture, 'turbo.json'),
        JSON.stringify({
          tasks: {
            shard: { dependsOn: [], inputs: ['$TURBO_DEFAULT$'], outputs: [] },
            check: { dependsOn: ['shard'], inputs: ['$TURBO_DEFAULT$'], outputs: [] },
          },
        }),
      )
      writeFileSync(
        join(fixture, 'packages/a/package.json'),
        JSON.stringify({
          name: 'pkg-a',
          version: '0.0.0',
          scripts: { shard: 'exit 1', check: 'echo AGGREGATE_RAN' },
        }),
      )
      writeFileSync(join(fixture, 'bun.lock'), '')

      const turbo = fileURLToPath(new URL('../node_modules/.bin/turbo', import.meta.url))
      const run = spawnSync(turbo, ['run', 'check', '--continue=dependencies-successful'], {
        cwd: fixture,
        encoding: 'utf8',
      })
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
      // Skipped, not run — nothing reports on top of the failure.
      expect(output, 'the aggregate ran despite its dependency failing').not.toContain(
        'AGGREGATE_RAN',
      )
      // …and skipped still means the command fails.
      expect(run.status, `turbo exited ${run.status} with a failed dependency task`).not.toBe(0)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('propagates the runner exit code instead of exiting 0 [POD-520]', async () => {
    // The other link in that chain. Turbo going red is worthless if the wrapper swallows
    // it, and `bun run test`'s exit status rests on one expression at the end of main():
    // `process.exit(await runWithHeavyTestLease([...]))`. Both halves are asserted so a
    // later refactor of the wrapper cannot quietly make the pipeline green.
    expect(await runWithHeavyTestLease(['bash', '-c', 'exit 3'], { cwd: fileURLToPath(repoRoot) })).toBe(3)
    expect(await runWithHeavyTestLease(['bash', '-c', 'exit 0'], { cwd: fileURLToPath(repoRoot) })).toBe(0)

    // …and that the value is what main() exits with, rather than being computed and dropped.
    const source = readFileSync(new URL('./test.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/process\.exit\(\s*await runWithHeavyTestLease\(/)
  })

  it('reports every lane without running anything on a failed dependency [POD-520]', () => {
    // Sharding @podium/server made `--continue` necessary: without it Turbo stops at the
    // first failing shard and a red in `contracts` hides what `store`, `services` and
    // `boundary` would have said. The VALUE matters more than the flag. `always` would run
    // a task whose dependency failed — for the server that is the exhaustiveness refusal
    // running after a shard died, i.e. a roster check reporting on a lane that did not
    // finish. `dependencies-successful` skips it instead, so nothing ever reports on top
    // of a failure.
    const source = readFileSync(new URL('./test.ts', import.meta.url), 'utf8')
    expect(source).toContain("'--continue=dependencies-successful'")
    expect(source).not.toContain("'--continue=always'")

    // The other half of "nothing runs on a failed dependency": no package's test task may
    // depend on another package's test task, so `--continue` cannot let one package's
    // green be reported while its upstream is red. The only dependency edges among test
    // tasks are @podium/server#test -> its own shards, declared in apps/server/turbo.json.
    const turbo = JSON.parse(readFileSync(new URL('../turbo.json', import.meta.url), 'utf8')) as {
      tasks: Record<string, { dependsOn?: string[] }>
    }
    for (const [name, task] of Object.entries(turbo.tasks)) {
      if (!name.endsWith('#test') && name !== 'test') continue
      expect(task.dependsOn ?? [], `${name} gained a cross-package test dependency`).toEqual([])
    }
  })

  it('builds browser workspace dependencies in the lane, not under webServer [POD-1389][POD-535]', () => {
    // Cold-checkout self-containment moved out of Playwright's webServer wall
    // clock: the lane builds packages + web + mobile once; webServer only boots
    // the harness. Inspect the source and config rather than the filesystem so a
    // borrowed neighbouring dist cannot make this guard green.
    const lane = readFileSync(new URL('./browser-lane.ts', import.meta.url), 'utf8')
    expect(lane, 'lane must run the workspace build').toMatch(/run\('bun', \['run', 'build'\]/)
    expect(lane, 'lane must export mobile web for phone projects').toMatch(
      /@podium\/mobile['"],\s*['"]build:web['"]/,
    )
    // Root `bun run build` is packages/* then @podium/web; packages/* includes
    // model before protocol alphabetically only by workspace graph — the
    // historical order guarantee was model-before-protocol in one shell string.
    // The root build script is the order of record for the lane.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.build).toMatch(/packages\/\*/)
    expect(pkg.scripts.build).toMatch(/@podium\/web/)

    for (const playwright of [browserConfig, phase3BrowserConfig]) {
      const command = webServerCommand(playwright)
      expect(command, 'webServer must not re-run package builds').not.toMatch(/--filter/)
      expect(command, 'webServer must boot the harness only').toContain('serve-harness.ts')
      expect(command, 'webServer must fail-fast when dist is missing').toContain(
        'browser-dist-preflight.ts',
      )
    }

    // Hand-run path until POD-536: --build-only must exist and must not take the
    // lease (callers often already hold test:heavy for the playwright half).
    expect(lane, 'lane must expose --build-only for hand-runs').toContain('--build-only')
    expect(lane).toMatch(/buildOnly|BUILD_ONLY/)
  })

  it('keeps webServer budget for harness boot only [POD-535]', () => {
    // Builds left this command; serve-harness answers /health in ~5s. A multi-
    // minute floor would re-invite stuffing builds back into webServer.
    for (const playwright of [browserConfig, phase3BrowserConfig]) {
      const { timeout, command } = webServerEntry(playwright)
      expect(command).toContain('serve-harness.ts')
      expect(timeout, 'webServer timeout missing').toBeTypeOf('number')
      expect(timeout!, 'harness-only boot should not need a multi-minute budget').toBeLessThanOrEqual(
        180_000,
      )
      expect(timeout!, 'harness-only boot still needs some headroom').toBeGreaterThanOrEqual(60_000)
    }
  })

  it('takes the heavy-test lease inside the browser lane body [POD-535]', () => {
    // Lease must live in browser-lane.ts itself: wrapping only package.json left
    // bare `bun scripts/browser-lane.ts` unprotected, and a held lease still
    // lost to another agent's harness on the fixed port (POD-503 evidence).
    const lane = readFileSync(new URL('./browser-lane.ts', import.meta.url), 'utf8')
    expect(lane, 'lane must import the shared lease helper').toMatch(/runWithHeavyTestLease/)
    expect(lane, 'lane must gate on session identity like other heavy scripts').toMatch(
      /shouldAcquireHeavyTestLease/,
    )
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    // package.json is the thin entry; do not double-wrap (nested acquire deadlocks).
    expect(pkg.scripts['test:browser']).toBe('bun scripts/browser-lane.ts')
  })

  it('keeps every browser suite reachable from a script and a CI job [POD-1227]', () => {
    // The hole this closes: 70 `*.browser.e2e.ts` suites existed with no script and
    // no job, each run once by hand and never again, while handoffs cited them as
    // runtime verification. POD-756 counted them and the lane still never appeared.
    // So the lane's EXISTENCE is asserted here, not left to a comment.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['test:browser'], 'the browser lane script is gone').toBe(
      'bun scripts/browser-lane.ts',
    )

    const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    expect(ci, 'ci.yml has no job invoking the browser lane').toMatch(
      /^\s*run: bun run test:browser\b/m,
    )
    // Playwright is not preinstalled on the runner: without this the whole lane
    // errors on setup and reads as "0 failures" under continue-on-error.
    expect(ci).toMatch(/playwright install --with-deps/)
    // Every project the config declares needs a leg, or a whole device class goes
    // unrun while the job still reports. Mobile-only suites (`test.skip(({ isMobile
    // }) => !isMobile)`) exist ONLY on the pixel/webkit legs.
    for (const project of ['chromium-desktop', 'chromium-pixel', 'webkit-iphone'])
      expect(ci, `browser lane has no CI leg for ${project}`).toContain(project)

    // Quarantine must name suites that exist. A stale entry excludes nothing while
    // still reading as a deliberate exclusion — the runner exits 2 on one, and this
    // catches it without booting a browser.
    const suites = readdirSync(new URL('../tests/e2e/browser/', import.meta.url)).filter((f) =>
      f.endsWith('.browser.e2e.ts'),
    )
    expect(suites.length).toBeGreaterThan(0)
    for (const q of QUARANTINE) {
      expect(suites, `quarantined suite "${q.suite}" does not exist`).toContain(q.suite)
      // "flaky"/"broken" is not a quarantine reason: a suite that runs and fails
      // belongs in the census as a failure. Quarantine is for what CANNOT run.
      expect(q.reason.length, `quarantine "${q.suite}" needs a reason`).toBeGreaterThan(20)
    }
  })

  it('keeps the oracle lane set, its runner, and CI in sync [POD-295]', () => {
    // The oracle is defined in three places that can drift apart silently: the lane
    // set (scripts/oracle.ts), the local runner (`bun run oracle`), and the CI job.
    // Drift fails OPEN — a lane dropped from CI still reports green — so pin them.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.oracle).toBe('bun scripts/oracle.ts')

    // Every oracle lane must name a script that actually exists.
    for (const lane of ORACLE_LANES) {
      expect(
        pkg.scripts[lane.script],
        `oracle lane "${lane.name}" needs a real script`,
      ).toBeDefined()
    }

    // agent-smoke bills real LLM quota — it must never be reachable from the oracle.
    for (const lane of ORACLE_LANES) {
      expect(lane.script).not.toBe('test:smoke:agents')
      expect(pkg.scripts[lane.script]).not.toContain('PODIUM_REAL_CLI')
    }

    // CI runs the heavy lanes as a matrix; the light ones (typecheck, unit) already
    // have their own jobs. Together they must cover the oracle exactly — no lane
    // may exist in the runner but be absent from CI.
    const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const matrix = ci.match(/lane: \[([^\]]+)\]/)?.[1]
    expect(matrix, 'ci.yml has no oracle lane matrix').toBeDefined()
    const ciLanes = (matrix ?? '').split(',').map((s) => s.trim())
    expect(ciLanes.sort()).toEqual([...HEAVY_LANES].sort())

    // The oracle job must never swallow its own red (POD-744's lesson: a bundled
    // continue-on-error made the boundary guardrail decorative for weeks).
    // Match the YAML KEY, not the bare string: the job's own comments discuss
    // continue-on-error, and a substring check cannot tell prose from a setting
    // — that exact confusion is what broke the test in POD-743.
    const fromOracle = ci.slice(ci.indexOf('\n  oracle:') + 1)
    const nextJob = fromOracle.slice(1).search(/^ {2}[a-z][\w-]*:$/m)
    const oracleJob = nextJob === -1 ? fromOracle : fromOracle.slice(0, nextJob + 1)
    expect(oracleJob).toMatch(/^ {2}oracle:$/m)
    expect(oracleJob).not.toMatch(/^\s*continue-on-error:/m)
  })

  it('runs every vitest invocation under the Bun runtime [spec:SP-3f93]', () => {
    // The suite must exercise bun:sqlite and Bun process semantics, so a bare `vitest run`
    // (Node runtime) in any script is doctrine drift — POD-622 caught test:multi-instance
    // regressing this way. `bun --bun vitest` (the bin) silently comes up on real
    // Node too (POD-195), so every vitest call must invoke the entry module
    // directly: `bun --bun node_modules/vitest/vitest.mjs`. The runtime itself is
    // asserted in-worker by scripts/vitest-bun-runtime.test.ts.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const [name, script] of Object.entries(pkg.scripts)) {
      for (const match of script.matchAll(/(?:^|&&|\|\|)\s*([^&|]*\bvitest\b[^&|]*)/g)) {
        const invocation = match[1]
        if (invocation === undefined) {
          throw new Error(`script "${name}": vitest invocation did not capture`)
        }
        expect(
          invocation.includes('bun --bun node_modules/vitest/vitest.mjs'),
          'vitest invocations must use bun --bun node_modules/vitest/vitest.mjs',
        ).toBe(true)
      }
    }
  })
})
