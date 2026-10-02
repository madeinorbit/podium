import { SERVER_UNAVAILABLE_MESSAGE } from '@podium/client-core/replica-assembly/server-calls'
import { asThreadId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeMobileTrpc } from './trpc'

afterEach(() => vi.unstubAllGlobals())
describe('mobile shared server-call recovery', () => {
  it('probes readiness with the same bearer and workspace before replaying a query once', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection interrupted'))
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('[{"result":{"data":[]}}]'))
    vi.stubGlobal('fetch', fetch)
    const client = makeMobileTrpc(
      'https://relay.test',
      'device-token',
      undefined,
      { workspaceId: 'ws_blue' },
      { recoveryDelaysMs: [0] },
    )
    await expect(client.superagent.listThreads.query()).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls[1]?.[0]).toBe('https://relay.test/readiness')
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer device-token')
      expect(new Headers(init.headers).get('podium-workspace-id')).toBe('ws_blue')
    }
  })
  it('does not replay a mutation after the server may have committed it', async () => {
    const fetch = vi.fn(async () => new Response(''))
    const client = makeMobileTrpc('https://relay.test', null, undefined, undefined, {
      fetch,
      recoveryDelaysMs: [0],
    })
    await expect(
      client.superagent.interruptTurn.mutate({ threadId: asThreadId('global') }),
    ).rejects.toMatchObject({ message: SERVER_UNAVAILABLE_MESSAGE })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('does not probe readiness for an authoritative auth refusal', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              error: {
                message: 'Sign in required',
                code: -32001,
                data: { code: 'UNAUTHORIZED', httpStatus: 401 },
              },
            },
          ]),
          { status: 401 },
        ),
    )
    const client = makeMobileTrpc('https://relay.test', null, undefined, undefined, {
      fetch,
      recoveryDelaysMs: [0],
    })
    await expect(client.superagent.listThreads.query()).rejects.toMatchObject({
      message: 'Sign in required',
    })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
