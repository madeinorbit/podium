import { describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { fetchMailBody } from './mail-body'

function stubTrpc(answer: (id: string) => Promise<{ body: string }>) {
  const query = vi.fn(({ id }: { id: string }) => answer(id))
  return { trpc: { messages: { show: { query } } } as unknown as Trpc, query }
}

describe('fetchMailBody (POD-2143)', () => {
  it('shares one read per id, keeps 50 per handle, and keeps nothing across handles', async () => {
    const { trpc, query } = stubTrpc(async (id) => ({ body: `body of ${id}` }))
    const handle = {}
    const [a, b] = [fetchMailBody(handle, trpc, 'msg_0'), fetchMailBody(handle, trpc, 'msg_0')]
    expect(await a).toBe('body of msg_0')
    expect(await b).toBe('body of msg_0')
    expect(query).toHaveBeenCalledTimes(1)

    for (let i = 1; i <= 50; i++) await fetchMailBody(handle, trpc, `msg_${i}`)
    expect(query).toHaveBeenCalledTimes(51)
    await fetchMailBody(handle, trpc, 'msg_0')
    expect(query).toHaveBeenCalledTimes(52) // msg_0 was the oldest, so it was dropped

    // A new handle (another sign-in) starts empty.
    await fetchMailBody({}, trpc, 'msg_50')
    expect(query).toHaveBeenCalledTimes(53)
  })

  it('forgets a failed read so the next open asks again', async () => {
    let fail = true
    const { trpc, query } = stubTrpc(async (id) => {
      if (fail) throw new Error('offline')
      return { body: id }
    })
    const handle = {}
    await expect(fetchMailBody(handle, trpc, 'msg_x')).rejects.toThrow('offline')
    fail = false
    expect(await fetchMailBody(handle, trpc, 'msg_x')).toBe('msg_x')
    expect(query).toHaveBeenCalledTimes(2)
  })
})
