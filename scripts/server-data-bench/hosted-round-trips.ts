/**
 * Compare the real operation fixtures before/after in one run on an agent VM:
 * bun scripts/server-data-bench/hosted-round-trips.ts [--before <commit>] [--out <file>]
 *
 * Both revisions generate their own data on disposable Postgres stores. The baseline
 * has its own checkout and dependency tree. No live server or daemon is contacted.
 */
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

const root = resolve(import.meta.dir, '../..')
// Measurement instrumentation only, before the reductions.
const before = option('before') ?? 'cb173d4dc9'
const files = ['session-create', 'mail-send', 'steward.subscriptions', 'sync-feed'].map(
  (name) => `apps/server/src/${name}.statement-count.test.ts`,
)
const pattern = [
  'round trips',
  'Postgres measurement',
  'in process, a session on an issue',
  'over tRPC, to a running session$',
  'through the agent relay, to a running session$',
  'whose issue holds mail$',
  'over tRPC, to an issue$',
  'through the agent relay,.*own issue$',
  'a delta over one rename',
  'a hello without a cursor is admitted at the head$',
  'a hello that resumes from a cursor$',
].join('|')

interface Sample {
  name: string
  size?: number
  statements: number
  roundTrips: number
  byCall: Record<string, number>
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  if (at < 0) return undefined
  const value = process.argv[at + 1]
  assert.ok(value && !value.startsWith('--'), `--${name} requires a value`)
  return value
}

async function run(cwd: string, command: string[], env = process.env): Promise<string> {
  const child = Bun.spawn(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) {
    process.stderr.write(stdout + stderr)
    throw new Error(`${command.join(' ')} exited ${code}`)
  }
  return stdout + stderr
}

async function measure(cwd: string, variant: string): Promise<Sample[]> {
  console.error(`Measuring ${variant}: ${await run(cwd, ['git', 'rev-parse', '--short', 'HEAD'])}`)
  const output = await run(
    cwd,
    ['bun', 'run', 'test:lane', '--', 'server-store-pg', ...files, '-t', pattern],
    { ...process.env, PODIUM_ROUND_TRIP_REPORT: '1' },
  )
  const samples: Sample[] = []
  const clean = stripVTControlCharacters(output)
  for (const line of clean.split('\n')) {
    const match = /(?:OPERATION-SAMPLE|ROUND-TRIP-SAMPLE) (\{.*\})/.exec(line)
    if (match) samples.push(JSON.parse(match[1]!) as Sample)
  }
  assert.ok(samples.length > 0, `${variant}: no operation samples`)
  assert.ok(samples.every((sample) => sample.statements > 0 && sample.roundTrips > 0))
  console.error(`${variant}: ${samples.length} samples`)
  return samples
}

function range(values: number[]) {
  return { min: Math.min(...values), max: Math.max(...values) }
}

const directory = await mkdtemp(join(tmpdir(), 'hosted-round-trips-'))
const baseline = join(directory, 'before')
let added = false
try {
  await run(root, ['git', 'worktree', 'add', '--detach', baseline, before])
  added = true
  await run(baseline, ['bun', 'run', 'setup:worktree'])
  // The same production focus operation on both revisions. Only this measurement
  // probe is added to the old test harness; the baseline's product code is untouched.
  const testPath = files[0]!
  const currentTest = await readFile(join(root, testPath), 'utf8')
  const focusProbe = currentTest.split('// BEGIN FOCUS CENSUS')[1]?.split('// END FOCUS CENSUS')[0]
  assert.ok(focusProbe, 'focus census probe missing')
  await appendFile(join(baseline, testPath), `\n// BEGIN FOCUS CENSUS${focusProbe}\n`)
  const beforeSamples = await measure(baseline, 'before')
  const afterSamples = await measure(root, 'after')
  const names = [...new Set(beforeSamples.map((sample) => sample.name))]
  const comparison = names.map((name) => {
    const a = beforeSamples.filter((sample) => sample.name === name)
    const b = afterSamples.filter((sample) => sample.name === name)
    assert.equal(b.length, a.length, `${name}: missing comparison samples`)
    return {
      name,
      before: {
        statements: range(a.map((s) => s.statements)),
        roundTrips: range(a.map((s) => s.roundTrips)),
      },
      after: {
        statements: range(b.map((s) => s.statements)),
        roundTrips: range(b.map((s) => s.roundTrips)),
      },
    }
  })
  const report = {
    bench: 'hosted-round-trips',
    engine: 'pg',
    baseline: before,
    candidate: (await run(root, ['git', 'rev-parse', 'HEAD'])).trim(),
    comparison,
    samples: { before: beforeSamples, after: afterSamples },
  }
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (option('out')) await writeFile(resolve(option('out')!), json)
  process.stdout.write(json)
} finally {
  if (added) await run(root, ['git', 'worktree', 'remove', '--force', baseline])
  await rm(directory, { recursive: true, force: true })
}
