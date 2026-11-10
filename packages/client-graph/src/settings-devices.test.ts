import type { MobileClientSession } from '@podium/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { SettingsDevices } from './settings-devices'

const device = (sessionId: string, current = false): MobileClientSession => ({
  sessionId,
  userId: 'user:one',
  label: 'mobile',
  deviceId: sessionId,
  deviceName: sessionId,
  platform: 'ios',
  current,
  createdAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
  lastSeenAt: '2026-08-31T00:00:00.000Z',
})
function fixture() {
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  const devices = new SettingsDevices(pool)
  return { pool, devices }
}
it('shares pending inventory and the settled answer across Settings routes', async () => {
  const { pool, devices } = fixture()
  let resolve!: (rows: MobileClientSession[]) => void
  const read = vi.fn(
    () =>
      new Promise<MobileClientSession[]>((done) => {
        resolve = done
      }),
  )
  const home = devices.ensure(read)
  expect(devices.ensure(read)).toBe(home)
  expect(devices.refresh(read)).toBe(home)
  expect(read).toHaveBeenCalledTimes(1)
  resolve([device('other'), device('this', true)])
  await home
  await devices.ensure(read)
  expect(read).toHaveBeenCalledTimes(1)
  expect(devices.orderedModels.map((row) => row.sessionId)).toEqual(['this', 'other'])
  expect(devices.orderedModels[0]).toBe(pool.model('device', 'this'))
  const refreshed = devices.refresh(read)
  expect(read).toHaveBeenCalledTimes(2)
  resolve([device('this', true)])
  await refreshed
  expect(devices.orderedModels.map((row) => row.sessionId)).toEqual(['this'])
  pool.dispose()
})
it('fences closed openings before ingestion while a new opening can load', async () => {
  const { pool, devices } = fixture()
  let resolve!: (rows: MobileClientSession[]) => void
  const stale = devices.ensure(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  devices.dispose()
  const next = new SettingsDevices(pool)
  await next.ensure(async () => [device('new')])
  resolve([device('stale')])
  await stale
  expect(devices.answer).toBeUndefined()
  expect(next.answer).toEqual(['new'])
  expect(pool.row('device', 'new')).toMatchObject({ sessionId: 'new' })
  expect(pool.row('device', 'stale')).not.toMatchObject({ sessionId: 'stale' })
  pool.dispose()
})
it('allows a failed opening to retry', async () => {
  const { pool, devices } = fixture()
  await devices.ensure(async () => {
    throw new Error('offline')
  })
  expect(devices.error).toBe('offline')
  await devices.ensure(async () => [device('retry')])
  expect(devices.answer).toEqual(['retry'])
  expect(devices.error).toBeNull()
  pool.dispose()
})

afterEach(() => vi.useRealTimers())
it('refreshes an expired focus answer once, keeps fresh returns, and joins concurrent routes', async () => {
  vi.useFakeTimers()
  const { pool, devices } = fixture()
  const first = vi.fn(async () => [device('first')])
  await devices.ensure(first, 15_000)
  vi.advanceTimersByTime(14_999)
  await devices.ensure(first, 15_000)
  expect(first).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(1)
  let resolve!: (rows: MobileClientSession[]) => void
  const read = vi.fn(
    () =>
      new Promise<MobileClientSession[]>((done) => {
        resolve = done
      }),
  )
  const refresh = devices.ensure(read, 15_000)
  expect(devices.ensure(read, 15_000)).toBe(refresh)
  expect(devices.refresh(read)).toBe(refresh)
  expect(read).toHaveBeenCalledTimes(1)
  expect(devices.answer).toEqual(['first'])
  resolve([device('next')])
  await refresh
  await devices.ensure(read, 15_000)
  expect(read).toHaveBeenCalledTimes(1)
  expect(devices.answer).toEqual(['next'])
  pool.dispose()
})

it('does not freshen an old answer when refresh fails', async () => {
  vi.useFakeTimers()
  const { pool, devices } = fixture()
  await devices.ensure(async () => [device('old')], 15_000)
  vi.advanceTimersByTime(15_000)
  await devices.ensure(async () => {
    throw new Error('offline')
  }, 15_000)
  expect(devices.answer).toEqual(['old'])
  const retry = vi.fn(async () => [device('retry')])
  await devices.ensure(retry, 15_000)
  expect(retry).toHaveBeenCalledOnce()
  expect(devices.answer).toEqual(['retry'])
  pool.dispose()
})
