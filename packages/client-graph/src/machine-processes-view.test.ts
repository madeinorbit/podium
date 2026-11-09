import type { TopicListener } from '@podium/client-core/socket-transport'
import { asMachineId } from '@podium/model'
import type { TopicPayload } from '@podium/protocol'
import { expect, it, vi } from 'vitest'
import { MachineProcessesView } from './machine-processes-view'

it('holds processes only while open, applies pushed memory/reclaim and forgets them on loss or close', () => {
  let listener!: TopicListener<TopicPayload<'machine.processes'>>
  const release = vi.fn()
  const hub = {
    subscribeTopic: vi.fn((_kind, _id, held) => {
      listener = held
      return release
    }),
    on: vi.fn(() => () => {}),
    refreshTopic: vi.fn(),
  }
  const machines = { serverMachineId: () => undefined, subscribe: () => () => {} }
  const view = new MachineProcessesView(hub as never, machines, asMachineId('machine'))
  expect(hub.subscribeTopic).not.toHaveBeenCalled()
  view.open()
  expect(hub.subscribeTopic).toHaveBeenCalledWith('machine.processes', 'machine', expect.anything())
  const value: TopicPayload<'machine.processes'> = {
    breakdown: {
      hostname: 'host',
      sampledAt: '2026-11-08T00:00:00Z',
      memory: { totalBytes: 100, availableBytes: 50, swapTotalBytes: 0, swapFreeBytes: 0 },
      supported: true,
      agents: [],
      projects: [],
      otherBytes: 50,
    },
    reclaim: {
      candidates: [],
      orphans: [],
      diagnostics: [],
      estimate: { status: 'ready', recoverableBytes: 123, measuredAt: '2026-11-08T00:00:00Z' },
    },
  }
  listener.onState?.({ status: 'value', value, position: { epoch: 'e', seq: 1 } })
  expect(view.snapshot.value).toBe(value)
  view.refresh()
  expect(hub.refreshTopic).toHaveBeenCalledWith('machine.processes', 'machine')
  listener.onState?.({ status: 'unknown', since: 0, last: value })
  expect(view.snapshot.value).toBeUndefined()
  view.close()
  expect(release).toHaveBeenCalledTimes(1)
})
