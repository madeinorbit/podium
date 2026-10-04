import { asSessionId } from '@podium/model'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { Replica } from '../replica/replica'
import { openKernelEngineOutbox } from './kernel-outbox'

describe('reload outbox durability', () => {
  it('waits for an in-flight enqueue, while offline delivery stays queued across reopen', async () => {
    const store = new InMemoryOutboxStore([])
    const api = {} as PodiumClientApi
    const open = async () => {
      const factory = await openKernelEngineOutbox({
        store,
        principal: 'operator',
        api,
        onDegraded: () => {},
      })
      return factory({
        api,
        replica: {} as Replica,
        notices: { error: () => {}, info: () => {} },
        isOnline: () => false,
      })
    }
    const outbox = await open()
    const apply = store.apply.bind(store)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    store.apply = async (...args) => {
      await held
      return apply(...args)
    }
    const enqueue = outbox.enqueue('resumeAndSend', {
      sessionId: asSessionId('unsent'),
      text: 'keep this queued text',
    })
    const ready = vi.fn()
    const prepared = outbox.flushLocalWrites?.().then(ready)
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()
    release()
    await enqueue
    await prepared
    expect(ready).toHaveBeenCalledOnce()
    expect(outbox.size()).toBe(1)
    outbox.dispose()
    const reopened = await open()
    expect(reopened.pending()[0]?.input).toMatchObject({ text: 'keep this queued text' })
    reopened.dispose()
  })
})
