import { describe, expect, it, vi } from 'vitest'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'
import { webFollowPorts } from './server-follow'

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

  it('is not the browser adapter under the desktop bridge: no identity, no Connect move', async () => {
    const location = page()
    const bridge = { platform: 'linux' } as NativeDesktopBridge
    const ports = webFollowPorts({ bridge, location, ...immediate })
    ports.saveIdentity(IDENTITY)
    expect(ports.loadIdentity()).toBeUndefined()
    await expect(ports.adopt({ via: 'connect', origin: 'https://new.example' })).rejects.toThrow()
    expect(location.replace).not.toHaveBeenCalled()
  })
})
