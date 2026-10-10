import { asSessionId, type SessionMeta } from '@podium/model'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentConcurrencyHistoryResult, PodiumClientApi } from '../api'
import type { ReplicaAddressedBatch } from '../replica/contract'
import { createHeaderPollingService } from './header-polling'

function fixture() {
  const quota = vi.fn(async () => [])
  const lifecycle = vi.fn(
    async () => ({}) as Awaited<ReturnType<PodiumClientApi['settings']['get']['query']>>,
  )
  const reading: AgentConcurrencyHistoryResult = {
    sampledAt: '2026-10-05T00:00:00Z',
    bucketMs: 60_000,
    peak: 0,
    buckets: Array.from({ length: 24 }, () => ({ start: '2026-10-05T00:00:00Z', count: 0 })),
  }
  const history = vi.fn(async () => reading)
  const api = {
    quota: { summary: { query: quota } },
    settings: { get: { query: lifecycle } },
    sessions: { concurrencyHistory: { query: history } },
  } as unknown as PodiumClientApi
  const sessions = new Map<string, SessionMeta>()
  let listener: ((batch: ReplicaAddressedBatch) => void) | undefined
  const rows = vi.fn(() => [...sessions.values()])
  const row = vi.fn((_kind: string, id: string) => sessions.get(id))
  const off = vi.fn(() => {
    listener = undefined
  })
  const reportError = vi.fn()
  const service = createHeaderPollingService({
    api,
    reportError,
    replica: {
      rows: rows as never,
      row: row as never,
      subscribeAddressedBatch(next) {
        listener = next
        return off
      },
    },
  })
  return {
    service,
    quota,
    lifecycle,
    history,
    reading,
    api,
    reportError,
    sessions,
    rows,
    row,
    off,
    emit: (batch: ReplicaAddressedBatch) => listener?.(batch),
  }
}
const services: ReturnType<typeof createHeaderPollingService>[] = []
function start() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-05T00:00:00Z'))
  const f = fixture()
  f.service.inputs.retain()
  services.push(f.service)
  return f
}
afterEach(() => {
  for (const service of services.splice(0)) service.destroy()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const flush = async () => {
  for (let turn = 0; turn < 4; turn++) await Promise.resolve()
}

it('owns one poll schedule, feeds only changed keys, and retains the one-shot lifecycle on restart', async () => {
  const f = start()
  const quota = vi.fn(),
    history = vi.fn(),
    lifecycle = vi.fn()
  f.service.inputs.onInput('quota', quota)
  f.service.inputs.onInput('history', history)
  f.service.inputs.onInput('lifecycle', lifecycle)
  expect(f.quota).not.toHaveBeenCalled()
  f.service.start()
  f.service.start()
  await flush()
  expect([quota.mock.calls.length, history.mock.calls.length, lifecycle.mock.calls.length]).toEqual(
    [1, 1, 1],
  )
  await vi.advanceTimersByTimeAsync(60_000)
  expect([quota.mock.calls.length, history.mock.calls.length, lifecycle.mock.calls.length]).toEqual(
    [2, 1, 1],
  )
  await vi.advanceTimersByTimeAsync(4 * 60_000)
  expect(f.history).toHaveBeenCalledTimes(2)
  expect(f.lifecycle).toHaveBeenCalledTimes(1)
  f.service.stop()
  expect(f.off).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(f.history).toHaveBeenCalledTimes(2)
  f.service.start()
  await flush()
  expect(f.lifecycle).toHaveBeenCalledTimes(1)
  expect(f.history).toHaveBeenCalledTimes(3)
  expect(f.service.inputs.read('history')).toBe(f.reading)
})

it('counts errors, reports each failing key once, retains successful samples and retries independently', async () => {
  const f = start()
  const before = [{ machineId: 'before' }],
    after = [{ machineId: 'after' }]
  const error = new Error('unavailable')
  f.quota
    .mockResolvedValueOnce(before as never)
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error)
    .mockResolvedValue(after as never)
  f.history.mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockResolvedValue(f.reading)
  f.lifecycle.mockRejectedValueOnce(error)
  f.service.start()
  await flush()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(f.service.inputs.read('quota')).toBe(before)
  expect(f.service.diagnostics.counts).toEqual({ quota: 2, history: 1, lifecycle: 1 })
  expect(f.lifecycle).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.service.inputs.read('quota')).toBe(after)
  await vi.advanceTimersByTimeAsync(7 * 60_000)
  expect(f.service.inputs.read('history')).toBe(f.reading)
  expect(f.service.diagnostics.errors).toBe(5)
  expect(f.reportError.mock.calls).toEqual([
    ['lifecycle', error],
    ['history', error],
    ['quota', error],
  ])
})

it('coalesces in-flight polls and rejects old-generation success and failure after restart', async () => {
  const f = start()
  let resolve!: (rows: never[]) => void, reject!: (error: Error) => void
  f.quota.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    }),
  )
  f.history.mockReturnValueOnce(
    new Promise((_done, fail) => {
      reject = fail
    }),
  )
  const changed = vi.fn()
  f.service.inputs.onInput('quota', changed)
  f.service.start()
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(f.quota).toHaveBeenCalledTimes(1)
  expect(f.history).toHaveBeenCalledTimes(1)
  f.service.stop()
  f.service.start()
  await flush()
  const current = f.service.inputs.read('quota')
  resolve([{ machineId: 'old' }] as never)
  reject(new Error('old failure'))
  await flush()
  expect(f.service.inputs.read('quota')).toBe(current)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(f.service.diagnostics.errors).toBe(0)
  expect(f.reportError).not.toHaveBeenCalled()
})

it('refreshes history on addressed computing-count changes, expiry and rescope without scanning on deltas', async () => {
  const f = start()
  f.service.start()
  await flush()
  f.rows.mockClear()
  const active = {
    sessionId: asSessionId('s'),
    status: 'live',
    lastActiveAt: new Date().toISOString(),
    agentState: { phase: 'working', since: new Date().toISOString() },
  } as SessionMeta
  f.sessions.set('s', active)
  f.emit({ type: 'update', rows: [{ kind: 'sessions', id: 's' }] })
  await flush()
  expect(f.history).toHaveBeenCalledTimes(2)
  f.row.mockClear()
  f.emit({ type: 'update', rows: [{ kind: 'issueProjections', id: 'i' }] })
  expect(f.row).not.toHaveBeenCalled()
  f.sessions.set('s', { ...active, title: 'renamed' })
  f.emit({ type: 'update', rows: [{ kind: 'sessions', id: 's' }] })
  await flush()
  expect(f.history).toHaveBeenCalledTimes(2)
  expect(f.rows).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(15 * 60_000 + 1)
  expect(f.history).toHaveBeenCalledTimes(6) // three cadence polls, then one expiry
  f.sessions.set('s', { ...active, lastActiveAt: new Date().toISOString() })
  f.emit({ type: 'replace', reason: 'rescope' })
  await flush()
  expect(f.history).toHaveBeenCalledTimes(7)
  expect(f.rows).toHaveBeenCalledTimes(1)
  f.sessions.clear()
  f.emit({ type: 'update', rows: [{ kind: 'sessions', id: 's' }] })
  await flush()
  expect(f.history).toHaveBeenCalledTimes(8)
})

it('accepts an absent history endpoint, ignores malformed readings, and destroys principal samples', async () => {
  const f = start()
  delete f.api.sessions.concurrencyHistory
  f.service.start()
  await flush()
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(f.history).not.toHaveBeenCalled()
  f.service.stop()
  const sessionsApi = f.api.sessions
  f.api.sessions = undefined as never
  f.service.start()
  await flush()
  expect(f.service.diagnostics.errors).toBe(0)
  f.service.stop()
  f.api.sessions = sessionsApi
  f.api.sessions.concurrencyHistory = { query: f.history }
  f.history.mockResolvedValueOnce({ ...f.reading, peak: -1 })
  f.service.start()
  await flush()
  expect(f.service.inputs.read('history')).toBeUndefined()
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(f.service.inputs.read('history')).toBe(f.reading)
  f.service.destroy()
  expect(f.service.inputs.read('history')).toBeUndefined()
  expect(f.service.inputs.read('quota')).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
  const calls = f.quota.mock.calls.length
  f.service.start()
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(f.quota).toHaveBeenCalledTimes(calls)
})

it('does no polling without a visible mounted header and resumes on reveal', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-05T00:00:00Z'))
  const doc = new EventTarget()
  let visibility = 'visible'
  Object.defineProperty(doc, 'visibilityState', { get: () => visibility })
  vi.stubGlobal('document', doc)
  const f = fixture(); services.push(f.service)
  f.service.start()
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(f.quota).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  const release = f.service.inputs.retain()
  await flush()
  expect(f.quota).toHaveBeenCalledTimes(1)
  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.quota).toHaveBeenCalledTimes(1)
  visibility = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  expect(f.quota).toHaveBeenCalledTimes(2)
  release()
  expect(vi.getTimerCount()).toBe(0)
})


it('renews addressed working evidence without clearing or rearming its timer', async () => {
  const f = start()
  f.service.start()
  await flush()
  const original = Date.now()
  const active = {
    sessionId: asSessionId('renewed'), status: 'live',
    lastActiveAt: new Date(original).toISOString(),
    agentState: { phase: 'working', since: new Date(original).toISOString() },
  } as SessionMeta
  f.sessions.set('renewed', active)
  f.emit({ type: 'update', rows: [{ kind: 'sessions', id: 'renewed' }] })
  await flush()
  await vi.advanceTimersByTimeAsync(1_000)
  f.rows.mockClear()
  const arm = vi.spyOn(globalThis, 'setTimeout')
  const cancel = vi.spyOn(globalThis, 'clearTimeout')
  f.sessions.set('renewed', { ...active, lastActiveAt: new Date().toISOString() })
  f.emit({ type: 'update', rows: [{ kind: 'sessions', id: 'renewed' }] })
  await flush()
  expect(arm).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
  arm.mockRestore(); cancel.mockRestore()
  await vi.advanceTimersByTimeAsync(15 * 60_000 + 1 - 1_000)
  expect(f.history).toHaveBeenCalledTimes(5) // bootstrap, membership, three cadence polls
  await vi.advanceTimersByTimeAsync(1_000)
  expect(f.history).toHaveBeenCalledTimes(6) // latest evidence expires, one addressed refresh
  expect(f.rows).not.toHaveBeenCalled()
})
