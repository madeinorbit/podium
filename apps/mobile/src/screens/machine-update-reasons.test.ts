import '@podium/client-graph/synced-models'
import { visibleFleetOperations } from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph'
import { seedFixtureMachines } from '@podium/client-graph/live-fixture'
import { asMachineId } from '@podium/model'
import { act, cleanup, renderHook } from '@testing-library/react'
import { autorun } from 'mobx'
import { useEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MachineUpdateReasons, useMachineUpdateReasons } from './machine-update-reasons'
import { createSettingsMachineReaders } from './settings-machine-readers'

const request = vi.hoisted(() => ({
  list: vi.fn(),
  refresh: undefined as (() => void) | undefined,
  stop: vi.fn(),
}))
const api = { machines: { list: { query: request.list } } }
vi.mock('../client/hooks', () => ({ useTrpc: () => api }))
vi.mock('../client/demoData', () => ({ demoEnabled: () => false }))
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
}))
vi.mock('../client/visible-request', () => ({
  followPhoneRequest: (load: () => void) => {
    request.refresh = load
    load()
    return request.stop
  },
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('refreshes target explanations for both Pulse and Settings without changing the stored machine', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const host = {
    id: asMachineId('host'),
    name: 'Host',
    online: true,
    appVersion: '0.4.8',
    versionState: 'unknown' as const,
  }
  pool.apply({ type: 'replace', rows: seedFixtureMachines(pool, [host]) })
  const before = pool.row('machine', host.id)
  const reasons = new MachineUpdateReasons()
  const settings = createSettingsMachineReaders(pool, () => reasons.answer)
  const labels: unknown[] = []
  const stop = autorun(() => labels.push(settings.status(host.id)?.updateLabel))
  try {
    expect(labels.at(-1)).toBe('0.4.8')
    await reasons.read(async () => [
      { id: host.id, targetUnavailableReason: 'No release for this platform' },
    ])
    expect(labels.at(-1)).toBe('0.4.8 · target unavailable')
    expect(
      visibleFleetOperations({
        machines: [host],
        hosts: [],
        targetUnavailableReasons: reasons.answer,
      }).machines[0]?.updateLabel,
    ).toBe(labels.at(-1))
    expect(pool.row('machine', host.id)).toBe(before)
    expect(before).not.toHaveProperty('targetUnavailableReason')
    await reasons.read(async () => [{ id: host.id, targetUnavailableReason: null }])
    expect(labels.at(-1)).toBe('0.4.8')
  } finally {
    stop()
    settings.dispose()
    reasons.close()
    pool.dispose()
  }
})

it('asks while focused, refreshes on visibility demand and drops the answer on close', async () => {
  request.list.mockResolvedValue([
    { id: asMachineId('host'), targetUnavailableReason: 'Unavailable' },
  ])
  const reasons = new MachineUpdateReasons()
  const view = renderHook(() => useMachineUpdateReasons(reasons))
  await act(async () => {})
  expect(request.list).toHaveBeenCalledTimes(1)
  expect(reasons.answer).toEqual({ host: 'Unavailable' })
  await act(async () => request.refresh?.())
  expect(request.list).toHaveBeenCalledTimes(2)
  view.unmount()
  expect(request.stop).toHaveBeenCalledOnce()
  expect(reasons.answer).toBeUndefined()
})

it('ignores a reply after its view closes', async () => {
  let answer!: (
    rows: { id: ReturnType<typeof asMachineId>; targetUnavailableReason: string }[],
  ) => void
  request.list.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve
      }),
  )
  const reasons = new MachineUpdateReasons()
  const view = renderHook(() => useMachineUpdateReasons(reasons))
  view.unmount()
  await act(async () =>
    answer([{ id: asMachineId('host'), targetUnavailableReason: 'Unavailable' }]),
  )
  expect(reasons.answer).toBeUndefined()
})
