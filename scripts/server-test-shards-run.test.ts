import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { executedTestFiles, SHARD_REPORT_DIR_ENV } from '../apps/server/test-shard-report'
import {
  readManifest,
  reconcile,
  repositoryRoot,
  SHARD_COMMAND_ENV,
  shardInvocation,
  SHARDS,
} from './server-test-shards'

/**
 * The run-accounting guard for `@podium/server`'s test aggregate (POD-3531).
 *
 * THE DEFECT THESE TESTS EXIST FOR. `cd apps/server && bun run test` printed "445 unit
 * files across 5 shards" and exited 0 in a third of a second, having run none of them. The
 * five shards are Turbo `dependsOn` dependencies, so the gated lane was honest and only a
 * human running the documented-looking command was lied to.
 *
 * WHY THE FIRST TEST IS SHAPED THE WAY IT IS. Spec rule 56a: a guard's control arm cannot
 * show its own refusal, because the old runner never refused — that IS the defect. So the
 * first test does not look for a message. It drives the REAL CLI with the shard command
 * replaced by a recorder and asserts all five shards were invoked; against the runner as it
 * was, the recorder records nothing and the test fails on "0 shards ran", which is exactly
 * the observation that was missing.
 *
 * The other direction — the one rule 56a asks for as well — is the two refusal tests below:
 * make what the run collected disagree with what it announced, and require an ISOLATING
 * message naming the shard and both counts, not a bare non-zero or a timeout.
 */

const temporaryRoots: string[] = []
afterAll(() => {
  for (const dir of temporaryRoots) rmSync(dir, { recursive: true, force: true })
})

const manifest = readManifest(repositoryRoot)
const announcedTotal = manifest.shards.reduce((sum, shard) => sum + shard.testFiles.length, 0)

/**
 * A stand-in for `bun run test:<shard>`: it writes the Vitest JSON report a real shard would
 * write, under the control of `STUB_PLAN`, and appends the shard id to a ledger so the test
 * can see which shards the runner actually reached.
 *
 * `STUB_PLAN` is JSON: `{ skip?: string[], short?: Record<string, number> }` — shards that
 * write no report at all, and shards that report that many fewer files than they claim.
 */
const STUB_SOURCE = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const shardId = process.argv[2]
const root = process.env.STUB_ROOT
const plan = JSON.parse(process.env.STUB_PLAN ?? '{}')
appendFileSync(process.env.STUB_LEDGER, shardId + '\\n')
if ((plan.skip ?? []).includes(shardId)) process.exit(0)
if ((plan.malformed ?? []).includes(shardId)) {
  writeFileSync(join(process.env.${SHARD_REPORT_DIR_ENV}, shardId + '.json'), 'null')
  process.exit(0)
}

const manifest = JSON.parse(readFileSync(join(root, 'apps/server/test-shards.json'), 'utf8'))
const shard = manifest.shards.find((candidate) => candidate.id === shardId)
const drop = plan.short?.[shardId] ?? 0
const files = drop > 0 ? shard.testFiles.slice(0, shard.testFiles.length - drop) : shard.testFiles
writeFileSync(
  join(process.env.${SHARD_REPORT_DIR_ENV}, shardId + '.json'),
  JSON.stringify({
    success: true,
    testResults: files.map((file) => ({ name: join(root, file), status: 'passed',
      assertionResults: [{ status: (plan.skipped ?? []).includes(shardId) ? 'pending' : 'passed' }],
    })),
  }),
)
`

interface StubPlan {
  skip?: string[]
  short?: Record<string, number>
  skipped?: string[]
  malformed?: string[]
}

interface CliResult {
  exitCode: number
  output: string
  /** Shard ids the runner actually invoked, in order. */
  invoked: string[]
}

/** Drive the real `scripts/server-test-shards.ts` CLI against the stub shard. */
async function runCli(plan: StubPlan, args: string[] = []): Promise<CliResult> {
  const fixture = mkdtempSync(join(tmpdir(), 'pod-3531-'))
  temporaryRoots.push(fixture)
  const stub = join(fixture, 'stub-shard.ts')
  const ledger = join(fixture, 'invoked.txt')
  // The report directory is a SUBDIRECTORY of the fixture, not the fixture: the runner
  // clears it before running so a previous run's reports cannot read as this run's, and
  // pointing it at the fixture root deletes the stub and the ledger with them.
  const reports = join(fixture, 'reports')
  writeFileSync(stub, STUB_SOURCE)
  writeFileSync(ledger, '')

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    [SHARD_COMMAND_ENV]: `bun ${stub}`,
    [SHARD_REPORT_DIR_ENV]: reports,
    STUB_ROOT: repositoryRoot,
    STUB_PLAN: JSON.stringify(plan),
    STUB_LEDGER: ledger,
  }
  // The aggregate must behave as a hand-run command, not as a Turbo task whose dependencies
  // already did the running. Deleted rather than set to undefined: an env value of the
  // STRING "undefined" is truthy, and would silently put this test in the delegated path.
  delete env.TURBO_HASH

  const child = Bun.spawn(['bun', 'run', 'test', ...args], {
    cwd: join(repositoryRoot, 'apps/server'),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return {
    exitCode,
    output: `${stdout}${stderr}`,
    invoked: readFileSync(ledger, 'utf8').split('\n').filter(Boolean),
  }
}

describe('the @podium/server test aggregate, run directly', () => {
  it('runs every shard it announced, and says so', async () => {
    const result = await runCli({})

    // The control arm. Against the runner this issue fixes, `invoked` is empty and the exit
    // code is 0 — a roster printed, nothing run, success reported.
    expect(result.invoked).toEqual(SHARDS.map((shard) => shard.id))
    expect(result.output).toContain(`${announcedTotal} unit files across 5 shards`)
    expect(result.output).toContain(
      `${announcedTotal} unit files announced, ${announcedTotal} executed`,
    )
    expect(result.exitCode).toBe(0)
  }, 120_000)

  it('refuses, naming the shard and both counts, when a shard runs fewer files than it announced', async () => {
    const store = manifest.shards.find((shard) => shard.id === 'store')
    if (!store) throw new Error('the store shard left the manifest')
    const result = await runCli({ short: { store: 2 } })

    // Isolating, not a bare non-zero: the shard, the announced count, the executed count,
    // and the files that did not run.
    expect(result.output).toContain(
      `[short-shard] shard "store" announced ${store.testFiles.length} files but executed ` +
        `${store.testFiles.length - 2}; did not run: `,
    )
    for (const file of store.testFiles.slice(-2)) expect(result.output).toContain(file)
    expect(result.output).toContain(
      `the roster announced ${announcedTotal} unit files across 5 shards; the run executed ${announcedTotal - 2}`,
    )
    expect(result.exitCode).toBe(1)
  }, 120_000)

  it('refuses when a shard leaves no record of having run', async () => {
    const services = manifest.shards.find((shard) => shard.id === 'services')
    if (!services) throw new Error('the services shard left the manifest')
    const result = await runCli({ skip: ['services'] })

    expect(result.output).toContain(
      `[unrun] shard "services" announced ${services.testFiles.length} files but left no record of running any`,
    )
    // The other four still ran: an unaccounted shard must not fail-fast the rest, or the
    // refusal cannot say what happened to them.
    expect(result.invoked).toEqual(SHARDS.map((shard) => shard.id))
    expect(result.exitCode).toBe(1)
  }, 120_000)

  it('refuses files collected successfully with every assertion skipped', async () => {
    const result = await runCli({ skipped: ['store'] })
    const store = manifest.shards.find((shard) => shard.id === 'store')!
    expect(result.output).toContain(
      `[short-shard] shard "store" announced ${store.testFiles.length} files but executed 0`,
    )
    expect(result.exitCode).toBe(1)
  }, 120_000)

  it('refuses malformed reports with a shard-specific diagnostic and finishes the roster', async () => {
    const result = await runCli({ malformed: ['store'] })
    expect(result.output).toContain('[unrun] shard "store"')
    expect(result.output).toContain('invalid Vitest report: expected success and testResults')
    expect(result.invoked).toEqual(SHARDS.map((shard) => shard.id))
    expect(result.exitCode).toBe(1)
  }, 120_000)

  it('--roster prints the list, runs nothing, and says that it ran nothing', async () => {
    const result = await runCli({}, ['--roster'])

    expect(result.invoked).toEqual([])
    expect(result.output).toContain('ROSTER ONLY — no tests were run')
    expect(result.exitCode).toBe(0)
  }, 60_000)
})

describe('reconciliation', () => {
  const full = manifest.shards.map((shard) => ({
    id: shard.id,
    exitCode: 0,
    executed: shard.testFiles,
    reportError: null,
    success: true,
  }))

  it('accepts a run that executed exactly the roster', () => {
    expect(reconcile(manifest, full)).toEqual([])
  })

  it('refuses a shard that executed a file no shard claims', () => {
    const [first, ...rest] = full
    if (!first) throw new Error('empty manifest')
    const failures = reconcile(manifest, [
      { ...first, executed: [...first.executed, 'apps/server/src/not-in-any-shard.test.ts'] },
      ...rest,
    ])
    expect(failures.map((failure) => failure.kind)).toContain('roster-mismatch')
    expect(failures[0]?.detail).toContain('apps/server/src/not-in-any-shard.test.ts')
  })

  it('refuses a shard whose command failed even when its report is complete', () => {
    const [first, ...rest] = full
    if (!first) throw new Error('empty manifest')
    const failures = reconcile(manifest, [{ ...first, exitCode: 1 }, ...rest])
    expect(failures).toEqual([{ kind: 'shard-failed', detail: `shard "${first.id}" exited 1` }])
  })
})

describe('the direct path and the gated path run the same thing', () => {
  it('defaults to the package script Turbo runs for each shard', () => {
    for (const shard of SHARDS) {
      expect(shardInvocation(repositoryRoot, shard.id, {})).toEqual({
        command: ['bun', 'run', `test:${shard.id}`],
        cwd: join(repositoryRoot, 'apps/server'),
      })
    }
  })

  it('declares each shard report as a Turbo output, so a cache hit still carries its evidence', () => {
    const turbo = JSON.parse(
      readFileSync(join(repositoryRoot, 'apps/server/turbo.json'), 'utf8'),
    ) as { tasks: Record<string, { outputs?: string[] }> }
    for (const shard of SHARDS) {
      expect(turbo.tasks[`test:${shard.id}`]?.outputs).toEqual([
        `.test-shard-reports/${shard.id}.json`,
      ])
    }
  })
})

describe('report execution evidence', () => {
  it('counts passed and failed assertions, but not pending, todo or empty files', () => {
    const report = {
      testResults: ['passed', 'failed', 'pending', 'todo']
        .map((status) => ({
          name: join(repositoryRoot, `${status}.test.ts`),
          assertionResults: [{ status }],
        }))
        .concat([{ name: join(repositoryRoot, 'empty.test.ts'), assertionResults: [] }]),
    }
    expect(executedTestFiles(repositoryRoot, report)).toEqual(['failed.test.ts', 'passed.test.ts'])
  })
})
