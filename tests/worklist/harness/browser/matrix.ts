/**
 * POD-4558 (L5b) — the interleaved timing matrix: arms × scales, one
 * `run.ts` invocation per (arm, scale) per round, the pair order rotated each
 * round so box drift lands on every arm and scale alike.
 *
 * Hygiene (methodology §5.7): before each invocation the 1-minute load must be
 * at or below `--max-load` (default 8); the matrix waits for it up to
 * `--load-wait-min` minutes (default 20), then stops with the run FAILED. The
 * bench lease (`bench:<machine>`) is taken around each invocation and released
 * between them, never held across the matrix. An invocation that failed ONLY
 * on load is retried after the load drops (up to `--load-retries`, default 3;
 * its `.failed.json` stays beside it as `.tryN.failed.json`, listed and never
 * summarised by `summarize.ts`). Any other failure fails the matrix (exit 2):
 * a missing cell is a failed run, not a gap (POD-4562). `--max-load` may lower
 * the ceiling of 8, never raise it. The matrix writes its plan to
 * `matrix-plan.json` beside the runs; `summarize.ts` refuses the directory
 * unless every planned run passed with every cell full. `--dry-run` prints
 * the plan and the rotated pair order and runs nothing. `--resume` (same
 * `--tag`, same plan) keeps every pair whose output already passed and runs
 * only the rest, in the same rotated order; the SHA check in `summarize.ts`
 * still sees every file.
 *
 * `--host <ssh host>` times on another machine (round three's timing machine
 * is flatblock; POD-4286): the load is read there, each invocation runs there
 * over `ssh -o BatchMode=yes` in `~/<--remote-dir>` (default `podium-timing`)
 * with its pinned toolchain first on PATH, the lease is `bench:<host>` (taken
 * here: the timing machine has no podium CLI), `.toolchain/lib` is on
 * LD_LIBRARY_PATH (flatblock's Chromium needs a user-space libasound.so.2
 * there, from Ubuntu's libasound2t64), there is no heavy-test lease
 * (that one guards this machine), and each output is copied back here, so
 * `--resume` and `summarize.ts` read local files. The remote checkout must be
 * at the commit being timed, with `harness/web/dist` built there.
 *
 *   bun --conditions=@podium/source tests/worklist/harness/browser/matrix.ts \
 *     --arms noop,hand --scales 1,2,4 --rounds 4 --samples 5 --tag floor [--host flatblock]
 *   bun tests/worklist/harness/browser/summarize.ts \
 *     tests/worklist/harness/browser/results/floor
 *
 * CELLS (POD-4747): `--cells h1a1,h10a1,h1a4` interleaves (arm, cell) pairs
 * instead of (arm, scale) pairs, each invocation `run.ts --cell <cell>`, into
 * `r<round>-<arm>-<cell>.json`; `growth.ts` summarises such a directory
 * (`summarize.ts` refuses it).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname, loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { cellLabel, parseCell } from '../src/fixture/index'
import {
  checkMaxLoad,
  failedPathFor,
  isLoadOnlyFailure,
  MATRIX_PLAN_FILE,
  MAX_LOAD,
  type MatrixPlan,
  matrixRunFile,
} from './complete'
import {
  CAPTURE_ARMS,
  type ArmName,
  type RunOutput,
  SCENARIOS,
  type Scale,
  type ScenarioName,
} from './records'

function arg(argv: string[], flag: string, fallback: string): string {
  const index = argv.indexOf(flag)
  return index >= 0 && index + 1 < argv.length ? (argv[index + 1] as string) : fallback
}

const argv = process.argv.slice(2)
// An arm, or `noop+<plant>` for a planted no-op page (the timer's and the
// budgets' can-say-NO runs), interleaved with the rest like any arm.
const arms = arg(argv, '--arms', 'noop,hand').split(',')
for (const arm of arms) {
  const [name, plant] = arm.split('+')
  if (!(CAPTURE_ARMS as readonly string[]).includes(name ?? '')) throw new Error(`unknown arm ${arm}`)
  if (plant !== undefined && name !== 'noop') throw new Error(`plants are for noop only (${arm})`)
}
const cells = arg(argv, '--cells', '')
  .split(',')
  .filter((c) => c !== '')
  .map((c) => cellLabel(parseCell(c)))
if (cells.length > 0 && argv.includes('--scales'))
  throw new Error('--cells and --scales are exclusive')
const scales = (
  cells.length > 0 ? [] : arg(argv, '--scales', '1,2,4').split(',').map(Number)
) as Scale[]
const rounds = Number(arg(argv, '--rounds', '4'))
const samples = arg(argv, '--samples', '5')
const warmup = arg(argv, '--warmup', '1')
const scenarios = arg(argv, '--scenarios', '')
const maxLoad = checkMaxLoad(Number(arg(argv, '--max-load', String(MAX_LOAD))))
const loadWaitMs = Number(arg(argv, '--load-wait-min', '20')) * 60_000
const loadRetries = Number(arg(argv, '--load-retries', '3'))
const resume = argv.includes('--resume')
const tag = arg(argv, '--tag', new Date().toISOString().replace(/[:.]/g, '-'))
const outDir = join('tests/worklist/harness/browser/results', tag)
const host = arg(argv, '--host', '')
const remoteDir = arg(argv, '--remote-dir', 'podium-timing')
const benchLease = `bench:${host || hostname()}`

function ssh(command: string, inherit = false): ReturnType<typeof spawnSync> {
  return spawnSync(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      host,
      `export PATH=$HOME/${remoteDir}/.toolchain:$PATH LD_LIBRARY_PATH=$HOME/${remoteDir}/.toolchain/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}; cd ~/${remoteDir} && ${command}`,
    ],
    { encoding: 'utf-8', stdio: inherit ? 'inherit' : 'pipe' },
  )
}

/** The 1-minute load on the timing machine; +Infinity when it cannot be read. */
function load1(): number {
  if (!host) return loadavg()[0] ?? 0
  const result = ssh('cat /proc/loadavg')
  const value = Number(String(result.stdout ?? '').split(' ')[0])
  return result.status === 0 && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

/** One invocation per (arm, scale), or per (arm, cell) on a cells matrix. */
const pairs = arms.flatMap((arm) =>
  cells.length > 0
    ? cells.map((cell) => ({ arm, scale: cell as Scale | string }))
    : scales.map((scale) => ({ arm, scale: scale as Scale | string })),
)
const labelOf = (scale: Scale | string): string => (typeof scale === 'number' ? `${scale}x` : scale)
const orderOf = (round: number): typeof pairs => [
  ...pairs.slice(round % pairs.length),
  ...pairs.slice(0, round % pairs.length),
]

const plan: MatrixPlan = {
  arms,
  scales,
  ...(cells.length > 0 ? { cells } : {}),
  rounds,
  samples: Number(samples),
  warmup: Number(warmup),
  scenarios: (scenarios ? scenarios.split(',') : [...SCENARIOS]) as ScenarioName[],
  maxLoad,
}
if (argv.includes('--dry-run')) {
  console.log(`[matrix] dry run: ${outDir}${host ? ` on ${host}` : ''}`)
  console.log(JSON.stringify(plan))
  for (let round = 0; round < rounds; round += 1) {
    console.log(
      `  round ${round}: ${orderOf(round)
        .map((p) => `${p.arm} ${labelOf(p.scale)}`)
        .join(', ')}`,
    )
  }
  console.log(
    `  complete = ${pairs.length * rounds} ok runs; per (arm, scale, scenario) ${rounds * plan.samples} samples, every record at load <= ${maxLoad}`,
  )
  process.exit(0)
}
mkdirSync(outDir, { recursive: true })
const planPath = join(outDir, MATRIX_PLAN_FILE)
if (existsSync(planPath) && readFileSync(planPath, 'utf-8') !== JSON.stringify(plan, null, 2)) {
  throw new Error(`${planPath} holds a different plan: use a new --tag`)
}
writeFileSync(planPath, JSON.stringify(plan, null, 2))

function waitForLoad(): boolean {
  const deadline = Date.now() + loadWaitMs
  for (;;) {
    const load = load1()
    if (load <= maxLoad) return true
    if (Date.now() > deadline) {
      console.error(
        `[matrix] load ${load.toFixed(2)} > ${maxLoad} for ${loadWaitMs / 60_000} min: FAILED`,
      )
      return false
    }
    console.log(`[matrix] load ${load.toFixed(2)} > ${maxLoad}; waiting`)
    spawnSync('sleep', ['30'])
  }
}

function lease(verb: 'acquire' | 'release'): boolean {
  const cmd =
    verb === 'acquire'
      ? ['lock', 'acquire', benchLease, '--ttl', '30m', '--wait']
      : ['lock', 'release', benchLease]
  const result = spawnSync('podium', cmd, { encoding: 'utf-8' })
  if (result.status !== 0)
    console.error(`[matrix] lease ${verb} failed:\n${result.stdout}${result.stderr}`)
  return result.status === 0
}

let failed = false
outer: for (let round = 0; round < rounds; round += 1) {
  for (const { arm, scale } of orderOf(round)) {
    const out = join(outDir, matrixRunFile(round, arm, scale))
    const failedOut = failedPathFor(out)
    if (
      resume &&
      existsSync(out) &&
      (JSON.parse(readFileSync(out, 'utf-8')) as RunOutput).status === 'ok'
    ) {
      console.log(`[matrix] round ${round} ${arm} ${labelOf(scale)} already passed; kept`)
      continue
    }
    for (const earlier of [out, failedOut]) {
      if (!existsSync(earlier)) continue
      // A failed output from an earlier matrix: keep it beside the rerun.
      let n = 0
      const prior = (k: number): string =>
        failedPathFor(out).replace(/\.failed\.json$/, `.prior${k}.failed.json`)
      while (existsSync(prior(n))) n += 1
      renameSync(earlier, prior(n))
    }
    for (let attempt = 0; ; attempt += 1) {
      if (!waitForLoad() || !lease('acquire')) {
        failed = true
        break outer
      }
      const [name, plant] = arm.split('+') as [ArmName, string | undefined]
      const runArgs = [
        // The driver imports the fixture (the rescope truth, the cells), whose
        // workspace packages resolve only to source (no dist is ever built).
        '--conditions=@podium/source',
        'tests/worklist/harness/browser/run.ts',
        '--arm',
        name,
        ...(plant !== undefined ? ['--plant', plant] : []),
        ...(typeof scale === 'number' ? ['--scale', String(scale)] : ['--cell', scale]),
        '--samples',
        samples,
        '--warmup',
        warmup,
        '--max-load',
        String(maxLoad),
        '--out',
        out,
        '--no-lease',
        ...(scenarios ? ['--scenarios', scenarios] : []),
      ]
      let result: ReturnType<typeof spawnSync>
      if (host) {
        // Never copy back an earlier attempt's file: the remote output goes first.
        result = ssh(
          `rm -f '${out}' '${failedOut}' && bun ${runArgs.map((a) => `'${a}'`).join(' ')}`,
          true,
        )
        mkdirSync(dirname(out), { recursive: true })
        // The run wrote exactly one of the two: the result, or its failure.
        const copied = [out, failedOut].some(
          (file) =>
            spawnSync('scp', ['-q', '-o', 'BatchMode=yes', `${host}:${remoteDir}/${file}`, file])
              .status === 0,
        )
        if (!copied) console.error(`[matrix] could not copy ${out} back from ${host}`)
      } else {
        // Each invocation takes the heavy-test lease itself (a browser run is heavy).
        result = spawnSync('bun', ['scripts/test-heavy.ts', '--', 'bun', ...runArgs], {
          stdio: 'inherit',
        })
      }
      lease('release')
      if (result.status === 0 && existsSync(out) && !existsSync(failedOut)) break
      let loadOnly = false
      try {
        const run = JSON.parse(readFileSync(failedOut, 'utf-8')) as RunOutput
        loadOnly = isLoadOnlyFailure(run.failures)
      } catch {
        // no failure output: not a load failure
      }
      if (loadOnly && attempt < loadRetries) {
        let n = attempt
        const tried = (k: number): string =>
          failedOut.replace(/\.failed\.json$/, `.try${k}.failed.json`)
        while (existsSync(tried(n))) n += 1
        renameSync(failedOut, tried(n))
        console.log(`[matrix] round ${round} ${arm} ${labelOf(scale)} failed on load; retrying`)
        continue
      }
      console.error(
        `[matrix] round ${round} ${arm} ${labelOf(scale)} FAILED (exit ${result.status}); see ${failedOut}`,
      )
      failed = true
      break outer
    }
  }
}
console.log(`[matrix] ${failed ? 'FAILED' : 'complete'}: ${outDir}`)
process.exitCode = failed ? 2 : 0
