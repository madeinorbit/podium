/**
 * The client half of the read cursor (POD-1380): monotonic local projection,
 * the one-shot drain of the legacy device-local key, and the rule that a row
 * belonging to somebody else is never painted as yours.
 */

import type { ReadPositionSnapshot } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { createReadPositionClient, NO_READ_POSITION, readLegacyCursorBlob } from './read-position'
import { READ_POSITION_UI_KEY } from './ui-state'

function localStore(initial: Record<string, string | null> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    get: (key: string) => map.get(key) ?? null,
    set: (key: string, value: string | null) => {
      if (value === null) map.delete(key)
      else map.set(key, value)
    },
    has: (key: string) => map.has(key),
  }
}

function apiWith(snapshot: ReadPositionSnapshot) {
  const advances: { streamId: string; lastEventId: number; seenAt?: string | null }[] = []
  let server: ReadPositionSnapshot = snapshot
  const api = {
    readPosition: {
      advance: {
        mutate: (input: { streamId: string; lastEventId: number; seenAt?: string | null }) => {
          advances.push(input)
          const current = server[input.streamId]
          if (current === undefined || input.lastEventId > current.lastEventId) {
            server = {
              ...server,
              [input.streamId]: { lastEventId: input.lastEventId, seenAt: input.seenAt ?? null },
            }
          }
          return Promise.resolve(server)
        },
      },
    },
  }
  /** What a boot does since POD-6673: the replica's rows, then the legacy drain. */
  const hydrate = (port: ReturnType<typeof createReadPositionClient>) => {
    port.replace(server)
    port.drainLegacy()
  }
  return { api, advances, serverNow: () => server, hydrate }
}

describe('the legacy blob parser', () => {
  it('reads a stored cursor and treats every corruption as never-seen', () => {
    expect(readLegacyCursorBlob('{"id":41,"ts":"2026-07-14T14:20:00Z"}')).toEqual({
      lastEventId: 41,
      seenAt: '2026-07-14T14:20:00Z',
    })
    expect(readLegacyCursorBlob(null)).toBeNull()
    expect(readLegacyCursorBlob('{broken')).toBeNull()
    expect(readLegacyCursorBlob('{"id":-3}')).toBeNull()
    expect(readLegacyCursorBlob('{"ts":"x"}')).toBeNull()
  })
})

describe('the client cursor port', () => {
  it('reads NO_READ_POSITION before the replica answers and its position after', async () => {
    const { hydrate, api } = apiWith({ issueEvents: { lastEventId: 12, seenAt: 't' } })
    const port = createReadPositionClient({ api: api as never, local: localStore() })
    expect(port.get('issueEvents')).toEqual(NO_READ_POSITION)
    hydrate(port)
    expect(port.get('issueEvents')).toEqual({ lastEventId: 12, seenAt: 't' })
  })

  it('advance is monotonic locally: a stale proposal neither paints nor sends', async () => {
    const { hydrate, api, advances } = apiWith({ issueEvents: { lastEventId: 30, seenAt: null } })
    const port = createReadPositionClient({ api: api as never, local: localStore() })
    hydrate(port)

    port.advance('issueEvents', { lastEventId: 10, seenAt: 'x' })
    expect(port.get('issueEvents').lastEventId).toBe(30)
    expect(advances).toEqual([])

    port.advance('issueEvents', { lastEventId: 31, seenAt: 'y' })
    expect(port.get('issueEvents')).toEqual({ lastEventId: 31, seenAt: 'y' })
    expect(advances).toEqual([{ streamId: 'issueEvents', lastEventId: 31, seenAt: 'y' }])
  })

  it('drains the legacy device-local key exactly once and forwards it', async () => {
    const local = localStore({ [READ_POSITION_UI_KEY]: '{"id":77,"ts":"then"}' })
    const { hydrate, api, advances, serverNow } = apiWith({})
    const port = createReadPositionClient({ api: api as never, local })

    hydrate(port)
    expect(advances).toEqual([{ streamId: 'issueEvents', lastEventId: 77, seenAt: 'then' }])
    expect(local.has(READ_POSITION_UI_KEY)).toBe(false)
    expect(serverNow().issueEvents?.lastEventId).toBe(77)

    // A second hydration finds no local key and forwards nothing again.
    hydrate(port)
    expect(advances).toHaveLength(1)
  })

  it('a legacy value BEHIND the server position is dropped, never forwarded', async () => {
    // The migration must be safe on the second device, which has an old local
    // value and a server row already further along.
    const local = localStore({ [READ_POSITION_UI_KEY]: '{"id":5,"ts":"old"}' })
    const { hydrate, api, advances } = apiWith({ issueEvents: { lastEventId: 500, seenAt: 'new' } })
    const port = createReadPositionClient({ api: api as never, local })

    hydrate(port)
    expect(advances).toEqual([])
    expect(local.has(READ_POSITION_UI_KEY)).toBe(false)
    expect(port.get('issueEvents')).toEqual({ lastEventId: 500, seenAt: 'new' })
  })

  it('replace drops a row for a stream this build does not know', async () => {
    const { hydrate, api } = apiWith({})
    const port = createReadPositionClient({ api: api as never, local: localStore() })
    port.replace({
      issueEvents: { lastEventId: 4, seenAt: null },
      someFutureFeed: { lastEventId: 900, seenAt: null },
    } as ReadPositionSnapshot)
    expect(port.get('issueEvents').lastEventId).toBe(4)
    // Not thrown, not rendered: an unknown stream has no surface to be a
    // position in, and a future server must be able to add one.
    expect(port.get('someFutureFeed' as never)).toEqual(NO_READ_POSITION)
  })

  it('a failed advance reports and keeps the optimistic position', async () => {
    const onError = vi.fn()
    const api = {
      readPosition: {
        advance: { mutate: () => Promise.reject(new Error('offline')) },
      },
    }
    const port = createReadPositionClient({ api: api as never, local: localStore(), onError })
    port.drainLegacy()
    port.advance('issueEvents', { lastEventId: 9, seenAt: null })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('offline')))
    expect(port.get('issueEvents').lastEventId).toBe(9)
  })

  it('advances on the sync write entry point when the server has it (POD-6412)', async () => {
    const submitted: { command: string; input: unknown }[] = []
    const route = vi.fn()
    const api = {
      sync: {
        submit: {
          mutate: (envelope: { command: string; input: unknown }) => {
            submitted.push({ command: envelope.command, input: envelope.input })
            return Promise.resolve({
              outcome: 'applied',
              result: { issueEvents: { lastEventId: 12, seenAt: null } },
              receipt: { feedId: 'f', epoch: 'e', seq: 1 },
              replayed: false,
            })
          },
        },
      },
      readPosition: {
        advance: { mutate: route },
      },
    }
    const port = createReadPositionClient({ api: api as never, local: localStore() })
    port.drainLegacy()
    port.advance('issueEvents', { lastEventId: 12, seenAt: null })
    await vi.waitFor(() =>
      expect(submitted).toEqual([
        {
          command: 'readPosition.advance',
          input: { streamId: 'issueEvents', lastEventId: 12, seenAt: null },
        },
      ]),
    )
    expect(route).not.toHaveBeenCalled()
  })

  it('notifies subscribers when the position moves and not when it does not', async () => {
    const { hydrate, api } = apiWith({ issueEvents: { lastEventId: 10, seenAt: null } })
    const port = createReadPositionClient({ api: api as never, local: localStore() })
    hydrate(port)
    const seen = vi.fn()
    port.subscribe(seen)
    port.advance('issueEvents', { lastEventId: 3, seenAt: null })
    expect(seen).not.toHaveBeenCalled()
    port.advance('issueEvents', { lastEventId: 11, seenAt: null })
    expect(seen).toHaveBeenCalled()
  })
})
