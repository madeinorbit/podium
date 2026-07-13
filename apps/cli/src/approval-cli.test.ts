import { describe, expect, it, vi } from 'vitest'
import { APPROVAL_WAIT_MS, requestApproval } from './approval-cli'

/** A relay stub: `request` files apr_1; `get` walks the scripted status sequence. */
function relay(statuses: Array<{ status: string; resultText?: string }>) {
  let i = 0
  const calls: string[] = []
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { proc } = JSON.parse(init.body) as { proc: string }
    calls.push(proc)
    if (proc === 'request') {
      return {
        ok: true,
        json: async () => ({ ok: true, result: { id: 'apr_1', status: 'pending' } }),
      }
    }
    const s = statuses[Math.min(i++, statuses.length - 1)]!
    return {
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          id: 'apr_1',
          op: { kind: 'update' },
          status: s.status,
          resultText: s.resultText ?? null,
        },
      }),
    }
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const opts = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => ({
  fetchImpl,
  announce: () => {},
  sleep: async () => {},
  ...extra,
})

describe('requestApproval blocks until the operator decides (#410)', () => {
  it('waits through pending/executing, then prints the real output and exits 0', async () => {
    const { fetchImpl, calls } = relay([
      { status: 'pending' },
      { status: 'executing' },
      { status: 'succeeded', resultText: 'updated 0.1.0 -> 0.1.1' },
    ])
    const out = await requestApproval('http://relay', { kind: 'update' }, opts(fetchImpl))
    expect(out).toEqual({ text: 'updated 0.1.0 -> 0.1.1', exitCode: 0 })
    expect(calls.filter((c) => c === 'get')).toHaveLength(3) // it really polled
  })

  it('denied → non-zero exit, so `podium update && x` does not run x', async () => {
    const { fetchImpl } = relay([{ status: 'denied' }])
    const out = await requestApproval('http://relay', { kind: 'update' }, opts(fetchImpl))
    expect(out.exitCode).toBe(1)
    expect(out.text).toMatch(/denied/i)
  })

  it('approved-but-failed → non-zero exit carrying the failure output', async () => {
    const { fetchImpl } = relay([{ status: 'failed', resultText: 'feed returned 404' }])
    const out = await requestApproval('http://relay', { kind: 'update' }, opts(fetchImpl))
    expect(out.exitCode).toBe(1)
    expect(out.text).toContain('feed returned 404')
  })

  it('gives up (retryable exit 75) when nobody decides — never hangs forever', async () => {
    const { fetchImpl } = relay([{ status: 'pending' }])
    let t = 0
    const out = await requestApproval(
      'http://relay',
      { kind: 'update' },
      opts(fetchImpl, {
        now: () => t,
        sleep: async () => {
          t += 60_000
        },
      }),
    )
    expect(t).toBeGreaterThanOrEqual(APPROVAL_WAIT_MS)
    expect(out.exitCode).toBe(75)
    expect(out.text).toMatch(/still awaiting approval/)
  })

  it('announces the wait as soon as the request is filed', async () => {
    const { fetchImpl } = relay([{ status: 'denied' }])
    const announce = vi.fn()
    await requestApproval('http://relay', { kind: 'update' }, opts(fetchImpl, { announce }))
    expect(announce).toHaveBeenCalledWith(expect.stringContaining("needs the operator's approval"))
  })
})
