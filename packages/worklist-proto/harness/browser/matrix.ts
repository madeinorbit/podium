/**
 * POD-4558 (L5b) — the interleaved timing matrix: arms × scales, one
 * `run.ts` invocation per (arm, scale) per round, the pair order rotated each
 * round so box drift lands on every arm and scale alike.
 *
 * Hygiene (methodology §5.7): before each invocation the 1-minute load must be
 * at or below `--max-load` (default 8); the matrix waits for it up to
 * `--load-wait-min` minutes (default 20), then stops with the run FAILED. The
 * bench lease (`bench:ludovico`) is taken around each invocation and released
 * between them, never held across the matrix. An invocation that failed ONLY
 * on load is retried after the load drops (up to `--load-retries`, default 3;
 * the failed file stays beside it as `.tryN.json`, listed and never summarised
 * by `summarize.ts`). Any other failure fails the matrix (exit 2): a missing
 * cell is a failed run, not a gap.
 *
 *   bun packages/worklist-proto/harness/browser/matrix.ts \
 *     --arms noop,control --scales 1,2,4 --rounds 4 --samples 5 --tag floor
 *   bun packages/worklist-proto/harness/browser/summarize.ts \
 *     packages/worklist-proto/harness/browser/results/floor
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { loadavg } from 'node:os'
import { ARMS, type ArmName, type RunOutput, type Scale } from './records'

function arg(argv: string[], flag: string, fallback: string): string {
  const index = argv.indexOf(flag)
  return index >= 0 && index + 1 < argv.length ? (argv[index + 1] as string) : fallback
}

const argv = process.argv.slice(2)
const arms = arg(argv, '--arms', 'noop,control').split(',') as ArmName[]
for (const arm of arms) {
  if (!(ARMS as readonly string[]).includes(arm)) throw new Error(`unknown arm ${arm}`)
}
const scales = arg(argv, '--scales', '1,2,4').split(',').map(Number) as Scale[]
const rounds = Number(arg(argv, '--rounds', '4'))
const samples = arg(argv, '--samples', '5')
const warmup = arg(argv, '--warmup', '1')
const scenarios = arg(argv, '--scenarios', '')
const maxLoad = Number(arg(argv, '--max-load', '8'))
const loadWaitMs = Number(arg(argv, '--load-wait-min', '20')) * 60_000
const loadRetries = Number(arg(argv, '--load-retries', '3'))
const tag = arg(argv, '--tag', new Date().toISOString().replace(/[:.]/g, '-'))
const outDir = join('packages/worklist-proto/harness/browser/results', tag)

const pairs = arms.flatMap((arm) => scales.map((scale) => ({ arm, scale })))

function waitForLoad(): boolean {
  const deadline = Date.now() + loadWaitMs
  for (;;) {
    const load = loadavg()[0] ?? 0
    if (load <= maxLoad) return true
    if (Date.now() > deadline) {
      console.error(`[matrix] load ${load.toFixed(2)} > ${maxLoad} for ${loadWaitMs / 60_000} min: FAILED`)
      return false
    }
    console.log(`[matrix] load ${load.toFixed(2)} > ${maxLoad}; waiting`)
    spawnSync('sleep', ['30'])
  }
}

function lease(verb: 'acquire' | 'release'): boolean {
  const cmd =
    verb === 'acquire'
      ? ['lock', 'acquire', 'bench:ludovico', '--ttl', '30m', '--wait']
      : ['lock', 'release', 'bench:ludovico']
  const result = spawnSync('podium', cmd, { encoding: 'utf-8' })
  if (result.status !== 0) console.error(`[matrix] lease ${verb} failed:\n${result.stdout}${result.stderr}`)
  return result.status === 0
}

let failed = false
outer: for (let round = 0; round < rounds; round += 1) {
  const order = pairs.map((_, i) => pairs[(i + round) % pairs.length]!)
  for (const { arm, scale } of order) {
    const out = join(outDir, `r${round}-${arm}-${scale}x.json`)
    for (let attempt = 0; ; attempt += 1) {
      if (!waitForLoad() || !lease('acquire')) {
        failed = true
        break outer
      }
      const runArgs = [
        'packages/worklist-proto/harness/browser/run.ts',
        '--arm', arm,
        '--scale', String(scale),
        '--samples', samples,
        '--warmup', warmup,
        '--max-load', String(maxLoad),
        '--out', out,
        '--no-lease',
        ...(scenarios ? ['--scenarios', scenarios] : []),
      ]
      // Each invocation takes the heavy-test lease itself (a browser run is heavy).
      const result = spawnSync('bun', ['scripts/test-heavy.ts', '--', 'bun', ...runArgs], { stdio: 'inherit' })
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
        renameSync(out, out.replace(/\.json$/, `.try${attempt}.json`))
        console.log(`[matrix] round ${round} ${arm} ${scale}x failed on load; retrying`)
        continue
      }
      console.error(`[matrix] round ${round} ${arm} ${scale}x FAILED (exit ${result.status}); see ${out}`)
      failed = true
      break outer
    }
  }
}
console.log(`[matrix] ${failed ? 'FAILED' : 'complete'}: ${outDir}`)
process.exitCode = failed ? 2 : 0
