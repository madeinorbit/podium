import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { QueuedMessageApply } from './queued-apply'

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

  it('hands a rejection and its cause to the ledger, and propagates its failure', async () => {
    const failure = new Error('failure write failed')
    const rejected = vi.fn(async () => {
      throw failure
    })
    const apply = new QueuedMessageApply({
      ...({} as ConstructorParameters<typeof QueuedMessageApply>[0]),
      rejected,
    })
    await expect(apply.reject('m1', 'not accepting input', 'never-live')).rejects.toBe(failure)
    expect(rejected).toHaveBeenCalledWith('m1', 'not accepting input', 'never-live')
  })
})

describe('authorize lets an unknown row be forwarded again as a recovery [POD-4775]', () => {
  const authorizing = (deliveryStatus: string) =>
    new QueuedMessageApply({
      ...({} as ConstructorParameters<typeof QueuedMessageApply>[0]),
      messages: {
        getMessage: async () => ({ id: 'm1', deliveryStatus }),
      } as unknown as ConstructorParameters<typeof QueuedMessageApply>[0]['messages'],
      authorize: () => ({ ok: true }),
    })

  it('admits an unknown row: its next forward is a recovery the daemon answers by id', async () => {
    expect(await authorizing('unknown').authorize('m1')).toEqual({ ok: true })
  })

  it('still refuses a row that is already typed or ended', async () => {
    expect(await authorizing('typed').authorize('m1')).toEqual({
      ok: false,
      reason: 'message is typed',
    })
    expect(await authorizing('failed').authorize('m1')).toEqual({
      ok: false,
      reason: 'message is failed',
    })
  })
})
