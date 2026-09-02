import { describe, expect, it, vi } from 'vitest'
import { PUBLIC_URL_PROBE_BACKOFF_MS, startPublicUrlProbe } from './public-url-probe'

/** A hand-driven clock. The probe only ever schedules through the injected
 *  timer, so a test advances it explicitly instead of waiting real seconds. */
function fakeTimers() {
  const queue: { fn: () => void; ms: number }[] = []
  return {
    setTimeout: (fn: () => void, ms: number) => {
      queue.push({ fn, ms })
      return queue.length - 1
    },
    clearTimeout: () => {},
    delays: () => queue.map((entry) => entry.ms),
    fire() {
      const next = queue.shift()
      if (!next) throw new Error('nothing scheduled')
      next.fn()
    },
  }
}

const readinessBody = (instanceId: string) =>
  new Response(JSON.stringify({ instanceId }), {
    headers: { 'content-type': 'application/json' },
  })

const asFetch = (fn: unknown) => fn as unknown as typeof globalThis.fetch

describe('startPublicUrlProbe', () => {
  it('does nothing when there is no public URL', () => {
    const probe = startPublicUrlProbe({ publicUrl: undefined, instanceId: 'i1' })
    expect(probe.state()).toBeUndefined()
    probe.stop()
  })

  it('marks a loopback URL ok without probing', () => {
    const fetch = vi.fn()
    const probe = startPublicUrlProbe({
      publicUrl: 'http://127.0.0.1:8080',
      instanceId: 'i1',
      fetch: asFetch(fetch),
    })
    expect(probe.state()?.ok).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    probe.stop()
  })

  it('verifies against OUR instanceId, hits /readiness, and then stops retrying', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => readinessBody('i1'))
    const timers = fakeTimers()
    const probe = startPublicUrlProbe({
      publicUrl: 'https://api.example',
      instanceId: 'i1',
      fetch: asFetch(fetch),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await vi.waitFor(() => expect(probe.state()?.ok).toBe(true))
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.example/readiness')
    expect(timers.delays()).toEqual([])
    probe.stop()
  })

  it('a DIFFERENT instanceId is a failure — something else answers that URL', async () => {
    const fetch = vi.fn(async () => readinessBody('someone-else'))
    const timers = fakeTimers()
    const probe = startPublicUrlProbe({
      publicUrl: 'https://api.example',
      instanceId: 'i1',
      fetch: asFetch(fetch),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await vi.waitFor(() => expect(probe.state()?.ok).toBe(false))
    expect(probe.state()?.error).toMatch(/another instance/i)
    expect(timers.delays()).toEqual([PUBLIC_URL_PROBE_BACKOFF_MS[0]])
    probe.stop()
  })

  it('a body with no instanceId is a failure, not a pass', async () => {
    const fetch = vi.fn(
      async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    )
    const timers = fakeTimers()
    const probe = startPublicUrlProbe({
      publicUrl: 'https://api.example',
      instanceId: 'i1',
      fetch: asFetch(fetch),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await vi.waitFor(() => expect(probe.state()?.ok).toBe(false))
    expect(probe.state()?.error).toMatch(/did not identify a Podium instance/)
    probe.stop()
  })

  it('retries on the declared backoff, and the last delay repeats forever', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const timers = fakeTimers()
    const probe = startPublicUrlProbe({
      publicUrl: 'https://api.example',
      instanceId: 'i1',
      fetch: asFetch(fetch),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await vi.waitFor(() => expect(timers.delays()).toEqual([PUBLIC_URL_PROBE_BACKOFF_MS[0]]))
    const seen: number[] = [...timers.delays()]
    for (let i = 1; i <= PUBLIC_URL_PROBE_BACKOFF_MS.length; i++) {
      timers.fire()
      await vi.waitFor(() => expect(timers.delays().length).toBe(1))
      seen.push(timers.delays()[0] as number)
    }
    expect(seen).toEqual([...PUBLIC_URL_PROBE_BACKOFF_MS, PUBLIC_URL_PROBE_BACKOFF_MS.at(-1)])
    probe.stop()
  })

  it('a failure then a success settles ok and stops retrying', async () => {
    let attempt = 0
    const fetch = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('timeout')
      return readinessBody('i1')
    })
    const timers = fakeTimers()
    const probe = startPublicUrlProbe({
      publicUrl: 'https://api.example',
      instanceId: 'i1',
      fetch: asFetch(fetch),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await vi.waitFor(() => expect(probe.state()?.ok).toBe(false))
    timers.fire()
    await vi.waitFor(() => expect(probe.state()?.ok).toBe(true))
    expect(timers.delays()).toEqual([])
    probe.stop()
  })

  it('stop() prevents any further scheduling', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const timers = fakeTimers()
    const probe = startPublicUrlProbe({
      publicUrl: 'https://api.example',
      instanceId: 'i1',
      fetch: asFetch(fetch),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await vi.waitFor(() => expect(timers.delays().length).toBe(1))
    probe.stop()
    timers.fire()
    await vi.waitFor(() => expect(timers.delays()).toEqual([]))
  })
})
