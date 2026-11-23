import { asMachineId } from '@podium/model'
import { topicKey } from '@podium/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { registerProcessesWatch } from './processes-watch'
import { TopicWatchRegistry } from './watch-registry'

afterEach(() => vi.useRealTimers())
it('samples only with demand, forwards server roots and drops a read after the last unsubscribe', async () => {
  vi.useFakeTimers()
  const machineId = asMachineId('self')
  const watches = new TopicWatchRegistry()
  const send = vi.fn()
  let resolve!: (value: never) => void
  const read = vi.fn(
    () =>
      new Promise<never>((done) => {
        resolve = done
      }),
  )
  registerProcessesWatch({ machineId, watches, send, read })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(read).not.toHaveBeenCalled()
  const key = topicKey('machine.processes', machineId)
  watches.apply(key, true, { roots: ['/registered/repo'] })
  expect(read).toHaveBeenCalledExactlyOnceWith(['/registered/repo'])
  await vi.advanceTimersByTimeAsync(10_000)
  expect(read).toHaveBeenCalledTimes(1)
  watches.apply(key, false)
  resolve({ supported: false } as never)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(send).not.toHaveBeenCalled()
  expect(read).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
