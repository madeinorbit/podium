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
  const pidLog = () => join(fixtureDir, 'pids.txt')

  const probeSource = (name: string) => `
import { appendFileSync } from 'node:fs'
import { it, expect } from 'vitest'
it('${name} records the process it ran in', () => {
  appendFileSync(${JSON.stringify('__PID_LOG__')}, \`${name} \${process.pid}\\n\`)
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

  const runVitest = (configFile: string, ...filters: string[]) =>
    spawnSync(
      'bun',
      [
        '--bun',
        join(repoRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        configFile,
        ...filters,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 180_000 },
    )

  const pidsFor = (prefix: string) =>
    new Set(
      readFileSync(pidLog(), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.split(' ')[1]),
    )

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(process.env.PODIUM_TEST_HOST_TMPDIR ?? tmpdir(), 'pod527-'))
    mkdirSync(fixtureDir, { recursive: true })
    for (const name of ['probe-a', 'probe-b', 'probe-c']) {
      writeFileSync(
        join(fixtureDir, `${name}.test.ts`),
        probeSource(name).replace(JSON.stringify('__PID_LOG__'), JSON.stringify(pidLog())),
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
  })

  afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }))

  it('runs several files in ONE process when isolation is off, and one each when it is on', () => {
    // Without this assertion, a pool change that quietly restored isolation would leave the
    // whole lane green and merely slow. There is no other symptom.
    const reused = runVitest(join(fixtureDir, 'vitest.reused.config.ts'), 'probe-')
    expect(reused.status, `reused probe run failed:\n${reused.stdout}\n${reused.stderr}`).toBe(0)
    expect(pidsFor('probe-').size, 'the pool stopped reusing a finished runner').toBe(1)

    rmSync(pidLog(), { force: true })

    const isolated = runVitest(join(fixtureDir, 'vitest.isolated.config.ts'), 'probe-')
    expect(isolated.status, `isolated probe run failed:\n${isolated.stdout}`).toBe(0)
    expect(pidsFor('probe-').size, 'isolation stopped giving each file its own fork').toBe(3)
  })

  it('fails the file that leaked, by name, with the key it left behind', () => {
    const run = runVitest(join(fixtureDir, 'vitest.reused.config.ts'), 'zz-leaky')
    const output = `${run.stdout}\n${run.stderr}`
    expect(run.status, `a leaking file passed:\n${output}`).not.toBe(0)
    expect(output).toContain('[reuse leak]')
    expect(output).toContain('zz-leaky.test.ts')
    expect(output).toContain('process.env.POD527_LEAK_PROOF was added')
  })
})
