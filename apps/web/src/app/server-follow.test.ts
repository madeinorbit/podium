import { describe, expect, it, vi } from 'vitest'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'
import { startBundledServerSearch, webFollowPorts } from './server-follow'

const IDENTITY = {
  installationId: `pdm_${'a'.repeat(43)}`,
  installationPublicKey: `ed25519:${'A'.repeat(43)}`,
}

function page(path = '/work/issues/POD-1', search = '?view=board', hash = '#top') {
  return {
    pathname: path,
    search,
    hash,
    replace: vi.fn<(url: string) => void>(),
  }
}

const immediate = { notify: vi.fn() }

describe('the web app follows a moved server (POD-5921)', () => {
  it('a Connect find replaces the page with the same path at the new origin, after saying so', async () => {
    vi.useFakeTimers()
    try {
      const location = page()
      const notify = vi.fn()
      const ports = webFollowPorts({ bridge: undefined, location, notify })
      const adopted = ports.adopt({ via: 'connect', origin: 'https://new-words.trycloudflare.com' })
      expect(notify).toHaveBeenCalledWith(
        'Podium moved to new-words.trycloudflare.com. You will need to log in there.',
      )
      expect(location.replace).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_500)
      await adopted
      expect(location.replace).toHaveBeenCalledExactlyOnceWith(
        'https://new-words.trycloudflare.com/work/issues/POD-1?view=board#top',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('a transfer with a claim goes through the claim page, keeping the path in the fragment', async () => {
    const location = page('/work', '', '')
    const ports = webFollowPorts({ bridge: undefined, location, ...immediate })
    await ports.adopt({
      via: 'transfer',
      origin: 'https://target.example',
      transferId: 't1',
      claimToken: 'secret',
    })
    const url = new URL(location.replace.mock.calls[0]![0])
    expect(url.origin + url.pathname).toBe('https://target.example/auth/server-transfer-claim')
    expect(new URLSearchParams(url.hash.slice(1)).get('token')).toBe('secret')
    expect(new URLSearchParams(url.hash.slice(1)).get('next')).toBe('/work')
  })

  it('keeps the identity in memory only', () => {
    const ports = webFollowPorts({ bridge: undefined, location: page(), ...immediate })
    expect(ports.loadIdentity()).toBeUndefined()
    ports.saveIdentity(IDENTITY)
    expect(ports.loadIdentity()).toEqual(IDENTITY)
    expect(webFollowPorts({ bridge: undefined, location: page(), ...immediate }).loadIdentity()).toBeUndefined()
  })

  it('under an older desktop bridge: no identity, no Connect move, transfers as before', async () => {
    const location = page()
    const bridge = { platform: 'linux' } as NativeDesktopBridge
    const ports = webFollowPorts({ bridge, location, ...immediate })
    ports.saveIdentity(IDENTITY)
    expect(ports.loadIdentity()).toBeUndefined()
    await expect(ports.adopt({ via: 'connect', origin: 'https://new.example' })).rejects.toThrow()
    expect(location.replace).not.toHaveBeenCalled()
  })

  it('a desktop window keeps its identity in the shell and moves through it, never by navigating', async () => {
    const location = page()
    const moveServer = vi.fn(async () => {})
    const saveServerIdentity = vi.fn(async () => {})
    const notify = vi.fn()
    const bridge = {
      platform: 'linux',
      serverIdentity: IDENTITY,
      moveServer,
      saveServerIdentity,
    } as unknown as NativeDesktopBridge
    const ports = webFollowPorts({ bridge, location, notify })
    expect(ports.loadIdentity()).toEqual(IDENTITY)
    ports.saveIdentity(IDENTITY)
    expect(saveServerIdentity).not.toHaveBeenCalled()
    const next = { ...IDENTITY, installationId: `pdm_${'b'.repeat(43)}` }
    ports.saveIdentity(next)
    expect(saveServerIdentity).toHaveBeenCalledExactlyOnceWith(next)
    expect(ports.loadIdentity()).toEqual(next)

    await ports.adopt({ via: 'connect', origin: 'https://new.example' })
    await ports.adopt({ via: 'transfer', origin: 'https://t.example', transferId: 't1', claimToken: 'c' })
    expect(moveServer.mock.calls).toEqual([
      ['https://new.example'],
      ['https://t.example', 't1', 'c'],
    ])
    expect(notify).toHaveBeenCalledWith('Podium moved to new.example')
    expect(location.replace).not.toHaveBeenCalled()
  })
})

describe('the bundled desktop window looks for its server (POD-5921)', () => {
  const run = async (opts: { storedProves: boolean; located?: string }) => {
    vi.useFakeTimers()
    try {
      const moveServer = vi.fn(async () => {})
      const proved: string[] = []
      const located: string[] = []
      const stop = startBundledServerSearch({
        serverUrl: 'wss://old-words.trycloudflare.com',
        identity: IDENTITY,
        moveServer,
        connectBaseUrl: 'https://connect.test',
        random: () => 0.5,
        prove: async ({ origin }) => {
          proved.push(origin)
          return opts.storedProves ? { ok: true } : { ok: false, reason: 'down' }
        },
        locate: async ({ currentOrigin }) => {
          located.push(currentOrigin)
          return opts.located
        },
      })
      await vi.advanceTimersByTimeAsync(0)
      stop()
      return { moveServer, proved, located }
    } finally {
      vi.useRealTimers()
    }
  }

  it('returns to the stored address when it proves itself again', async () => {
    const r = await run({ storedProves: true, located: 'https://elsewhere.example' })
    expect(r.proved).toEqual(['https://old-words.trycloudflare.com'])
    expect(r.located).toEqual([])
    expect(r.moveServer).toHaveBeenCalledExactlyOnceWith('https://old-words.trycloudflare.com')
  })

  it('otherwise moves to where Connect found it, skipping the stored address', async () => {
    const r = await run({ storedProves: false, located: 'https://new-words.trycloudflare.com' })
    expect(r.located).toEqual(['https://old-words.trycloudflare.com'])
    expect(r.moveServer).toHaveBeenCalledExactlyOnceWith('https://new-words.trycloudflare.com')
  })

  it('moves nowhere when nothing proves itself', async () => {
    const r = await run({ storedProves: false })
    expect(r.moveServer).not.toHaveBeenCalled()
  })
})
