import { describe, expect, it, vi } from 'vitest'
import { superagentWrites } from './superagent-writes'

const applied = (result: unknown) => ({
  outcome: 'applied',
  result,
  receipt: { feedId: 'f', epoch: 'e', seq: 1 },
  replayed: false,
})

describe('superagentWrites (POD-6419)', () => {
  it('sends every superagent write on sync.submit and answers its result', async () => {
    const submit = vi.fn(async () =>
      applied({ threadId: 'global', podiumSessionId: 's1', queued: false }),
    )
    const route = vi.fn()
    const trpc = {
      sync: { submit: { mutate: submit } },
      superagent: { sendTurn: { mutate: route }, clear: { mutate: route } },
    }
    const ack = await superagentWrites(trpc).sendTurn.mutate({ threadId: 'global', text: 'hi' })
    expect(ack).toEqual({ threadId: 'global', podiumSessionId: 's1', queued: false })
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'superagent.sendTurn',
        version: 1,
        input: { threadId: 'global', text: 'hi' },
      }),
    )
    expect(route).not.toHaveBeenCalled()
  })

  it('throws a refusal in the server’s own words', async () => {
    const submit = vi.fn(async () => ({
      outcome: 'rejected',
      refusal: { kind: 'conflict', message: 'a turn is running on this thread' },
    }))
    const trpc = {
      sync: { submit: { mutate: submit } },
      superagent: { openInTerminal: { mutate: vi.fn() } },
    }
    await expect(
      superagentWrites(trpc).openInTerminal.mutate({ threadId: 'global' }),
    ).rejects.toThrow('a turn is running on this thread')
  })

  it('LEGACY: a server without sync.submit takes the old route', async () => {
    const route = vi.fn(async (_input: unknown) => undefined)
    const trpc = { superagent: { clear: { mutate: route } } }
    await superagentWrites(trpc).clear.mutate({ threadId: 'global' })
    expect(route).toHaveBeenCalledWith({ threadId: 'global' })
  })
})
