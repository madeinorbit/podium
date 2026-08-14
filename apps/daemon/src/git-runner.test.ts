import { spawnSync } from 'node:child_process'
import {
  GIT_ABORTED_STATUS,
  GIT_TIMED_OUT_STATUS,
} from '@podium/runtime/update-delivery-git'
import { describe, expect, it } from 'vitest'
import { createGitRunner } from './git-runner'

/**
 * Long enough that a `setTimeout(…, 0)` scheduled beforehand is certain to have
 * run by the time it finishes, short enough not to drag the lane. Nothing here
 * asserts on elapsed time, so a loaded host cannot flake it.
 */
const SLOW_COMMAND = ['0.3']

/** Did the loop get a turn while `body` was in flight? */
async function loopRanDuring(body: () => Promise<unknown>): Promise<boolean> {
  let ran = false
  const timer = setTimeout(() => {
    ran = true
  }, 0)
  try {
    await body()
  } finally {
    clearTimeout(timer)
  }
  return ran
}

describe('createGitRunner', () => {
  /**
   * THE POINT OF THE WHOLE CHANGE (POD-2046).
   *
   * The control arm below is not redundant: it demonstrates that this assertion
   * can fail, by running the exact `spawnSync` shape the daemon used before.
   * Without it, a runner that had quietly gone synchronous again would still
   * show a green here and nobody would know the test had stopped testing.
   */
  it('leaves the event loop free while a command runs', async () => {
    const run = createGitRunner()
    expect(await loopRanDuring(() => run('sleep', SLOW_COMMAND))).toBe(true)
  })

  it('control: the synchronous spawn it replaced blocks the loop', async () => {
    const ran = await loopRanDuring(async () => {
      spawnSync('sleep', SLOW_COMMAND, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    })
    expect(ran).toBe(false)
  })

  it('reports a clean run with its stdout', async () => {
    const result = await createGitRunner()('echo', ['hello'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
  })

  it('names a step the budget killed as a timeout', async () => {
    const result = await createGitRunner()('sleep', SLOW_COMMAND, 20)
    expect(result.status).toBe(GIT_TIMED_OUT_STATUS)
  })

  it('names a cancelled step distinctly from a timeout', async () => {
    const abort = new AbortController()
    const run = createGitRunner(abort.signal)
    setTimeout(() => abort.abort(), 10)
    const result = await run('sleep', SLOW_COMMAND)
    expect(result.status).toBe(GIT_ABORTED_STATUS)
    expect(result.status).not.toBe(GIT_TIMED_OUT_STATUS)
  })

  it('cancels promptly rather than waiting out the timeout', async () => {
    const abort = new AbortController()
    // A timeout far longer than the test could tolerate: if the abort were not
    // honoured this would hang, so passing at all is the assertion.
    const run = createGitRunner(abort.signal)
    setTimeout(() => abort.abort(), 10)
    const result = await run('sleep', ['30'], 60_000)
    expect(result.status).toBe(GIT_ABORTED_STATUS)
  })

  it('passes a real non-zero exit through as the command own verdict', async () => {
    // `false` exits 1. Reporting it as a timeout would make the convergence
    // blame an unreachable remote for a command that answered immediately.
    const result = await createGitRunner()('false', [])
    expect(result.status).toBe(1)
    expect(result.status).not.toBe(GIT_TIMED_OUT_STATUS)
  })

  it('reads the LIVE environment, not the one this process started with', async () => {
    // Bun's sync spawns reuse the process-start environment [spec:SP-3f93], so
    // this is the behaviour the port had to make deliberate rather than inherit.
    const key = 'PODIUM_TEST_GIT_RUNNER_ENV'
    process.env[key] = 'live'
    try {
      const result = await createGitRunner()('sh', ['-c', `printf %s "$${key}"`])
      expect(result.stdout).toBe('live')
    } finally {
      delete process.env[key]
    }
  })
})
