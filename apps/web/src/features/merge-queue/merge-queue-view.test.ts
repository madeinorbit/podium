import { MobxPool } from '@podium/client-graph'
import { LOCK_POLL_MS } from '@podium/client-core/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MergeQueueView } from './merge-queue-view'

let pool: MobxPool
let visibility = 'visible'
const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
})
afterEach(() => {
  pool.dispose()
  vi.useRealTimers()
  if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor)
  else Reflect.deleteProperty(document, 'visibilityState')
})
function view(query: ReturnType<typeof vi.fn>): MergeQueueView {
  return new MergeQueueView(pool, { repoPath: '/repo' }, { lock: { status: { query } } } as never)
}
it('serializes lock reads, pauses while hidden and resumes on visibility', async () => {
  let resolve!: (rows: never[]) => void
  const query = vi.fn(
    () =>
      new Promise<never[]>((r) => {
        resolve = r
      }),
  )
  const model = view(query)
  try {
    model.open()
    model.refresh()
    await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 2)
    expect(query).toHaveBeenCalledTimes(1)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    resolve([])
    await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 2)
    expect(query).toHaveBeenCalledTimes(1)
    expect(model.answer).toEqual([])
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(query).toHaveBeenCalledTimes(2)
    resolve([])
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(LOCK_POLL_MS)
    expect(query).toHaveBeenCalledTimes(3)
  } finally {
    model.close()
  }
})
it('keeps the last reading and warning on refresh failure and releases it on close', async () => {
  const query = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('offline'))
  const model = view(query)
  model.open()
  await vi.advanceTimersByTimeAsync(0)
  model.refresh()
  await vi.advanceTimersByTimeAsync(0)
  expect(model.state).toEqual({ status: 'ready', locks: [], refreshing: false, warning: 'offline' })
  model.close()
  expect(model.answer).toBeUndefined()
  expect(model.error).toBeNull()
  await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 2)
  expect(query).toHaveBeenCalledTimes(2)
})
it('starts no hidden read and ignores an in-flight reading after close', async () => {
  visibility = 'hidden'
  let resolve!: (rows: never[]) => void
  const query = vi.fn(
    () =>
      new Promise<never[]>((r) => {
        resolve = r
      }),
  )
  const model = view(query)
  model.open()
  expect(query).not.toHaveBeenCalled()
  visibility = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  expect(query).toHaveBeenCalledOnce()
  model.close()
  resolve([])
  await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 2)
  expect(model.answer).toBeUndefined()
  expect(query).toHaveBeenCalledOnce()
})
