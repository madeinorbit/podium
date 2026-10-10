import { encode, type ServerMessage } from '@podium/protocol'
import type { ServerIdentity, ServerMove } from '@podium/runtime/server-follow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type HubEvents, SocketHub, type WebSocketLike } from '../socket-transport/socket-hub'
import { type FollowableHub, followHub } from './server-follow'

class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(): void {}
  close(): void {
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  recv(msg: ServerMessage): void {
    this.onmessage?.({ data: encode(msg) })
  }
}

const IDENTITY: ServerIdentity = {
  installationId: `pdm_${'a'.repeat(42)}A`,
  installationPublicKey: `ed25519:${'A'.repeat(43)}`,
}

afterEach(() => {
  vi.useRealTimers()
})

function realHub(url = 'wss://old.example/client?workspace=team') {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const hub = new SocketHub({
    url,
    makeSocket: (u) => {
      urls.push(u)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  })
  const links: string[] = []
  hub.on('link', (state) => links.push(state))
  return { hub, sockets, urls, links }
}

describe('the hub says when its link is lost or welcomed (POD-5921)', () => {
  it('a FIRST dial that fails is lost — which the health indicator never says', () => {
    vi.useFakeTimers()
    const h = realHub()
    h.hub.connect()
    h.sockets[0]!.onerror?.({})
    h.sockets[0]!.close()
    expect(h.links).toEqual(['lost'])
    expect(h.hub.connectionHealth().status).toBe('ok')
    h.hub.dispose()
  })

  it('welcome is welcomed; a dropped socket is lost again', () => {
    vi.useFakeTimers()
    const h = realHub()
    h.hub.connect()
    h.sockets[0]!.open()
    expect(h.links).toEqual([])
    h.sockets[0]!.recv({ type: 'welcome', clientId: 'c0' })
    expect(h.links).toEqual(['welcomed'])
    h.sockets[0]!.close()
    expect(h.links).toEqual(['welcomed', 'lost'])
    h.hub.dispose()
  })

  it('wake, suspend and dispose are not losses', () => {
    vi.useFakeTimers()
    const h = realHub()
    h.hub.connect()
    h.sockets[0]!.open()
    h.hub.wake()
    h.hub.suspend()
    h.hub.connectNow()
    h.hub.dispose()
    expect(h.links).toEqual([])
  })

  it('retarget dials the new origin at once, keeping path and workspace, without a loss', () => {
    vi.useFakeTimers()
    const h = realHub()
    h.hub.connect()
    h.sockets[0]!.open()
    h.hub.retarget('https://new.example')
    expect(h.urls.at(-1)).toBe('wss://new.example/client?workspace=team')
    expect(h.hub.url).toBe('wss://new.example/client?workspace=team')
    expect(h.links).toEqual([])
    h.hub.dispose()
  })

  it('a transfer frame goes to a serverRelocation listener when one exists', () => {
    const h = realHub()
    const moves: HubEvents['serverRelocation'][0][] = []
    h.hub.on('serverRelocation', (move) => moves.push(move))
    h.hub.connect()
    h.sockets[0]!.open()
    h.sockets[0]!.recv({
      type: 'serverRelocation',
      transferId: '00000000-0000-4000-8000-000000000001',
      publicUrl: 'https://target.example',
      claimToken: 'c'.repeat(64),
    })
    expect(moves).toEqual([
      {
        publicUrl: 'https://target.example',
        transferId: '00000000-0000-4000-8000-000000000001',
        claimToken: 'c'.repeat(64),
      },
    ])
    // Not the built-in rewrite: the socket did not move by itself.
    expect(h.urls).toEqual(['wss://old.example/client?workspace=team'])
    h.hub.dispose()
  })
})

function fakeHub(url = 'wss://old.example/client'): FollowableHub & {
  emit<K extends 'link' | 'serverRelocation'>(kind: K, ...payload: HubEvents[K]): void
} {
  const handlers = new Map<string, Set<(...args: never[]) => void>>()
  return {
    url,
    on(kind: string, handler: (...args: never[]) => void) {
      const set = handlers.get(kind) ?? new Set()
      set.add(handler)
      handlers.set(kind, set)
      return () => set.delete(handler)
    },
    emit(kind, ...payload) {
      for (const handler of handlers.get(kind) ?? [])
        (handler as (...a: unknown[]) => void)(...payload)
    },
  } as FollowableHub & {
    emit<K extends 'link' | 'serverRelocation'>(kind: K, ...payload: HubEvents[K]): void
  }
}

function harness(opts: { identity?: ServerIdentity; versionBody?: object } = {}) {
  vi.useFakeTimers()
  const hub = fakeHub()
  let stored = opts.identity
  const saved: ServerIdentity[] = []
  const adopted: ServerMove[] = []
  const located: string[] = []
  const fetched: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    fetched.push(String(input))
    return Response.json(opts.versionBody ?? { appVersion: 'dev', ...IDENTITY })
  }) as unknown as typeof fetch
  const stop = followHub(
    hub,
    {
      loadIdentity: () => stored,
      saveIdentity: (identity) => {
        stored = identity
        saved.push(identity)
      },
      adopt: async (move) => {
        adopted.push(move)
      },
    },
    {
      connectBaseUrl: () => 'https://connect.test',
      fetch: fetchImpl,
      random: () => 0.5,
      locate: async ({ currentOrigin, identity }) => {
        located.push(`${currentOrigin} ${identity?.installationId ?? 'none'}`)
        return undefined
      },
    },
  )
  return { hub, saved, adopted, located, fetched, stop }
}

describe('followHub', () => {
  it('a lost link locates from the hub origin; a welcome stops it', async () => {
    const h = harness({ identity: IDENTITY })
    h.hub.emit('link', 'lost')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.located).toEqual([`https://old.example ${IDENTITY.installationId}`])
    h.hub.emit('link', 'welcomed')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(h.located).toHaveLength(1)
    h.stop()
  })

  it('learns the identity from /version on an authenticated welcome only, overwriting', async () => {
    const h = harness({ identity: { ...IDENTITY, installationId: `pdm_${'z'.repeat(43)}` } })
    h.hub.emit('link', 'lost')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetched).toEqual([])
    h.hub.emit('link', 'welcomed')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetched).toEqual(['https://old.example/version'])
    expect(h.saved).toEqual([IDENTITY])
    h.stop()
  })

  it('saves nothing from a server that advertises no full identity', async () => {
    const h = harness({
      versionBody: { appVersion: 'dev', installationId: IDENTITY.installationId },
    })
    h.hub.emit('link', 'welcomed')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.saved).toEqual([])
    h.stop()
  })

  it('a transfer frame is adopted at once, without locating', async () => {
    const h = harness({ identity: IDENTITY })
    h.hub.emit('serverRelocation', {
      publicUrl: 'https://target.example',
      transferId: 't1',
      claimToken: 'claim',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.adopted).toEqual([
      { via: 'transfer', origin: 'https://target.example', transferId: 't1', claimToken: 'claim' },
    ])
    expect(h.located).toEqual([])
    h.stop()
  })

  it('stops listening when stopped', async () => {
    const h = harness({ identity: IDENTITY })
    h.stop()
    h.hub.emit('link', 'lost')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.located).toEqual([])
  })
})
