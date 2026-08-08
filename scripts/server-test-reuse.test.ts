/**
 * Guards for the reusable-runner shard [POD-527].
 *
 * Three things have to stay true, and they fail in three different directions:
 *
 * 1. **The roster is still whole.** Splitting `contracts` into a reused and an isolated
 *    project is a partition, not a filter. If the two project includes ever stop covering
 *    the manifest exactly, files stop running and the shard still reports green.
 * 2. **Reuse is actually happening.** This is the check whose absence looks like success.
 *    Nothing else here can see it: if a Vitest upgrade changed the pool so that a finished
 *    runner is never handed on, every test would still pass, every guard would stay green,
 *    and the only symptom would be that the lane got slower again — indistinguishable from
 *    a busy host. So it is asserted directly, against real process ids from a real run.
 * 3. **The leak guard refuses.** A guard that never fires is indistinguishable from a guard
 *    that cannot fire. A fixture leaks one env var on purpose and the run must go red,
 *    naming the file that leaked and the key it left behind.
 *
 * 2 and 3 spawn Vitest against a throwaway fixture rather than reasoning about config, for
 * the reason POD-520 gave for its own exit-code fixture: the pool's behaviour is not in the
 * config, and an assertion about the config would not have caught a change in the pool.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DISQUALIFIERS,
  disqualifiersIn,
  REUSE_ENABLED_SHARDS,
  splitForReuse,
} from '../apps/server/src/test-support/reuse-plan'
import serverContractsConfig from '../apps/server/vitest.contracts.config'
import { readManifest } from './server-test-shards'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

type ProjectConfig = { test?: { name?: string; include?: string[]; isolate?: boolean } }
const projectsOf = (value: unknown): ProjectConfig[] =>
  ((value as { test?: { projects?: ProjectConfig[] } }).test?.projects ?? []) as ProjectConfig[]
const projectNamed = (value: unknown, name: string): ProjectConfig => {
  const project = projectsOf(value).find((candidate) => candidate.test?.name === name)
  if (!project) throw new Error(`Vitest project "${name}" is missing from the contracts shard`)
  return project
}

const contractsFiles = () => {
  const shard = readManifest(repoRoot).shards.find((candidate) => candidate.id === 'contracts')
  if (!shard) throw new Error('the contracts shard is missing from apps/server/test-shards.json')
  return shard.testFiles
}

describe('reusable-runner shard [POD-527]', () => {
  it('partitions the contracts shard — every file still runs, exactly once', () => {
    const roster = contractsFiles()
    const collected = projectsOf(serverContractsConfig).flatMap(
      (project) => project.test?.include ?? [],
    )

    // The union is the roster: reuse must never be a reason a file stops running, and a
    // shard that quietly shed the files it could not share a process with would be the same
    // false green POD-520's split was built to refuse.
    expect([...collected].sort()).toEqual([...roster].sort())
    // Exactly once. An overlap would run the file twice and let whichever project finished
    // first decide whether it was isolated.
    expect(collected.length).toBe(new Set(collected).size)
    expect(
      projectNamed(serverContractsConfig, 'server:contracts:reused').test?.isolate,
      'the reused project regained isolation',
    ).toBe(false)
    for (const project of projectsOf(serverContractsConfig)) {
      if (project.test?.name === 'server:contracts:reused') continue
      expect(project.test?.isolate, `${project.test?.name} lost isolation`).toBe(true)
    }
  })

  it('sorts each file into a project by the scan, not by a checked-in list', () => {
    // Membership is derived on every run: adding vi.useFakeTimers() to a reusable file
    // demotes it with no manifest to regenerate. Recompute and compare.
    const split = splitForReuse(contractsFiles(), repoRoot)
    expect(projectNamed(serverContractsConfig, 'server:contracts:reused').test?.include).toEqual(
      split.reusable,
    )
    expect(
      split.isolated.length === 0
        ? []
        : projectNamed(serverContractsConfig, 'server:contracts:isolated').test?.include,
    ).toEqual(split.isolated)
    // And the population is a real subset, not "everything" — if the scan ever matched
    // nothing at all it would silently promote files it has never actually checked.
    expect(split.reusable.length).toBeGreaterThan(0)
  })

  it('keeps every other shard fully isolated until reuse is proven for it', () => {
    // POD-515 rejected a global isolate=false as trading wall time for flakiness. store,
    // services and boundary compose the application and hold singletons; normalized-wire is
    // serialized on purpose. Widening this list is a decision, not a regeneration.
    expect([...REUSE_ENABLED_SHARDS]).toEqual(['contracts'])
  })

  it('demotes each construct vitest does not undo between files', () => {
    // Table-driven over the rules themselves, so a rule that stops matching its own
    // construct — a refactor of the pattern, say — fails here rather than silently
    // promoting every file that uses it.
    const samples: Record<string, string> = {
      'env-write': "process.env.FOO = 'bar'",
      'env-delete': 'delete process.env.FOO',
      'env-replace': 'process.env = {}',
      'stub-env': "vi.stubEnv('FOO', 'bar')",
      'stub-global': "vi.stubGlobal('fetch', vi.fn())",
      'fake-timers': 'vi.useFakeTimers()',
      'module-mock': "vi.mock('./thing')",
      'reset-modules': 'vi.resetModules()',
      'global-write': 'globalThis.fetch = vi.fn()',
      'process-listener': "process.on('exit', handler)",
      'process-chdir': 'process.chdir(dir)',
      'process-exit': 'process.exit(0)',
      'process-argv': "process.argv = ['node']",
      'require-cache': 'delete require.cache[id]',
    }
    expect(Object.keys(samples).sort()).toEqual(DISQUALIFIERS.map((rule) => rule.id).sort())
    for (const [id, source] of Object.entries(samples)) {
      expect(disqualifiersIn(source), `${id} stopped matching its own construct`).toContain(id)
    }
    // An ordinary contract test trips none of them — otherwise the scan would demote the
    // whole shard and this would all be a very expensive no-op.
    expect(
      disqualifiersIn(
        "import { expect, it } from 'vitest'\n" +
          "it('holds', () => { expect(policy(input)).toBe('allow') })\n",
      ),
    ).toEqual([])
  })

  it('does not carry a global regex lastIndex from one file into the next', () => {
    // The rules are module-level /g regexes. `RegExp.test` advances lastIndex on a match,
    // so without a reset the SECOND file with the same construct reads as clean — a silent
    // promotion that only shows up in the order the files happen to be scanned in.
    const source = "process.env.FOO = 'bar'"
    expect(disqualifiersIn(source)).toEqual(disqualifiersIn(source))
  })
})

/**
 * The spawned half. One fixture, one Vitest run each way.
 *
 * The fixture writes `process.pid` from inside each test file, which is the only place the
 * answer exists: the pool decides whether to hand a finished runner to the next file, and
 * nothing it decides is visible from the config.
 */
describe('runner reuse and its leak guard, observed [POD-527]', () => {
  let fixtureDir: string
  const observationLog = () => join(fixtureDir, 'observations.jsonl')

  /**
   * Each probe records what the hermetic setup gave it. Four fields, and three of them exist
   * because the setup had a live defect in exactly that place once a process outlived its
   * file — see docs/agents/pod-527-runner-reuse.md. Asserting the fix through a passing
   * reused shard would not survive a refactor of the setup: a shared state root does not
   * throw, it just makes two files agree when they should not.
   */
  const probeSource = (name: string) => `
import { appendFileSync } from 'node:fs'
import { it, expect } from 'vitest'
it('${name} records what the hermetic setup gave it', () => {
  appendFileSync(${JSON.stringify('__LOG__')}, JSON.stringify({
    name: '${name}',
    pid: process.pid,
    stateDir: process.env.PODIUM_STATE_DIR,
    tmpdir: process.env.TMPDIR,
    exitListeners: process.listenerCount('exit'),
  }) + '\\n')
  expect(true).toBe(true)
})
`

  const configSource = (isolate: boolean) => `
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    name: 'reuse-probe',
    root: ${JSON.stringify('__FIXTURE__')},
    include: ['*.test.ts'],
    pool: 'forks',
    isolate: ${isolate},
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    passWithNoTests: false,
    retry: 0,
    setupFiles: [
      ${JSON.stringify(join(repoRoot, 'test-hermetic-env.ts'))},
      ${JSON.stringify(join(repoRoot, 'test-hermetic-vitest-hooks.ts'))},
      ${JSON.stringify(join(repoRoot, 'test-hermetic-reuse-guard.ts'))},
    ],
  },
})
`

  interface Observation {
    name: string
    pid: number
    stateDir?: string
    tmpdir?: string
    exitListeners: number
  }
  interface ProbeRun {
    status: number | null
    output: string
    seen: Observation[]
  }
  const distinct = <T>(values: T[]) => new Set(values).size

  /** One spawned Vitest run over the fixture, with a fresh observation log each time. */
  const runVitest = (configFile: string, ...filters: string[]): ProbeRun => {
    rmSync(observationLog(), { force: true })
    const result = spawnSync(
      'bun',
      [
        '--bun',
        join(repoRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        join(fixtureDir, configFile),
        ...filters,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 180_000 },
    )
    let seen: Observation[] = []
    try {
      seen = readFileSync(observationLog(), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Observation)
    } catch {
      // A run that never reached a probe leaves no log; the status assertions report it.
    }
    return { status: result.status, output: `${result.stdout}\n${result.stderr}`, seen }
  }

  // Each spawn costs a Vitest boot, so the two probe runs happen once here and the cases
  // below assert against what they observed. Three spawns for the whole file.
  let reusedRun: ProbeRun
  let isolatedRun: ProbeRun

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(process.env.PODIUM_TEST_HOST_TMPDIR ?? tmpdir(), 'pod527-'))
    mkdirSync(fixtureDir, { recursive: true })
    for (const name of ['probe-a', 'probe-b', 'probe-c']) {
      writeFileSync(
        join(fixtureDir, `${name}.test.ts`),
        probeSource(name).replace(JSON.stringify('__LOG__'), JSON.stringify(observationLog())),
      )
    }
    // The one that leaks. It is otherwise an ordinary passing test — the failure has to come
    // from the guard, not from the assertions.
    writeFileSync(
      join(fixtureDir, 'zz-leaky.test.ts'),
      `
import { it, expect } from 'vitest'
it('passes its own assertion but leaves an env var behind', () => {
  process.env.POD527_LEAK_PROOF = 'left behind'
  expect(true).toBe(true)
})
`,
    )
    for (const [name, isolate] of [
      ['vitest.reused.config.ts', false],
      ['vitest.isolated.config.ts', true],
    ] as const) {
      writeFileSync(
        join(fixtureDir, name),
        configSource(isolate).replace(JSON.stringify('__FIXTURE__'), JSON.stringify(fixtureDir)),
      )
    }
    reusedRun = runVitest('vitest.reused.config.ts', 'probe-')
    isolatedRun = runVitest('vitest.isolated.config.ts', 'probe-')
    // Two Vitest boots; the default 10s hook timeout is for hooks that do not spawn one.
  }, 180_000)

  afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }))

  it('runs several files in ONE process when isolation is off, and one each when it is on', () => {
    // Without this assertion, a pool change that quietly restored isolation would leave the
    // whole lane green and merely slow. There is no other symptom.
    expect(reusedRun.status, `reused probe run failed:\n${reusedRun.output}`).toBe(0)
    expect(isolatedRun.status, `isolated probe run failed:\n${isolatedRun.output}`).toBe(0)
    expect(reusedRun.seen).toHaveLength(3)
    expect(isolatedRun.seen).toHaveLength(3)
    expect(
      distinct(reusedRun.seen.map((o) => o.pid)),
      'the pool stopped reusing a finished runner',
    ).toBe(1)
    expect(
      distinct(isolatedRun.seen.map((o) => o.pid)),
      'isolation stopped giving each file its own fork',
    ).toBe(3)
  })

  it('gives every file in a shared runner its OWN state root, tmp container and listeners', () => {
    // The three defects the hermetic setup had once a process outlived its test file. Each is
    // guarded by identity rather than by existence, because none of them fails loudly: a
    // shared PODIUM_STATE_DIR does not throw, it just lets two files see each other's data.
    // These assertions are meaningless outside one process, so start by pinning that.
    const seen = reusedRun.seen
    expect(seen).toHaveLength(3)
    expect(distinct(seen.map((o) => o.pid)), 'this only proves anything in ONE process').toBe(1)

    // 1. A state root PER FILE, not per runner. The original `if (!process.env.
    //    PODIUM_STATE_DIR)` minted one for the first file and left every file after it
    //    pointing at that same directory.
    const stateDirs = seen.map((o) => o.stateDir)
    expect(stateDirs.every(Boolean), 'a file ran with no hermetic state root').toBe(true)
    expect(distinct(stateDirs), `files in one runner shared a state root: ${stateDirs}`).toBe(3)

    // 2. Tmp containers that are SIBLINGS. Anchoring to tmpdir() read the TMPDIR the previous
    //    file had installed, so containers nested and releasing one deleted the next.
    const containers = seen.map((o) => o.tmpdir as string)
    expect(distinct(containers), 'files in one runner shared a tmp container').toBe(3)
    for (const outer of containers) {
      for (const inner of containers) {
        if (outer === inner) continue
        expect(inner.startsWith(`${outer}/`), `${inner} is nested inside ${outer}`).toBe(false)
      }
    }

    // 3. Exit handlers installed ONCE per process. Registering them per evaluation stacked a
    //    set per file — MaxListenersExceededWarning, and the whole cleanup re-run per file.
    const listeners = seen.map((o) => o.exitListeners)
    expect(distinct(listeners), `exit listeners grew per file: ${listeners.join(' -> ')}`).toBe(1)
  })

  it('fails the file that leaked, by name, with the key it left behind', () => {
    const run = runVitest('vitest.reused.config.ts', 'zz-leaky')
    expect(run.status, `a leaking file passed:\n${run.output}`).not.toBe(0)
    expect(run.output).toContain('[reuse leak]')
    expect(run.output).toContain('zz-leaky.test.ts')
    expect(run.output).toContain('process.env.POD527_LEAK_PROOF was added')
  })
})
