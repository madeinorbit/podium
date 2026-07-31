import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import frontendPerfConfig from '../apps/web/vitest.frontend-perf.config'
import acceptanceConfig from '../vitest.acceptance.config'
import agentSmokeConfig from '../vitest.agent-smoke.config'
import rootConfig from '../vitest.config'
import integrationConfig from '../vitest.integration.config'
import unitConfig from '../vitest.unit.config'
import { QUARANTINE } from './browser-quarantine'
import { HEAVY_LANES, ORACLE_LANES } from './oracle'

type Project = string | { test?: { name?: string; exclude?: string[]; retry?: number } }
type Config = {
  test?: {
    env?: Record<string, string>
    exclude?: string[]
    include?: string[]
    projects?: Project[]
    retry?: number
    maxWorkers?: number
    fileParallelism?: boolean
  }
}

const config = (value: unknown): Config => value as Config
const nodeProject = (value: unknown) => {
  const project = config(value).test?.projects?.find(
    (candidate): candidate is Exclude<Project, string> =>
      typeof candidate !== 'string' && candidate.test?.name === 'node',
  )
  if (!project) throw new Error('node Vitest project is missing')
  return project
}

describe('test lane configuration', () => {
  it('never collects ignored nested worktrees', () => {
    expect(nodeProject(rootConfig).test?.exclude).toContain('**/.worktrees/**')
  })

  it('keeps retries out of the default project and scopes them to integration', () => {
    expect(nodeProject(rootConfig).test?.retry).toBeUndefined()
    expect(config(unitConfig).test?.retry).toBe(0)
    expect(config(integrationConfig).test?.retry).toBe(1)
  })

  it('keeps deterministic integration and real-agent smoke scopes explicit', () => {
    expect(config(integrationConfig).test?.include).toContain('apps/daemon/src/daemon.test.ts')
    expect(config(integrationConfig).test?.exclude).toContain('**/*.smoke.test.{ts,tsx}')
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

  it('keeps the frontend performance lane deterministic and explicit', () => {
    expect(config(frontendPerfConfig).test?.include).toEqual([
      'src/perf/large-state.frontend-perf.tsx',
    ])
    expect(config(frontendPerfConfig).test?.retry).toBe(0)
    expect(config(frontendPerfConfig).test?.maxWorkers).toBe(1)
    expect(config(frontendPerfConfig).test?.fileParallelism).toBe(false)
  })

  it('runs the web project exactly once in the default scripts', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['test:unit']).toContain('--project node')
    expect(pkg.scripts['test:integration']).toContain('test:acceptance')
    expect(pkg.scripts['test:acceptance:process']).toContain(
      'loop-split-process.acceptance.bun.test.ts',
    )
    expect(pkg.scripts.test).toContain('test:web')
    expect(pkg.scripts.test).not.toContain('test:integration')
    expect(pkg.scripts.test).not.toContain('test:smoke:agents')
    expect(pkg.scripts['test:perf:frontend']).toBe('bun run --cwd apps/web test:perf:large-state')
    expect(pkg.scripts['test:e2e']).toContain('NODE_OPTIONS=--conditions=@podium/source')
    expect(pkg.scripts['test:smoke:agents']).toContain('PODIUM_REAL_CLI=1')
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
      /^\s*run: bun run test:browser$/m,
    )
    // Playwright is not preinstalled on the runner: without this the whole lane
    // errors on setup and reads as "0 failures" under continue-on-error.
    expect(ci).toMatch(/playwright install --with-deps/)

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
        expect(
          match[1].trim(),
          `script "${name}" must run vitest via bun --bun node_modules/vitest/vitest.mjs`,
        ).toMatch(/^(?:[A-Z_]+=\S+\s+)*bun --bun node_modules\/vitest\/vitest\.mjs\b/)
      }
    }
  })
})
