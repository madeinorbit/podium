import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { cancelInterruptedQueuedMessage, QueuedMessageApply } from './queued-apply'

describe('queued message completion', () => {
  it.each(['applied', 'injected'] as const)('waits for durable %s completion', async (hook) => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const apply = new QueuedMessageApply({
      ...({} as ConstructorParameters<typeof QueuedMessageApply>[0]),
      [hook]: () => pending,
    })
    let settled = false
    const result = apply[hook]('m1', asSessionId('s1')).then(() => { settled = true })
    await Promise.resolve()
    try { expect(settled).toBe(false) } finally { release(); await result }
  })

  it.each(['applied', 'injected'] as const)('propagates the exact %s failure', async (hook) => {
    const failure = new Error('durable write failed')
    const apply = new QueuedMessageApply({
      ...({} as ConstructorParameters<typeof QueuedMessageApply>[0]),
      [hook]: async () => { throw failure },
    })
    await expect(apply[hook]('m1', asSessionId('s1'))).rejects.toBe(failure)
  })

  it('propagates the exact rejected event write failure', async () => {
    const failure = new Error('dead-letter event write failed')
    const emit = vi.fn()
    const apply = new QueuedMessageApply({
      ...({} as ConstructorParameters<typeof QueuedMessageApply>[0]),
      messages: {
        getMessage: async () => ({ id: 'm1', status: 'queued' }),
        markDeadLetter: async () => true,
      } as unknown as ConstructorParameters<typeof QueuedMessageApply>[0]['messages'],
      events: { appendEvent: async () => { throw failure } } as unknown as ConstructorParameters<typeof QueuedMessageApply>[0]['events'],
      bus: { emit } as unknown as ConstructorParameters<typeof QueuedMessageApply>[0]['bus'],
      now: () => '2026-09-07T00:00:00Z',
    })
    await expect(apply.reject('m1', 'revoked')).rejects.toBe(failure)
    expect(emit).not.toHaveBeenCalled()
  })

  it('waits for physical cancellation completion', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const cancel = vi.fn(async () => { await pending; throw new Error('message is no longer queued') })
    let settled = false
    const result = cancelInterruptedQueuedMessage({ cancel }, 'm1').then(() => { settled = true })
    await Promise.resolve()
    try { expect(settled).toBe(false) } finally { release(); await result }
    expect(cancel).toHaveBeenCalledWith('m1')
  })

  it.each([new Error('storage failed'), new Error('unknown message m1'), { code: 'IO_FAILURE' }])(
    'propagates the exact cancellation failure %#', async (failure) => {
      const cancel = async () => { throw failure }
      await expect(cancelInterruptedQueuedMessage({ cancel }, 'm1')).rejects.toBe(failure)
    },
  )

  it('tolerates only a concurrent terminal transition', async () => {
    const cancel = async () => { throw new Error('message is no longer queued') }
    await expect(cancelInterruptedQueuedMessage({ cancel }, 'm1')).resolves.toBeUndefined()
  })
})
