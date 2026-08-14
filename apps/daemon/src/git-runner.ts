import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  GIT_ABORTED_STATUS,
  GIT_CONVERGENCE_BUDGET_MS,
  GIT_TIMED_OUT_STATUS,
  type GitRun,
} from '@podium/runtime/update-delivery-git'

/**
 * Git delivery for ONE convergence, bound to that grant's abort.
 *
 * AWAITED, NEVER BLOCKING (POD-2046). This runs on the daemon's only thread,
 * which also carries PTY output, the server link, hook ingest and the agent
 * relay. The `spawnSync` this replaces froze all of them for as long as git ran
 * — up to the whole eight-minute budget against an unreachable remote — and the
 * freeze was itself why a superseding grant could not be observed. Do not
 * reintroduce a synchronous runner; `git-runner.test.ts` holds a control arm
 * that demonstrates what one costs.
 *
 * Two independent bounds apply. The abort ends a convergence the server has
 * superseded; the timeout ends one nobody is cancelling, which is still the
 * only thing standing between the daemon and a hung `git fetch`. The caller
 * passes the REMAINING whole-convergence budget, so the steps cannot add up
 * past the server's silence deadline.
 *
 * `env` is passed explicitly on purpose: Bun's SYNC spawns reuse the
 * process-start environment while the async ones read the live map
 * (`packages/pty/src/abduco.ts` [spec:SP-3f93]), so leaving it implicit would
 * have made this port change which environment git sees as a side effect.
 */
export function createGitRunner(signal?: AbortSignal): GitRun {
  return async (command, args, timeoutMs) => {
    const timeout = Math.max(
      1,
      Math.min(timeoutMs ?? GIT_CONVERGENCE_BUDGET_MS, GIT_CONVERGENCE_BUDGET_MS),
    )
    try {
      const { stdout } = await promisify(execFile)(command, args, {
        encoding: 'utf8',
        timeout,
        killSignal: 'SIGKILL',
        env: { ...process.env },
        ...(signal ? { signal } : {}),
      })
      return { status: 0, stdout: typeof stdout === 'string' ? stdout : '' }
    } catch (error) {
      const failure = error as { code?: unknown; killed?: boolean; name?: string; stdout?: unknown }
      const stdout = typeof failure.stdout === 'string' ? failure.stdout : ''
      // A cancelled step and an expired budget both end the convergence, but
      // they are opposite facts: one is a hand-off to a newer grant, the other
      // is this daemon giving up on a remote. Keep them distinct.
      if (signal?.aborted || failure.name === 'AbortError' || failure.code === 'ABORT_ERR') {
        return { status: GIT_ABORTED_STATUS, stdout }
      }
      if (failure.killed) return { status: GIT_TIMED_OUT_STATUS, stdout }
      // A real non-zero exit is the command's own verdict, so the convergence
      // can refuse with `fetch-failed`/`checkout-failed` rather than blaming a
      // timeout that did not happen.
      if (typeof failure.code === 'number') return { status: failure.code, stdout }
      return { status: GIT_TIMED_OUT_STATUS, stdout }
    }
  }
}
