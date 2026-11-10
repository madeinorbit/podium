import type { MobileClientSession } from '@podium/protocol'
import { expect, it, vi } from 'vitest'
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
