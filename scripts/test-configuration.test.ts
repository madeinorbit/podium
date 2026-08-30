import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import desktopConfig from '../apps/desktop/vitest.config'
import mobileConfig from '../apps/mobile/vitest.config'
import serverBoundaryConfig from '../apps/server/vitest.boundary.config'
import serverPackageConfig from '../apps/server/vitest.config'
import serverContractsConfig from '../apps/server/vitest.contracts.config'
import normalizedWirePackageConfig from '../apps/server/vitest.normalized-wire.config'
import serverServicesConfig from '../apps/server/vitest.services.config'
import { REUSE_GUARD_SETUP_FILE } from '../apps/server/vitest.shard'
import serverStoreConfig from '../apps/server/vitest.store.config'
import webConfig from '../apps/web/vitest.config'
import frontendPerfConfig from '../apps/web/vitest.frontend-perf.config'
import syncPerfConfig from '../packages/sync/vitest.perf.config'
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
import { CLIENT_DIST_DIRS } from './build-clients'
import { HEAVY_LANES, ORACLE_LANES } from './oracle'
import {
  inspectProofContract,
  parseEvidence,
  PROOF_CHECKS,
  validateEvidence,
} from './parity-release-proof'
import { runWithHeavyTestLease } from './test-heavy'
import scriptsConfig from './vitest.config'
import rearchConfig from './vitest.rearch.config'

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
        isolate?: boolean
        passWithNoTests?: boolean
        testTimeout?: number
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
    isolate?: boolean
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
      if (['.git', '.worktrees', '.claude', 'node_modules'].includes(entry.name)) return []
      return smokeTestFiles(new URL(`${entry.name}/`, dir), relative)
    }
    return /\.smoke\.test\.(?:ts|tsx)$/.test(entry.name) ? [relative] : []
  })
interface WorkspacePackage {
  name: string
  /** repo-relative, e.g. `apps/web` */
  dir: string
  scripts: Record<string, string>
  dependencies: string[]
}

/** Every workspace package, resolved from the root `workspaces` globs. */
const workspacePackageDirs = (root: string): WorkspacePackage[] => {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces: string[]
  }
  const dirs = rootPkg.workspaces.flatMap((workspace) => {
    if (!workspace.endsWith('/*')) return [workspace]
    const parent = workspace.slice(0, -2)
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`)
  })
  return dirs.flatMap((dir) => {
    const file = join(root, dir, 'package.json')
    if (!existsSync(file)) return []
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
      name?: string
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    if (!pkg.name) return []
    return [
      {
        name: pkg.name,
        dir,
        scripts: pkg.scripts ?? {},
        dependencies: [
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.devDependencies ?? {}),
        ],
      },
    ]
  })
}

/** Closure of workspace dependencies — what `^typecheck` folds into the hash. */
const transitiveWorkspaceDeps = (name: string, packages: WorkspacePackage[]): string[] => {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const seen = new Set<string>()
  const walk = (current: string) => {
    for (const dep of byName.get(current)?.dependencies ?? []) {
      if (!byName.has(dep) || seen.has(dep)) continue
      seen.add(dep)
      walk(dep)
    }
  }
  walk(name)
  return [...seen]
}

/**
 * `from '…'`, `import('…')`, `require('…')` and bare side-effect `import '…'`.
 * Deliberately textual: this asks "what could this package pull in", and a
 * resolution check below discards specifiers that name nothing real.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

const RESOLUTION_SUFFIXES = ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx']

/**
 * Repo-relative paths this package imports by relative specifier from OUTSIDE
 * its own directory. Only specifiers that resolve to a file that exists count —
 * a path spelled inside a fixture string names nothing and is not a real read.
 */
const escapingImports = (packageDir: string, root: string): string[] => {
  const absolutePackageDir = join(root, packageDir)
  const found = new Set<string>()
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'build', '.turbo', 'ios', 'android'].includes(entry.name)) {
          continue
        }
        visit(full)
        continue
      }
      if (!/\.(?:ts|tsx)$/.test(entry.name)) continue
      const source = readFileSync(full, 'utf8')
      for (const match of source.matchAll(SPECIFIER)) {
        const specifier = match[1] as string
        if (!specifier.startsWith('.')) continue
        const target = resolve(dirname(full), specifier)
        if (target.startsWith(`${absolutePackageDir}/`)) continue
        const hit = RESOLUTION_SUFFIXES.map((suffix) => `${target}${suffix}`).find(
          (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
        )
        if (hit === undefined || !hit.startsWith(`${root}/`)) continue
        found.add(hit.slice(root.length + 1))
      }
    }
  }
  visit(absolutePackageDir)
  return [...found].sort()
}

/** Turbo input/globalDependency globs, matched against a repo-relative path. */
const coveredByInputGlob = (globs: string[], target: string): boolean =>
  globs.some((glob) => {
    const bare = glob.startsWith('$TURBO_ROOT$/') ? glob.slice('$TURBO_ROOT$/'.length) : glob
    const star = bare.indexOf('*')
    return star === -1 ? target === bare : target.startsWith(bare.slice(0, star))
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
/** A shard's inline projects, if it has any — POD-527 gives `contracts` two. */
const shardProjects = (value: unknown): (Config['test'] | undefined)[] =>
  (config(value).test?.projects ?? []).map((project) =>
    typeof project === 'string' ? undefined : (project.test as Config['test']),
  )
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
  it('resolves the daemon protocol subpath without prefix-rewriting the common barrel', () => {
    const aliases = sharedVitestConfig.resolve.alias
    const common = aliases.find(({ find }) => String(find) === '/^@podium\\/protocol$/')
    const daemon = aliases.find(({ find }) => String(find) === '/^@podium\\/protocol\\/daemon$/')

    expect(common?.replacement).toBe(
      fileURLToPath(new URL('../packages/protocol/src/index.ts', import.meta.url)),
    )
    expect(daemon?.replacement).toBe(
      fileURLToPath(new URL('../packages/protocol/src/daemon.ts', import.meta.url)),
    )
  })

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

  it('keeps every server shard on the shared hermetic setup [POD-520]', () => {
    // The split turned one server lane into five. Each is a separate Vitest invocation, so
    // each can lose the hardening on its own: the env scrubber that keeps a suite off the
    // live instance and POD-523's store fixture.
    //
    // POD-527 gave one shard PROJECTS, so the same properties are now asserted twice: once
    // on the shard config and once on each project inside it. A project is where a Vitest
    // option actually takes effect, so a shard that kept the hardening at the top and lost
    // it in a project would have passed the original loop while running unhardened.
    for (const [name, shardConfig] of serverShardConfigs) {
      const lanes: [string, Config['test'] | undefined][] = [
        [name, config(shardConfig).test],
        ...shardProjects(shardConfig).map((test): [string, Config['test'] | undefined] => [
          test?.name ?? `${name} project`,
          test,
        ]),
      ]
      for (const [lane, test] of lanes) {
        // The reused project carries ONE extra setupFile and nothing else. It is the
        // after-file leak guard, and it is additive on purpose: the reused runner keeps the
        // env scrubber, the state-root assertion and POD-523's store fixture exactly as
        // every other lane has them, and then adds the check that they were left as found.
        expect(test?.setupFiles, `${lane} lost hermetic setup`).toEqual(
          test?.isolate === false
            ? [...sharedVitestConfig.test.setupFiles, REUSE_GUARD_SETUP_FILE]
            : sharedVitestConfig.test.setupFiles,
        )
        expect(test?.globalSetup, `${lane} lost the schema image`).toEqual([
          fileURLToPath(new URL('test-pre-migrated-schema.ts', repoRoot)),
        ])
        expect(test?.testTimeout, `${lane} lost the shared timeout`).toBe(
          sharedVitestConfig.test.testTimeout,
        )
        expect(test?.retry, `${lane} gained a retry`).toBe(0)
        // An explicit file list that collects nothing means the manifest and the filesystem
        // disagree. That has to be a failure, or a mis-generated shard passes as a green.
        // No project is exempt: a shard only grows a project when the scan put files in it.
        expect(test?.passWithNoTests, `${lane} would pass empty`).toBe(false)
        // normalized-wire is the deliberately serialized one; retain its explicit worker cap.
        if (name === 'normalized-wire') {
          expect(test?.maxWorkers, `${lane} changed the serialized worker cap`).toBe(1)
        }
      }
    }
  })

  it('turns isolation off in exactly one project, and only additively [POD-527]', () => {
    // POD-515 rejected `isolate: false` as a lane-wide setting: it trades wall time for
    // flakiness. The reuse it asked for is therefore scoped to one project of one shard, and
    // this is what stops that scope from spreading — a second project that dropped isolation
    // would have to be added here, deliberately, rather than arriving with a config tidy-up.
    const nonIsolated: string[] = []
    for (const [name, shardConfig] of serverShardConfigs) {
      expect(
        config(shardConfig).test?.isolate,
        `${name} dropped isolation at the shard level, which would take every project with it`,
      ).toBeUndefined()
      for (const test of shardProjects(shardConfig)) {
        if (test?.isolate === false) nonIsolated.push(test.name ?? `${name} (unnamed project)`)
      }
    }
    expect(nonIsolated).toEqual(['server:contracts:reused'])
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
    expect(config(integrationConfig).test?.minWorkers).toBe(1)
    for (const appConfig of [webConfig, mobileConfig]) {
      expect(config(appConfig).test?.maxWorkers).toBe(sharedVitestConfig.test.maxWorkers)
    }
  })

  it('defaults worker limits safely and accepts explicit host overrides', () => {
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
      'src/perf/responsive-filtering.frontend-perf.tsx',
      'src/perf/scoped-session-render.test.tsx',
      'src/features/issues/IssuesKanban.test.tsx',
    ])
    expect(config(frontendPerfConfig).test?.retry).toBe(0)
    expect(config(frontendPerfConfig).test?.maxWorkers).toBe(1)
    expect(config(frontendPerfConfig).test?.fileParallelism).toBe(false)
  })

  it('keeps quadratic benchmarks out of the default gate and explicitly heavy', () => {
    expect(nodeProject(unitConfig).test?.exclude).toContain('**/*.bench.test.{ts,tsx}')
    expect(config(syncPerfConfig).test?.include).toEqual([
      'packages/sync/src/adapters/indexeddb/apply-scaling.bench.test.ts',
    ])
    expect(config(syncPerfConfig).test?.retry).toBe(0)
    expect(config(syncPerfConfig).test?.maxWorkers).toBe(1)
    expect(config(syncPerfConfig).test?.fileParallelism).toBe(false)

    const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    const sync = JSON.parse(
      readFileSync(new URL('../packages/sync/package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> }
    expect(root.scripts['test:perf:sync']).toBe(
      'bun run --cwd packages/sync test:perf:apply-scaling',
    )
    expect(sync.scripts['test:perf:apply-scaling']).toContain('validation-admission.ts heavy')
  })

  it('keeps the conventional default lean and the exhaustive lane explicit', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['setup:worktree']).toBe('bun install --frozen-lockfile')
    expect(pkg.scripts['deps:repair']).toBe(
      'bun run deps:clean-local-installs && bun install --frozen-lockfile',
    )
    expect(pkg.scripts.test).toContain('bun run typecheck &&')
    expect(pkg.scripts['test:agent']).toBe('bun run test')
    expect(pkg.scripts['test:full']).toBe('bun run typecheck && bun scripts/test.ts')
    expect(pkg.scripts['test:unit']).toBe('bun scripts/test.ts')
    expect(pkg.scripts.test).toContain('vitest.unit.config.ts')
    expect(pkg.scripts.test).not.toContain('test:web')
    expect(pkg.scripts.test).not.toContain('test:bun:unit')
    expect(pkg.scripts.test).not.toContain('test:integration')
    expect(pkg.scripts.test).not.toContain('test:smoke:agents')
    expect(pkg.scripts['test:integration']).toContain('test:acceptance')
    expect(pkg.scripts['test:acceptance:process']).toContain(
      'loop-split-process.acceptance.bun.test.ts',
    )
    expect(pkg.scripts['test:acceptance:process']).toContain('bun scripts/test-heavy.ts --')
    for (const name of ['test:changed', 'test:related', 'test:bun:unit']) {
      expect(pkg.scripts[name], `${name} bypasses focused admission`).toContain(
        'validation-admission.ts focused',
      )
    }
    expect(pkg.scripts['test:watch']).toContain('validation-admission.ts watch')
    expect(pkg.scripts['test:watch']).toContain('PODIUM_TEST_WORKERS=1')
    for (const name of ['test:multi-instance', 'test:bun']) {
      expect(pkg.scripts[name], `${name} bypasses heavy admission`).toContain(
        'bun scripts/test-heavy.ts --',
      )
    }
    // The dependency lanes spawn cold typechecks and package tests in DISPOSABLE
    // worktrees, where PODIUM_SESSION_ID is unset so no inner probe can take a lease of
    // its own. The lease therefore has to be here, around the whole lane, or a routine
    // agent invocation runs several full typechecks with nothing admitting them
    // [POD-2774].
    const admissionLane = pkg.scripts['deps:global-store-cache-admission'] as string
    expect(admissionLane).toContain('validation-admission.ts heavy')
    expect(admissionLane).toContain('bun scripts/global-store-cache-admission.ts')
    // One lease, outermost: the lane entry point must be the leased command and not
    // something that leases again inside it.
    expect(admissionLane.indexOf('validation-admission.ts')).toBeLessThan(
      admissionLane.indexOf('global-store-cache-admission.ts'),
    )
    expect(admissionLane.match(/validation-admission\.ts/g)).toHaveLength(1)
    expect(pkg.scripts['test:perf:frontend']).toBe('bun run --cwd apps/web test:perf:large-state')
    expect(pkg.scripts['test:e2e']).toContain('NODE_OPTIONS=--conditions=@podium/source')
    expect(pkg.scripts.test).toContain('bun run typecheck &&')
    expect(pkg.scripts['test:smoke:agents']).toContain('PODIUM_REAL_CLI=1')
    expect(pkg.scripts.test).toContain('--maxWorkers=1')
    expect(pkg.scripts.test).not.toContain('validation-admission.ts')
    expect(pkg.scripts.test).toContain('packages/runtime/src/boot.test.ts')
    expect(pkg.scripts.test).toContain('apps/server/src/router.setup.test.ts')
    expect(pkg.scripts.test).toContain('apps/daemon/src/connection-state.test.ts')
    expect(pkg.scripts.test).toContain('scripts/test-configuration.test.ts')
    expect(pkg.scripts.test).not.toContain('scripts/test.ts')
  })

  it('keeps the native node-pty backend retired', () => {
    const lock = readFileSync(new URL('../bun.lock', import.meta.url), 'utf8')
    expect(lock).not.toContain('"node-pty"')
    for (const path of [
      '../packages/pty/src/backends/node-pty-backend.ts',
      '../packages/pty/src/backends/bun-node-pty-tty-polyfill.ts',
    ]) {
      expect(existsSync(new URL(path, import.meta.url)), path).toBe(false)
    }
  })

  it('keeps rewrite migration tests out of routine package validation', () => {
    expect(config(scriptsConfig).test?.exclude).toContain('scripts/rearch-audit.test.ts')
    expect(config(rearchConfig).test?.include).toEqual(['scripts/rearch-audit.test.ts'])
    expect(config(rearchConfig).test?.maxWorkers).toBe(1)

    const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    const scripts = JSON.parse(
      readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> }
    expect(root.scripts['test:rearch']).toBe(
      'bun run audit:rearch && bun run --cwd scripts test:rearch',
    )
    expect(scripts.scripts['test:rearch']).toContain('vitest.rearch.config.ts')
  })

  it('guards direct package validation and passes root ownership through Turbo', () => {
    const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      workspaces: string[]
    }
    const packageFiles = root.workspaces.flatMap((workspace) => {
      if (!workspace.endsWith('/*'))
        return [new URL(`../${workspace}/package.json`, import.meta.url)]
      const parent = new URL(`../${workspace.slice(0, -1)}`, import.meta.url)
      return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => new URL(`${entry.name}/package.json`, parent))
    })
    for (const file of packageFiles) {
      if (!existsSync(file)) continue
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
        name?: string
        scripts?: Record<string, string>
      }
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        if (!/^(test|typecheck)(?::|$)/.test(name)) continue
        if (/^typecheck(?::|$)/.test(name)) {
          expect(
            script,
            `${pkg.name ?? file.pathname}#${name} must stay admission-free`,
          ).not.toContain('validation-admission.ts')
          continue
        }
        expect(
          script,
          `${pkg.name ?? file.pathname}#${name} bypasses validation admission`,
        ).toContain('validation-admission.ts')
      }
    }

    const turbo = JSON.parse(readFileSync(new URL('../turbo.json', import.meta.url), 'utf8')) as {
      globalEnv?: string[]
      globalPassThroughEnv?: string[]
    }
    expect(turbo.globalPassThroughEnv).toContain('PODIUM_VALIDATION_RESOURCE_HELD')
    expect(turbo.globalEnv).not.toContain('PODIUM_VALIDATION_RESOURCE_HELD')
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
    expect(
      await runWithHeavyTestLease(['bash', '-c', 'exit 3'], { cwd: fileURLToPath(repoRoot) }),
    ).toBe(3)
    expect(
      await runWithHeavyTestLease(['bash', '-c', 'exit 0'], { cwd: fileURLToPath(repoRoot) }),
    ).toBe(0)

    // Both the lock-free focused child and heavy full-graph path must propagate red.
    const source = readFileSync(new URL('./test.ts', import.meta.url), 'utf8')
    expect(source).toContain('process.exit(await proc.exited)')
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

  it('keeps every typecheck cache key over the sources that task actually reads [POD-2807]', () => {
    // A check that cannot say NO is worse than no check. Turbo hashes
    // `$TURBO_DEFAULT$` — the package's own tracked files — plus the task hashes
    // of the packages named in its `^typecheck` dependencies. Neither follows a
    // relative import that climbs OUT of the package directory. So a package
    // that reaches into a sibling it does not depend on gets a cache key blind
    // to sources it genuinely typechecks, and Turbo replays a green computed
    // against a world that no longer exists.
    //
    // That is not hypothetical: `scripts/docker-update-e2e/ui-update.ts` reached
    // into `apps/web` for one formatter, `apps/web` gained an unresolvable
    // `@/app/store` import on 2026-08-22, and `@podium/scripts:typecheck` stayed
    // cached green for three days while `bun run test` — the sanctioned agent
    // gate — reported success to every lane that ran it.
    //
    // The rule this pins: if a package's typecheck can reach outside its own
    // directory, its cache key has to follow. Coverage may come from an explicit
    // `$TURBO_ROOT$` input, from `globalDependencies`, or from a workspace
    // dependency (whose own typecheck hash rides in via `^typecheck`) — but it
    // has to come from somewhere, and this fails loudly when it does not.
    const turbo = JSON.parse(readFileSync(new URL('../turbo.json', import.meta.url), 'utf8')) as {
      globalDependencies?: string[]
      tasks: Record<string, { dependsOn?: string[]; inputs?: string[] }>
    }
    const root = fileURLToPath(repoRoot).replace(/\/$/, '')

    const packages = workspacePackageDirs(root)
    const dirByName = new Map(packages.map((pkg) => [pkg.name, pkg.dir]))

    const failures: string[] = []
    for (const pkg of packages) {
      if (!pkg.scripts.typecheck) continue
      // `<pkg>#typecheck` overrides the generic `typecheck` entry outright —
      // Turbo does not merge them, so the override is the whole key.
      const task = turbo.tasks[`${pkg.name}#typecheck`] ?? turbo.tasks.typecheck ?? {}
      const globs = [...(task.inputs ?? []), ...(turbo.globalDependencies ?? [])]
      // `^typecheck` carries the dependency's task hash, which recursively
      // carries its own — so the whole transitive closure is inside the key.
      const viaDependencies = (task.dependsOn ?? []).includes('^typecheck')
        ? transitiveWorkspaceDeps(pkg.name, packages).map((name) => dirByName.get(name) ?? '')
        : []

      for (const read of escapingImports(pkg.dir, root)) {
        const covered =
          coveredByInputGlob(globs, read) ||
          viaDependencies.some((dir) => dir && read.startsWith(`${dir}/`))
        if (!covered) failures.push(`${pkg.name}#typecheck reads ${read}, uncovered by its key`)
      }
    }
    expect(failures.sort()).toEqual([])
  })

  it('restores the scripts typecheck hash after generated Turbo logs appear [POD-2937]', () => {
    // The scripts package typechecks repository code reached by relative imports, so its
    // explicit root inputs deliberately cross package boundaries. Explicit globs also see
    // ignored files, though: the cache-admission probes leave `.turbo/turbo-typecheck.log`
    // files beneath those roots, and a repaired checkout at the same commit then used to
    // get a different scripts hash from its original clean hash.
    const rootTurbo = JSON.parse(
      readFileSync(new URL('../turbo.json', import.meta.url), 'utf8'),
    ) as {
      tasks: Record<string, { dependsOn?: string[]; inputs?: string[]; outputs?: string[] }>
    }
    const scriptsTypecheck = rootTurbo.tasks['@podium/scripts#typecheck']
    expect(scriptsTypecheck, 'scripts typecheck task is missing').toBeDefined()

    const fixture = mkdtempSync(join(tmpdir(), 'podium-typecheck-inputs-'))
    const roots = ['apps', 'packages', 'services', 'tests']
    try {
      mkdirSync(join(fixture, 'scripts'), { recursive: true })
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({
          name: 'fixture-root',
          private: true,
          packageManager: 'bun@1.3.14',
          workspaces: ['scripts'],
        }),
      )
      writeFileSync(join(fixture, 'bun.lock'), '')
      writeFileSync(join(fixture, '.gitignore'), '.turbo/\n')
      writeFileSync(
        join(fixture, 'turbo.json'),
        JSON.stringify({
          daemon: false,
          tasks: { '@podium/scripts#typecheck': scriptsTypecheck },
        }),
      )
      writeFileSync(
        join(fixture, 'scripts/package.json'),
        JSON.stringify({
          name: '@podium/scripts',
          version: '0.0.0',
          scripts: { typecheck: 'exit 0' },
        }),
      )
      writeFileSync(join(fixture, 'scripts/check.ts'), 'export const checked = true\n')
      for (const root of roots) {
        mkdirSync(join(fixture, root, 'fixture'), { recursive: true })
        writeFileSync(join(fixture, root, 'fixture/source.ts'), `export const ${root} = true\n`)
      }

      const turbo = fileURLToPath(new URL('../node_modules/.bin/turbo', import.meta.url))
      const hash = (): string => {
        const run = spawnSync(
          turbo,
          ['run', 'typecheck', '--filter=@podium/scripts', '--dry=json'],
          {
            cwd: fixture,
            encoding: 'utf8',
          },
        )
        expect(run.status, `${run.stderr ?? ''}${run.stdout ?? ''}`).toBe(0)
        const dry = JSON.parse(run.stdout) as { tasks?: { taskId?: string; hash?: string }[] }
        const task = dry.tasks?.find(({ taskId }) => taskId === '@podium/scripts#typecheck')
        expect(task?.hash, 'dry run omitted the scripts typecheck hash').toBeTruthy()
        return task?.hash as string
      }

      const clean = hash()
      for (const root of roots) {
        const generated = join(fixture, root, 'fixture/.turbo/turbo-typecheck.log')
        mkdirSync(dirname(generated), { recursive: true })
        writeFileSync(generated, `${root} generated log\n`)
      }
      expect(hash()).toBe(clean)

      // The exclusion must be surgical: all four broad roots remain real inputs.
      for (const root of roots) {
        writeFileSync(join(fixture, root, 'fixture/source.ts'), `export const ${root} = false\n`)
        expect(hash(), `${root}/** stopped affecting the scripts typecheck hash`).not.toBe(clean)
        writeFileSync(join(fixture, root, 'fixture/source.ts'), `export const ${root} = true\n`)
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true })
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
      /@podium\/mobile['"],\s*['"]build['"]/,
    )
    // Root `bun run build` used to be a hand-written `--filter` chain, and its order
    // was the order of record for this lane. It is a Turbo task graph now (POD-3053):
    // the ordering guarantee moved from a shell string into `dependsOn`, where it is
    // derived rather than remembered, and the lane gets it by delegating. What this
    // still has to pin is that the root script IS that delegation — a chain creeping
    // back would be a second order of record, and the one this lane does not read.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.build).toBe('bun scripts/build-clients.ts --workspace')
    const buildClients = readFileSync(new URL('./build-clients.ts', import.meta.url), 'utf8')
    expect(buildClients, 'the lane must run turbo run build, never a bare turbo build').toContain(
      "'run',\n    'build',",
    )

    for (const playwright of [browserConfig, phase3BrowserConfig]) {
      const command = webServerCommand(playwright)
      expect(command, 'webServer must not re-run package builds').not.toMatch(/--filter/)
      expect(command, 'webServer must boot the harness only').toContain('serve-harness.ts')
      expect(command, 'webServer must fail-fast when dist is missing').toContain(
        'browser-dist-preflight.ts',
      )
    }

    // Hand-run bridge (POD-535): --build-only must exist and must not take the
    // lease (callers often already hold test:heavy for the playwright half).
    // Preferred one-suite path is --suite (POD-536); both must stay on the lane.
    expect(lane, 'lane must expose --build-only for hand-runs').toContain('--build-only')
    expect(lane).toMatch(/buildOnly|BUILD_ONLY/)
    expect(lane, 'lane must expose --suite selection').toContain('--suite')
    expect(lane).toMatch(/resolveSelectedSuites|suiteSelectors/)
  })

  it('stamps both client dists after turbo, with no cache-state branch [POD-3072][POD-3082]', () => {
    // WHAT RESTS ON THIS. Since POD-3082 the phone's build task no longer names
    // PODIUM_APP_VERSION in its cache key, so a release whose clients did not change
    // RESTORES apps/mobile/dist — stamped with whichever version and commit first built
    // those inputs. The only thing that makes the released dist name THIS release is
    // stampClients running after the turbo call, for every run, HIT and MISS alike.
    //
    // That is why the shape is asserted and not just the behaviour: an `if (cache ===
    // 'MISS')` slipped in between the build and the stamp would leave every cold-build
    // test green and only a restored release wrong — the exact failure POD-3072 was.
    expect(CLIENT_DIST_DIRS, 'both client dists must be stamped').toEqual([
      'apps/web/dist',
      'apps/mobile/dist',
    ])

    const source = readFileSync(new URL('./build-clients.ts', import.meta.url), 'utf8')
    for (const name of ['buildClients', 'buildWorkspace']) {
      const start = source.indexOf(`export async function ${name}(`)
      expect(start, `${name} is not exported from build-clients.ts`).toBeGreaterThan(-1)
      const end = source.indexOf('\n}\n', start)
      const body = source.slice(start, end)

      const built = body.indexOf('runTurboBuild(')
      const stamped = body.indexOf('stampClients(')
      expect(built, `${name} no longer runs the turbo build`).toBeGreaterThan(-1)
      expect(stamped, `${name} must stamp AFTER turbo returns`).toBeGreaterThan(built)
      expect(
        body.slice(built, stamped),
        `${name} decides whether to stamp; the stamp must be unconditional`,
      ).not.toMatch(/\b(if|switch|cache|HIT|MISS)\b|\?/)
    }
  })

  it('keeps webServer budget for harness boot only [POD-535]', () => {
    // Builds left this command; serve-harness answers /health in ~5s. A multi-
    // minute floor would re-invite stuffing builds back into webServer.
    for (const playwright of [browserConfig, phase3BrowserConfig]) {
      const { timeout, command } = webServerEntry(playwright)
      expect(command).toContain('serve-harness.ts')
      expect(timeout, 'webServer timeout missing').toBeTypeOf('number')
      expect(
        timeout!,
        'harness-only boot should not need a multi-minute budget',
      ).toBeLessThanOrEqual(180_000)
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

  it('keeps the desktop shell’s Rust tests reachable from a script and a CI job [POD-1906]', () => {
    // The hole this closes: ~20 `#[test]`s in apps/desktop/src-tauri (the native
    // log sink, its rotation bound, the panic hook, the pending-crash queue) with
    // no lane at all. `cargo test` appeared in no workflow, no package.json script
    // and no scripts/ runner, so inverting the rotation bound passed EVERY gate
    // the repo had. Same failure shape as POD-1227's browser lane, so the lane's
    // EXISTENCE is asserted here rather than left to a comment.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['test:rust'], 'the rust lane script is gone').toBe(
      'bun scripts/test-rust.ts',
    )

    const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    expect(ci, 'ci.yml has no job invoking the rust lane').toMatch(/^\s*run: bun run test:rust\b/m)
    // Without the system libraries the crate cannot link, and the job would fail
    // on setup — a red that reads as a broken gate rather than a broken behaviour.
    expect(ci, 'the rust job installs no webkit2gtk').toContain('libwebkit2gtk-4.1-dev')
    // A `--if-available` in CI would turn a missing toolchain into a silent skip:
    // the exact "gate that cannot fire" this lane exists to remove.
    expect(ci, 'the CI rust lane must not be allowed to skip itself').not.toMatch(
      /run: bun run test:rust .*--if-available/,
    )

    // Every #[test] in the crate is inside a module `cargo test` reaches, so the
    // count only has to be non-zero for the lane to be worth its five minutes.
    const rustSources = ['logging.rs', 'bootstrap.rs'].map((f) =>
      readFileSync(new URL(`../apps/desktop/src-tauri/src/${f}`, import.meta.url), 'utf8'),
    )
    const tests = rustSources.reduce((n, src) => n + (src.match(/#\[test\]/g)?.length ?? 0), 0)
    expect(tests, 'the rust lane would run no tests').toBeGreaterThan(10)
  })

  it('keeps parity release evidence fail-closed across native and packaged boundaries', () => {
    expect(inspectProofContract(fileURLToPath(repoRoot))).toEqual([])

    const baseline = parseEvidence(
      JSON.parse(
        readFileSync(new URL('./parity-release-proof-baseline.json', import.meta.url), 'utf8'),
      ),
    )
    expect(Object.keys(baseline.checks).sort()).toEqual(
      PROOF_CHECKS.map((check) => check.id).sort(),
    )
    expect(validateEvidence(baseline, { releaseReady: false })).toEqual([])
    expect(validateEvidence(baseline, { releaseReady: true })).toHaveLength(PROOF_CHECKS.length)

    const native = structuredClone(baseline)
    native.checks['ios-minimum-simulator-smoke'] = {
      status: 'passed',
      source: 'automated',
      artifacts: ['run://browser-emulation'],
      notes: 'A browser device preset ran.',
    }
    expect(validateEvidence(native, { releaseReady: false })).toContain(
      'ios-minimum-simulator-smoke: expected simulator evidence, found automated',
    )
    expect(() =>
      parseEvidence({
        ...baseline,
        checks: {
          ...baseline.checks,
          'ios-minimum-simulator-smoke': {
            status: 'passed',
            source: 'browser-emulation',
            notes: 'A browser device preset ran.',
          },
        },
      }),
    ).toThrow('browser emulation is never native proof')

    const staleIos = structuredClone(baseline)
    staleIos.checks['ios-current-device'] = {
      status: 'passed',
      source: 'physical-device',
      device: 'iPhone 16 Pro',
      osVersion: '26.6',
      artifacts: ['device-run.mp4'],
      notes: 'Ran on a stale current-device image.',
    }
    expect(validateEvidence(staleIos, { releaseReady: false })).toContain(
      'ios-current-device: expected OS 26.6.1, found 26.6',
    )

    const wrongDevice = structuredClone(baseline)
    wrongDevice.checks['ios-minimum-device'] = {
      status: 'passed',
      source: 'physical-device',
      device: 'iPhone 8',
      osVersion: '16.4',
      artifacts: ['device-run.mp4'],
      notes: 'Ran on the wrong minimum device.',
    }
    expect(validateEvidence(wrongDevice, { releaseReady: false })).toContain(
      'ios-minimum-device: expected device iPhone SE (2nd generation), found iPhone 8',
    )

    const oneMacArchitecture = structuredClone(baseline)
    oneMacArchitecture.checks['desktop-macos-apple-silicon-package'] = {
      status: 'passed',
      source: 'packaged-desktop',
      device: 'MacBook Pro (14-inch, M4 Pro, 2024)',
      osVersion: 'macOS 26.6.2',
      packageName: 'Podium_1.2.3_aarch64.dmg',
      packageSha256: 'a'.repeat(64),
      packageTrust: {
        mechanism: 'Apple notarization and Gatekeeper',
        identity: 'Developer ID Application: Podium',
        verified: true,
      },
      artifacts: ['apple-silicon-run.mp4'],
      notes: 'Apple Silicon package passed.',
    }
    expect(
      validateEvidence(oneMacArchitecture, { releaseReady: false }).filter((error) =>
        error.startsWith('desktop-macos-apple-silicon-package:'),
      ),
    ).toEqual([])
    expect(validateEvidence(oneMacArchitecture, { releaseReady: true })).toContain(
      'desktop-macos-intel-package: unavailable evidence blocks release',
    )

    const wrongDesktopPackage = structuredClone(baseline)
    wrongDesktopPackage.checks['desktop-windows-package'] = {
      status: 'passed',
      source: 'packaged-desktop',
      device: 'Dell XPS 13 9340',
      osVersion: 'Windows 11 24H2',
      packageName: 'desktop-notes.txt',
      packageSha256: 'b'.repeat(64),
      artifacts: ['windows-run.mp4'],
      notes: 'The package label is not an NSIS installer.',
    }
    expect(validateEvidence(wrongDesktopPackage, { releaseReady: false })).toContain(
      'desktop-windows-package: expected package Podium_<version>_x64-setup.exe, found desktop-notes.txt',
    )

    const untrustedWindowsPackage = structuredClone(baseline)
    untrustedWindowsPackage.checks['desktop-windows-package'] = {
      status: 'passed',
      source: 'packaged-desktop',
      device: 'Dell XPS 13 9340',
      osVersion: 'Windows 11 24H2',
      packageName: 'Podium_1.2.3_x64-setup.exe',
      packageSha256: 'b'.repeat(64),
      packageTrust: {
        mechanism: 'Authenticode',
        identity: 'Unknown publisher',
        verified: false,
      },
      artifacts: ['windows-run.mp4'],
      notes: 'The installer ran, but its publisher trust did not verify.',
    }
    expect(validateEvidence(untrustedWindowsPackage, { releaseReady: false })).toContain(
      'desktop-windows-package: package trust verification did not pass',
    )
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
