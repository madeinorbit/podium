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
 * the failed file stays beside it as `.tryN.json`, listed and never summarised
 * by `summarize.ts`). Any other failure fails the matrix (exit 2): a missing
 * cell is a failed run, not a gap. `--resume` (same `--tag`) keeps every
 * pair whose output already passed and runs only the rest, in the same
 * rotated order; the SHA check in `summarize.ts` still sees every file.
 *
 * `--host <ssh host>` times on another machine (round three's timing machine
 * is flatblock; POD-4286): the load is read there, each invocation runs there
 * over `ssh -o BatchMode=yes` in `~/<--remote-dir>` (default `podium-timing`)
 * with its pinned toolchain first on PATH, the lease is `bench:<host>` (taken
 * here: the timing machine has no podium CLI), there is no heavy-test lease
 * (that one guards this machine), and each output is copied back here, so
 * `--resume` and `summarize.ts` read local files. The remote checkout must be
 * at the commit being timed, with `harness/web/dist` built there.
 *
 *   bun packages/worklist-proto/harness/browser/matrix.ts \
 *     --arms noop,control --scales 1,2,4 --rounds 4 --samples 5 --tag floor [--host flatblock]
 *   bun packages/worklist-proto/harness/browser/summarize.ts \
 *     packages/worklist-proto/harness/browser/results/floor
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { hostname, loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { ARMS, type ArmName, type RunOutput, type Scale } from './records'

function arg(argv: string[], flag: string, fallback: string): string {
  const index = argv.indexOf(flag)
  return index >= 0 && index + 1 < argv.length ? (argv[index + 1] as string) : fallback
}

const argv = process.argv.slice(2)
// An arm, or `noop+<plant>` for a planted no-op page (the timer's and the
// budgets' can-say-NO runs), interleaved with the rest like any arm.
const arms = arg(argv, '--arms', 'noop,control').split(',')
for (const arm of arms) {
  const [name, plant] = arm.split('+')
  if (!(ARMS as readonly string[]).includes(name ?? '')) throw new Error(`unknown arm ${arm}`)
  if (plant !== undefined && name !== 'noop') throw new Error(`plants are for noop only (${arm})`)
}
const scales = arg(argv, '--scales', '1,2,4').split(',').map(Number) as Scale[]
const rounds = Number(arg(argv, '--rounds', '4'))
const samples = arg(argv, '--samples', '5')
const warmup = arg(argv, '--warmup', '1')
const scenarios = arg(argv, '--scenarios', '')
const maxLoad = Number(arg(argv, '--max-load', '8'))
const loadWaitMs = Number(arg(argv, '--load-wait-min', '20')) * 60_000
const loadRetries = Number(arg(argv, '--load-retries', '3'))
const resume = argv.includes('--resume')
const tag = arg(argv, '--tag', new Date().toISOString().replace(/[:.]/g, '-'))
const outDir = join('packages/worklist-proto/harness/browser/results', tag)
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
      `export PATH=$HOME/${remoteDir}/.toolchain:$PATH; cd ~/${remoteDir} && ${command}`,
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

const pairs = arms.flatMap((arm) => scales.map((scale) => ({ arm, scale })))

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
  const order = [...pairs.slice(round % pairs.length), ...pairs.slice(0, round % pairs.length)]
  for (const { arm, scale } of order) {
    const out = join(outDir, `r${round}-${arm}-${scale}x.json`)
    if (
      resume &&
      existsSync(out) &&
      (JSON.parse(readFileSync(out, 'utf-8')) as RunOutput).status === 'ok'
    ) {
      console.log(`[matrix] round ${round} ${arm} ${scale}x already passed; kept`)
      continue
    }
    if (existsSync(out)) {
      // A failed output from an earlier matrix: keep it beside the rerun.
      let n = 0
      while (existsSync(out.replace(/\.json$/, `.prior${n}.json`))) n += 1
      renameSync(out, out.replace(/\.json$/, `.prior${n}.json`))
    }
    for (let attempt = 0; ; attempt += 1) {
      if (!waitForLoad() || !lease('acquire')) {
        failed = true
        break outer
      }
      const [name, plant] = arm.split('+') as [ArmName, string | undefined]
      const runArgs = [
        'packages/worklist-proto/harness/browser/run.ts',
        '--arm',
        name,
        ...(plant !== undefined ? ['--plant', plant] : []),
        '--scale',
        String(scale),
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
        result = ssh(`rm -f '${out}' && bun ${runArgs.map((a) => `'${a}'`).join(' ')}`, true)
        mkdirSync(dirname(out), { recursive: true })
        const copy = spawnSync('scp', [
          '-q',
          '-o',
          'BatchMode=yes',
          `${host}:${remoteDir}/${out}`,
          out,
        ])
        if (copy.status !== 0) console.error(`[matrix] could not copy ${out} back from ${host}`)
      } else {
        // Each invocation takes the heavy-test lease itself (a browser run is heavy).
        result = spawnSync('bun', ['scripts/test-heavy.ts', '--', 'bun', ...runArgs], {
          stdio: 'inherit',
        })
      }
      lease('release')
      if (result.status === 0) break
      let loadOnly = false
      try {
        const run = JSON.parse(readFileSync(out, 'utf-8')) as RunOutput
        loadOnly = run.failures.length > 0 && run.failures.every((f) => f.startsWith('load '))
      } catch {
        // no output: not a load failure
      }
      if (loadOnly && attempt < loadRetries) {
        let n = attempt
        while (existsSync(out.replace(/\.json$/, `.try${n}.json`))) n += 1
        renameSync(out, out.replace(/\.json$/, `.try${n}.json`))
        console.log(`[matrix] round ${round} ${arm} ${scale}x failed on load; retrying`)
        continue
      }
      console.error(
        `[matrix] round ${round} ${arm} ${scale}x FAILED (exit ${result.status}); see ${out}`,
      )
      failed = true
      break outer
    }
  }
}
console.log(`[matrix] ${failed ? 'FAILED' : 'complete'}: ${outDir}`)
process.exitCode = failed ? 2 : 0
