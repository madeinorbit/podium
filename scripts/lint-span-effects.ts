/**
 * `bun run lint:span-effects` — the span-effect gate, through turbo's cache.
 *
 * WHY A WRAPPER AND NOT THE SCRIPT DIRECTLY. The check builds a whole TypeScript
 * program over `apps/server` and takes ~40 s. That is affordable once per change
 * to the sources it reads and unaffordable on every gate run, and the difference
 * between those two is exactly what a turbo task is for: the task's inputs name
 * every directory the program is built from, so a run that changed none of them
 * replays the previous result instead of recomputing it. A gate nobody can
 * afford to run is the POD-1369 class of instrument — this is what keeps this
 * one in `bun run test` (POD-3821).
 *
 * TWO THINGS IT HAS TO DO THAT A BARE `turbo run` DOES NOT:
 *
 *  1. POINT AT THE SHARED CACHE. Turbo's default cache lives inside the
 *     checkout, so every worktree starts cold and a result computed in one is
 *     invisible to the next. `sharedCacheDir` keys the cache on the COMMON GIT
 *     DIR, which is the identity every linked worktree of this repository
 *     shares — the same choice `scripts/typecheck.ts` makes and for the same
 *     reason (POD-1378, POD-3162).
 *  2. REFUSE A GREEN NOTHING PRODUCED. `--filter` that matches nothing exits 0
 *     having run no task, and turbo's footer says `0 successful, 0 total` while
 *     the shell says success. That is a gate reporting green for not having
 *     asked, so the footer is read back and a run that executed no task is a
 *     refusal (POD-3517's lesson, at this task's much smaller scale).
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sharedCacheDir } from './shared-cache-dir'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const TASK = 'lint:span-effects'
const PACKAGE = '@podium/scripts'

/**
 * Turbo's own footer, which is the only place a run says how many tasks it
 * actually attempted. `Tasks:    1 successful, 1 total`.
 */
export function tasksAttempted(output: string): number | null {
  const match = /^\s*Tasks:\s+\d+ successful, (\d+) total\s*$/m.exec(output)
  const total = match?.[1]
  return total === undefined ? null : Number(total)
}

export function accountingRefusal(output: string, exitCode: number): string | null {
  if (exitCode !== 0) return null
  const total = tasksAttempted(output)
  if (total === null)
    return (
      `${TASK}: turbo printed no task summary, so there is no evidence the check ran. ` +
      'Treat this as no result, not a pass.'
    )
  if (total < 1)
    return (
      `${TASK}: turbo attempted ${total} tasks. The filter matched no package that declares ` +
      `\`${TASK}\`, so nothing was checked and the exit code says nothing about this tree.`
    )
  return null
}

async function main(): Promise<void> {
  const cacheDir = process.env.TURBO_CACHE_DIR ?? sharedCacheDir('turbo', REPO_ROOT)
  mkdirSync(cacheDir, { recursive: true })
  const proc = Bun.spawn(
    [
      join(REPO_ROOT, 'node_modules', '.bin', 'turbo'),
      'run',
      TASK,
      '--filter',
      PACKAGE,
      ...process.argv.slice(2),
    ],
    {
      cwd: REPO_ROOT,
      stdio: ['inherit', 'pipe', 'inherit'],
      env: { ...process.env, TURBO_CACHE_DIR: cacheDir },
    },
  )
  // Tee: the reader is what lets the footer be checked, and the write keeps the
  // run readable while it happens rather than only after it ends.
  let captured = ''
  const reader = (async (): Promise<void> => {
    for await (const chunk of proc.stdout) {
      const text = new TextDecoder().decode(chunk)
      captured += text
      process.stdout.write(text)
    }
  })()
  const exitCode = await proc.exited
  await reader
  const refusal = accountingRefusal(captured, exitCode)
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  process.exit(exitCode)
}

if (import.meta.main) await main()
