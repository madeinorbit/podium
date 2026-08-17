import { describe, expect, it } from 'vitest'
import {
  convergeViaGit,
  GIT_ABORTED_STATUS,
  GIT_TIMED_OUT_STATUS,
  type GitRun,
  withGitBudget,
} from '@podium/runtime/update-delivery-git'

type Call = { cmd: string; args: string[] }

function runner(
  calls: Call[],
  response: (call: Call) => { status: number | null; stdout: string },
): GitRun {
  return async (cmd, args) => {
    const call = { cmd, args }
    calls.push(call)
    return response(call)
  }
}

function operation(call: Call): string | undefined {
  return call.args.find(
    (arg) => arg === 'status' || arg === 'rev-parse' || arg === 'fetch' || arg === 'checkout',
  )
}

describe('convergeViaGit', () => {
  it('refuses a dirty checkout before fetching or checking out', async () => {
    const calls: Call[] = []
    const result = await convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, (call) =>
          operation(call) === 'status'
            ? { status: 0, stdout: ' M apps/cli/src/index.ts\n' }
            : { status: 0, stdout: '' },
        ),
      },
    )

    expect(result).toEqual({ ok: false, reason: 'dirty-working-tree' })
    expect(calls).toHaveLength(1)
  })

  it('does not use destructive cleanup or reset commands', async () => {
    const calls: Call[] = []
    const result = await convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, () => ({ status: 0, stdout: '' })),
      },
    )

    expect(result).toEqual({ ok: true })
    const command = calls.flatMap(({ cmd, args }) => [cmd, ...args]).join(' ')
    expect(command).not.toMatch(/\b(reset|clean)\b|--hard|--force/)
  })

  it('fetches before checking out the requested revision', async () => {
    const calls: Call[] = []
    const result = await convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, () => ({ status: 0, stdout: '' })),
      },
    )

    expect(result).toEqual({ ok: true })
    expect(calls.map(operation)).toEqual(['status', 'rev-parse', 'fetch', 'checkout'])
  })

  it('keeps an already-current source checkout attached to its branch', async () => {
    const calls: Call[] = []
    const result = await convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, (call) =>
          operation(call) === 'rev-parse'
            ? { status: 0, stdout: 'abc1234\n' }
            : { status: 0, stdout: '' },
        ),
      },
    )

    expect(result).toEqual({ ok: true })
    expect(calls.map(operation)).toEqual(['status', 'rev-parse'])
  })

  it('refuses when fetch fails', async () => {
    const calls: Call[] = []
    const result = await convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, (call) =>
          operation(call) === 'fetch' ? { status: 1, stdout: '' } : { status: 0, stdout: '' },
        ),
      },
    )

    expect(result).toEqual({ ok: false, reason: 'fetch-failed' })
    expect(calls.map(operation)).toEqual(['status', 'rev-parse', 'fetch'])
  })

  it('refuses when checkout fails', async () => {
    const calls: Call[] = []
    const result = await convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, (call) =>
          operation(call) === 'checkout' ? { status: 1, stdout: '' } : { status: 0, stdout: '' },
        ),
      },
    )

    expect(result).toEqual({ ok: false, reason: 'checkout-failed' })
    expect(calls.map(operation)).toEqual(['status', 'rev-parse', 'fetch', 'checkout'])
  })

  it('converges a clean checkout', async () => {
    const calls: Call[] = []
    const result = await convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, () => ({ status: 0, stdout: '' })),
      },
    )

    expect(result).toEqual({ ok: true })
  })

  it('names a killed step as a timeout rather than blaming the command', async () => {
    const calls: Call[] = []
    const result = await convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, (call) =>
          operation(call) === 'fetch'
            ? { status: GIT_TIMED_OUT_STATUS, stdout: '' }
            : { status: 0, stdout: '' },
        ),
      },
    )

    expect(result).toEqual({ ok: false, reason: 'timed-out' })
    expect(calls.map(operation)).toEqual(['status', 'rev-parse', 'fetch'])
  })

  /**
   * A superseded convergence and one that gave up on an unreachable remote both
   * stop here, but they are opposite facts: the first is a healthy hand-off to a
   * newer grant, the second is a failure against the remote. Reporting a
   * hand-off as `timed-out` would send an operator hunting a network problem
   * that never existed.
   */
  it('names a cancelled step distinctly from one the budget killed', async () => {
    const calls: Call[] = []
    const result = await convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, (call) =>
          operation(call) === 'fetch'
            ? { status: GIT_ABORTED_STATUS, stdout: '' }
            : { status: 0, stdout: '' },
        ),
      },
    )

    expect(result).toEqual({ ok: false, reason: 'cancelled' })
    expect(calls.map(operation)).toEqual(['status', 'rev-parse', 'fetch'])
  })

  /**
   * The property the whole of POD-2046 exists to establish: the daemon's only
   * thread stays free while a step is in flight. Asserted here on the sequence
   * itself, and on the real subprocess runner in
   * `apps/daemon/src/git-runner.test.ts`.
   */
  it('returns to its caller before its first step has finished', async () => {
    let finished = 0
    const pending = convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
          finished += 1
          return { status: 0, stdout: '' }
        },
      },
    )

    // Control is back with the convergence still in flight, which is the whole
    // point: the daemon's thread is free. A synchronous implementation could
    // not reach this line until all four steps had already run.
    expect(finished).toBe(0)
    expect(await pending).toEqual({ ok: true })
    expect(finished).toBe(4)
  })
})

/**
 * Git delivery runs four steps, so a per-step bound does not bound the
 * sequence. The whole convergence must fail before the server's silence
 * deadline, or the server can age the grant out and re-grant while this daemon
 * is still working on the previous one.
 */
describe('withGitBudget', () => {
  it('spends one budget across every step of a convergence', async () => {
    let clock = 0
    const seen: (number | undefined)[] = []
    const run = withGitBudget(
      async (_cmd, _args, timeoutMs) => {
        seen.push(timeoutMs)
        clock += 2 * 60_000
        return { status: 0, stdout: '' }
      },
      { totalMs: 8 * 60_000, now: () => clock },
    )

    const result = await convergeViaGit({ repo: '/checkout', sha: 'abc1234' }, { run })

    // Each step is granted only what the previous ones left behind.
    expect(seen).toEqual([8 * 60_000, 6 * 60_000, 4 * 60_000, 2 * 60_000])
    expect(result).toEqual({ ok: true })
  })

  it('refuses to start a step once the budget is gone, instead of adding to it', async () => {
    let clock = 0
    let started = 0
    const run = withGitBudget(
      async () => {
        started += 1
        clock += 5 * 60_000
        return { status: 0, stdout: '' }
      },
      { totalMs: 8 * 60_000, now: () => clock },
    )

    const result = await convergeViaGit({ repo: '/checkout', sha: 'abc1234' }, { run })

    expect(result).toEqual({ ok: false, reason: 'timed-out' })
    // Two steps ran (10 minutes); the third never started, so the sequence
    // cannot run past the deadline by simply having more steps.
    expect(started).toBe(2)
  })
})
