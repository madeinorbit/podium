import type { ContextDetailResult } from '@podium/model'
import type { ContextReadResult } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ContextDetailApi, ContextDetailView } from './context-detail'
import { contextSample, sessionContextFixture } from './session-context.test.fixture'

const releases: (() => void)[] = []
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release()
  vi.useRealTimers()
})
function fixture() {
  const f = sessionContextFixture()
  f.publish(contextSample)
  const detail: ContextDetailResult = {
    version: 1,
    status: 'available',
    sample: contextSample.sample,
    lastRequest: { input: { value: 20, accuracy: 'reported', source: 'invented adapter' } },
  }
  let complete!: (answer: ContextReadResult) => void
  const query = vi.fn<ContextDetailApi['sessions']['contextRead']['query']>(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const view = new ContextDetailView(f.model, { sessions: { contextRead: { query } } })
  releases.push(
    () => f.pool.dispose(),
    () => view.close(),
  )
  return {
    ...f,
    view,
    query,
    detail,
    complete: (answer: ContextReadResult = { intent: 'breakdown', result: detail }) =>
      complete(answer),
  }
}

describe('view-owned context detail request lifetime', () => {
  it.each([
    'NOT_FOUND',
    'UNAUTHORIZED',
    'FORBIDDEN',
  ] as const)('settles %s transport refusals explicitly without retrying', async (code) => {
    const f = fixture()
    f.query.mockRejectedValueOnce({ data: { code } })
    f.view.open()
    await f.view.load()
    expect(f.view.answer?.status).toBe(code === 'NOT_FOUND' ? 'unsupported' : 'refused')
    expect(f.view.error?.code).toBe(code === 'NOT_FOUND' ? 'unsupported-peer' : 'unauthorized')
    await f.view.load()
    expect(f.query).toHaveBeenCalledOnce()
    expect(f.model.context).toEqual(contextSample)
  })
  it('keeps construction, reads, render-like opens and hidden loads free of probes', async () => {
    const f = fixture()
    expect(f.view.answer).toBeUndefined()
    expect(f.view.loading).toBe(false)
    await f.view.load()
    f.view.open()
    f.view.open()
    expect(f.view.answer).toBeUndefined()
    expect(f.view.error).toBeUndefined()
    expect(f.query).not.toHaveBeenCalled()
  })
  it('coalesces repeated intents and retains the answer only for the opening', async () => {
    const f = fixture()
    f.view.open()
    const a = f.view.load()
    const b = f.view.load()
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledOnce())
    expect(f.view.loading).toBe(true)
    f.complete()
    await Promise.all([a, b])
    expect(f.view.answer).toEqual(f.detail)
    expect(f.view.loading).toBe(false)
    await f.view.load()
    expect(f.query).toHaveBeenCalledOnce()
    f.view.close()
    expect(f.view.answer).toBeUndefined()
    expect(f.view.error).toBeUndefined()
    f.view.open()
    const next = f.view.load()
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(2))
    f.complete()
    await next
  })
  it('releases its waiter/listener on hide even if the transport ignores abort', async () => {
    const f = fixture()
    f.view.open()
    const request = f.view.load()
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledOnce())
    const signal = f.query.mock.calls[0]?.[1]?.signal
    f.view.close()
    await request
    expect(signal?.aborted).toBe(true)
    expect(f.view.answer).toBeUndefined()
    expect(f.view.loading).toBe(false)
    f.complete()
    await Promise.resolve()
    f.publish({ ...contextSample, sample: { ...contextSample.sample, id: 'new-hidden-sample' } })
    expect(f.query).toHaveBeenCalledOnce()
  })
  it.each([
    'sample',
    'model',
    'reset',
    'rebind',
    'offline',
  ] as const)('fences a late result on %s without a refresh loop', async (boundary) => {
    const f = fixture()
    f.view.open()
    const request = f.view.load()
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledOnce())
    if (boundary === 'sample')
      f.publish({ ...contextSample, sample: { ...contextSample.sample, id: 'new-sample' } })
    if (boundary === 'model')
      f.publish({ ...contextSample, model: { modelId: 'new-effective-model' } })
    if (boundary === 'reset')
      f.publish({
        version: 1,
        status: 'pending',
        revision: { ...contextSample.sample, contextRevision: 2 },
        reason: { code: 'reset', message: 'Context reset' },
      })
    if (boundary === 'rebind') f.updateSession({ driverId: 'headless' })
    if (boundary === 'offline') f.live.online('m1', false)
    await request
    expect(f.query.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    f.complete()
    await Promise.resolve()
    expect(f.view.answer).toBeUndefined()
    expect(f.view.loading).toBe(false)
    expect(f.query).toHaveBeenCalledOnce()
  })
  it('preserves observed identity across requested model changes', async () => {
    const f = fixture()
    f.view.open()
    const request = f.view.load()
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledOnce())
    f.updateSession({ requestedModel: 'different-requested-model' })
    expect(f.query.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    f.complete()
    await request
    expect(f.view.answer?.sample).toEqual(contextSample.sample)
  })
  it('retains summary on failure and retries only through the deliberate retry action', async () => {
    const f = fixture()
    f.view.open()
    const request = f.view.load()
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledOnce())
    f.complete({
      intent: 'breakdown',
      result: {
        version: 1,
        status: 'unavailable',
        sample: contextSample.sample,
        reason: { code: 'disconnected', message: 'Daemon disconnected' },
      },
    })
    await request
    expect(f.view.error?.code).toBe('disconnected')
    expect(f.model.context).toEqual(contextSample)
    await f.view.load()
    f.view.open()
    expect(f.query).toHaveBeenCalledOnce()
    const retry = f.view.retry()
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(2))
    f.complete()
    await retry
    expect(f.view.error).toBeUndefined()
    expect(f.view.answer).toEqual(f.detail)
  })
  it('settles local deadline without depending on transport completion', async () => {
    const f = fixture()
    f.view.open()
    vi.useFakeTimers()
    const request = f.view.load({ timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    await request
    expect(f.view.error?.code).toBe('timed-out')
    expect(f.view.loading).toBe(false)
    expect(f.query.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(f.model.context).toEqual(contextSample)
  })
})
