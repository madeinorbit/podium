import { describe, expect, it, vi } from 'vitest'
import { createBoundaryContext } from './boundary-context.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('hidden boundary context', () => {
  it('primes once, rearms at compaction and on resume reset', async () => {
    const fetch = vi.fn(async () => ({ ok: true, result: 'scoped prime' }))
    const context = createBoundaryContext(fetch)
    expect(await context.respond({ event: 'start' })).toBe('scoped prime')
    expect(await context.respond({ event: 'prompt' })).toBeNull()
    expect(await context.respond({ event: 'start' })).toBeNull()
    expect(await context.respond({ event: 'before-compaction' })).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await context.respond({ event: 'prompt' })).toBe('scoped prime')
    context.reset()
    expect(await context.respond({ event: 'start' })).toBe('scoped prime')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it.each([
    { ok: false },
    { ok: true, result: '' },
    { ok: true, result: {} },
  ])('retries unsuccessful fetches: %j', async (failure) => {
    let result: { ok: boolean; result?: unknown } = failure
    const context = createBoundaryContext(async () => result)
    expect(await context.respond({ event: 'start' })).toBeNull()
    result = { ok: true, result: 'retry' }
    expect(await context.respond({ event: 'prompt' })).toBe('retry')
  })

  it('fails open on relay rejection without consuming the prime', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, result: 'online' })
    const context = createBoundaryContext(fetch)
    expect(await context.respond({ event: 'start' })).toBeNull()
    expect(await context.respond({ event: 'prompt' })).toBe('online')
  })

  it('only one concurrent hook can consume a prime', async () => {
    const pending = deferred<{ ok: boolean; result: string }>()
    const fetch = vi.fn(() => pending.promise)
    const context = createBoundaryContext(fetch)
    const first = context.respond({ event: 'start' })
    expect(await context.respond({ event: 'prompt' })).toBeNull()
    pending.resolve({ ok: true, result: 'prime' })
    expect(await first).toBe('prime')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    'cancel',
    'compact',
    'reset',
  ] as const)('fences a pending fetch after %s', async (cause) => {
    const old = deferred<{ ok: boolean; result: string }>()
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue({ ok: true, result: 'fresh' })
    const context = createBoundaryContext(fetch)
    const controller = new AbortController()
    const pending = context.respond({ event: 'start', signal: controller.signal })
    if (cause === 'cancel') controller.abort()
    else if (cause === 'compact') await context.respond({ event: 'before-compaction' })
    else context.reset()
    expect(await context.respond({ event: 'prompt' })).toBe('fresh')
    old.resolve({ ok: true, result: 'stale' })
    expect(await pending).toBeNull()
    expect(await context.respond({ event: 'prompt' })).toBeNull()
  })
})
