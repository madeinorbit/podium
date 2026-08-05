import { describe, expect, it } from 'vitest'
import { convergeViaGit } from '@podium/runtime/update-delivery-git'

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
})
