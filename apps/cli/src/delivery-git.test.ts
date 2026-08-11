import { describe, expect, it } from 'vitest'
import {
  convergeViaGit,
  GIT_TIMED_OUT_STATUS,
  withGitBudget,
} from '@podium/runtime/update-delivery-git'

type Call = { cmd: string; args: string[] }

function runner(
  calls: Call[],
  response: (call: Call) => { status: number | null; stdout: string },
): (cmd: string, args: string[]) => { status: number | null; stdout: string } {
  return (cmd, args) => {
    const call = { cmd, args }
    calls.push(call)
    return response(call)
  }
}

function operation(call: Call): string | undefined {
  return call.args.find((arg) => arg === 'status' || arg === 'fetch' || arg === 'checkout')
}

describe('convergeViaGit', () => {
  it('refuses a dirty checkout before fetching or checking out', () => {
    const calls: Call[] = []
    const result = convergeViaGit(
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

  it('does not use destructive cleanup or reset commands', () => {
    const calls: Call[] = []
    const result = convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, () => ({ status: 0, stdout: '' })),
      },
    )

    expect(result).toEqual({ ok: true })
    const command = calls.flatMap(({ cmd, args }) => [cmd, ...args]).join(' ')
    expect(command).not.toMatch(/\b(reset|clean)\b|--hard|--force/)
  })

  it('fetches before checking out the requested revision', () => {
    const calls: Call[] = []
    const result = convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, () => ({ status: 0, stdout: '' })),
      },
    )

    expect(result).toEqual({ ok: true })
    expect(calls.map(operation)).toEqual(['status', 'fetch', 'checkout'])
  })

  it('refuses when fetch fails', () => {
    const calls: Call[] = []
    const result = convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, (call) =>
          operation(call) === 'fetch' ? { status: 1, stdout: '' } : { status: 0, stdout: '' },
        ),
      },
    )

    expect(result).toEqual({ ok: false, reason: 'fetch-failed' })
    expect(calls.map(operation)).toEqual(['status', 'fetch'])
  })

  it('refuses when checkout fails', () => {
    const calls: Call[] = []
    const result = convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, (call) =>
          operation(call) === 'checkout' ? { status: 1, stdout: '' } : { status: 0, stdout: '' },
        ),
      },
    )

    expect(result).toEqual({ ok: false, reason: 'checkout-failed' })
    expect(calls.map(operation)).toEqual(['status', 'fetch', 'checkout'])
  })

  it('converges a clean checkout', () => {
    const calls: Call[] = []
    const result = convergeViaGit(
      { repo: '/checkout', sha: 'abc1234' },
      {
        run: runner(calls, () => ({ status: 0, stdout: '' })),
      },
    )

    expect(result).toEqual({ ok: true })
  })

  it('names a killed step as a timeout rather than blaming the command', () => {
    const calls: Call[] = []
    const result = convergeViaGit(
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
    expect(calls.map(operation)).toEqual(['status', 'fetch'])
  })
})

/**
 * Git delivery is synchronous and runs three steps, so a per-step bound does
 * not bound the sequence. The whole convergence must fail before the server's
 * silence deadline, or the server can age the grant out and re-grant while this
 * daemon is still blocked and unable to observe cancellation.
 */
describe('withGitBudget', () => {
  it('spends one budget across every step of a convergence', () => {
    let clock = 0
    const seen: (number | undefined)[] = []
    const run = withGitBudget(
      (_cmd, _args, timeoutMs) => {
        seen.push(timeoutMs)
        clock += 3 * 60_000
        return { status: 0, stdout: '' }
      },
      { totalMs: 8 * 60_000, now: () => clock },
    )

    const result = convergeViaGit({ repo: '/checkout', sha: 'abc1234' }, { run })

    // Each step is granted only what the previous ones left behind.
    expect(seen).toEqual([8 * 60_000, 5 * 60_000, 2 * 60_000])
    expect(result).toEqual({ ok: true })
  })

  it('refuses to start a step once the budget is gone, instead of adding to it', () => {
    let clock = 0
    let started = 0
    const run = withGitBudget(
      () => {
        started += 1
        clock += 5 * 60_000
        return { status: 0, stdout: '' }
      },
      { totalMs: 8 * 60_000, now: () => clock },
    )

    const result = convergeViaGit({ repo: '/checkout', sha: 'abc1234' }, { run })

    expect(result).toEqual({ ok: false, reason: 'timed-out' })
    // Two steps ran (10 minutes); the third never started, so the sequence
    // cannot run past the deadline by simply having more steps.
    expect(started).toBe(2)
  })
})
