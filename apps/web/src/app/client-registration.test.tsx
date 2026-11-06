import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeClientRegistrationStatus, NativeDesktopBridge } from '@/lib/nativeDesktop'
import { ClientRegistrationNotice } from './ClientRegistrationNotice'
import { ClientRegistration, clientRegistration } from './client-registration'
import { pairNativeDesktop } from './native-pairing'
import type { Trpc } from './trpc'

const desktop = window as typeof window & {
  __PODIUM_DESKTOP__?: NativeDesktopBridge
  __PODIUM_RESTART__?: () => Promise<void>
}

function setup(
  status: NativeClientRegistrationStatus = {
    state: 'needed',
    target: 'native-receipt',
    machineId: 'retained-client',
  },
) {
  const events: string[] = []
  const mint = vi.fn(async () => {
    events.push('mint')
    return { code: 'ABCD-EFGH' }
  })
  const trpc = { machines: { pairingCode: { mutate: mint } } } as unknown as Trpc
  const save = vi.fn(async () => {
    events.push('save')
  })
  const read = vi.fn(async () => status)
  const restart = vi.fn(async () => {
    events.push('restart')
    throw new Error('restart refused')
  })
  desktop.__PODIUM_RESTART__ = restart
  const bridge: NativeDesktopBridge = {
    platform: 'linux',
    launchMode: 'client',
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    clientRegistrationStatus: read,
    registerClient: save,
  }
  desktop.__PODIUM_DESKTOP__ = bridge
  return { events, mint, trpc, save, read, restart, bridge, registration: new ClientRegistration() }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete desktop.__PODIUM_DESKTOP__
  delete desktop.__PODIUM_RESTART__
})

describe('authenticated native client registration', () => {
  it('waits for live authentication, then survives StrictMode and authenticated remounts with one mint and restart', async () => {
    const fixture = setup()
    vi.spyOn(clientRegistration, 'start').mockImplementation((...args) =>
      fixture.registration.start(...args),
    )
    const view = render(
      <StrictMode>
        <ClientRegistrationNotice trpc={fixture.trpc} />
      </StrictMode>,
    )
    await act(async () => {})
    expect(fixture.read).not.toHaveBeenCalled()
    view.rerender(
      <StrictMode>
        <ClientRegistrationNotice trpc={fixture.trpc} auth={{ kind: 'provisional-failure' }} />
      </StrictMode>,
    )
    await act(async () => {})
    expect(fixture.read).not.toHaveBeenCalled()
    view.rerender(
      <StrictMode>
        <ClientRegistrationNotice
          trpc={fixture.trpc}
          auth={{ kind: 'principal', principal: 'signed-in-user' }}
        />
      </StrictMode>,
    )
    await screen.findByRole('alert')
    expect(fixture.mint).toHaveBeenCalledExactlyOnceWith({
      podiumManaged: true,
      copyAgentCredentials: false,
      clientRegistration: { machineId: 'retained-client' },
    })
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith('ABCD-EFGH', 'native-receipt')
    expect(fixture.events).toEqual(['mint', 'save', 'restart'])
    expect(screen.getByRole('alert').textContent).toContain('quit and reopen')
    view.unmount()
    render(
      <ClientRegistrationNotice
        trpc={fixture.trpc}
        auth={{ kind: 'principal', principal: 'signed-in-user' }}
      />,
    )
    await screen.findByRole('alert')
    expect(fixture.mint).toHaveBeenCalledTimes(1)
    expect(fixture.restart).toHaveBeenCalledTimes(1)
  })

  it('forwards the retained public identity to the single authenticated server decision', async () => {
    const publicKey = `ed25519:${'a'.repeat(43)}`
    const fixture = setup({
      state: 'needed',
      target: 'same-target',
      machineId: 'retained-client',
      publicKey,
    })
    await fixture.registration.start(fixture.bridge, fixture.trpc)
    expect(fixture.mint).toHaveBeenCalledExactlyOnceWith({
      podiumManaged: true,
      copyAgentCredentials: false,
      clientRegistration: { machineId: 'retained-client', publicKey },
    })
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith('ABCD-EFGH', 'same-target')
  })

  it('leaves older native registration bridges without an identity request bounded and unchanged', async () => {
    const fixture = setup({
      state: 'needed',
      target: 'older-receipt',
    } as NativeClientRegistrationStatus)
    expect(await fixture.registration.start(fixture.bridge, fixture.trpc)).toContain(
      'does not support',
    )
    expect(fixture.mint).not.toHaveBeenCalled()
    expect(fixture.save).not.toHaveBeenCalled()
    expect(fixture.restart).not.toHaveBeenCalled()
  })

  it.each([
    'browser',
    'older-shell',
    'daemon',
    'server',
    'all-in-one',
  ] as const)('retains %s behavior', async (kind) => {
    const fixture = setup()
    let bridge: NativeDesktopBridge | undefined = fixture.bridge
    if (kind === 'browser') bridge = undefined
    else if (kind === 'older-shell') delete bridge.clientRegistrationStatus
    else bridge.launchMode = kind
    expect(await fixture.registration.start(bridge, fixture.trpc)).toBeNull()
    expect(fixture.mint).not.toHaveBeenCalled()
    expect(fixture.read).not.toHaveBeenCalled()
  })

  it.each([
    { state: 'enrolled' },
    { state: 'not-applicable' },
    {
      state: 'rejected',
      message: 'Explicit pairing required; automatic registration will not retry.',
    },
    { state: 'unavailable', message: 'Incomplete local identity; inspect local logs.' },
  ] satisfies NativeClientRegistrationStatus[])('never pairs on $state', async (status) => {
    const fixture = setup(status)
    const result = await fixture.registration.start(fixture.bridge, fixture.trpc)
    expect(result).toBe('message' in status ? status.message : null)
    expect(fixture.mint).not.toHaveBeenCalled()
    expect(fixture.restart).not.toHaveBeenCalled()
  })

  it('observes pending pairing to rejection without minting another code', async () => {
    vi.useFakeTimers()
    const fixture = setup({ state: 'pending' })
    fixture.read
      .mockResolvedValueOnce({ state: 'pending' })
      .mockResolvedValue({ state: 'rejected', message: 'Pairing code expired; pair explicitly.' })
    const attempt = fixture.registration.start(fixture.bridge, fixture.trpc)
    await vi.advanceTimersByTimeAsync(300)
    expect(await attempt).toContain('expired')
    expect(fixture.mint).not.toHaveBeenCalled()
  })

  it('bounds startup and pending observations and never restarts a pending handoff', async () => {
    vi.useFakeTimers()
    const fixture = setup({ state: 'pending' })
    const attempt = fixture.registration.start(fixture.bridge, fixture.trpc)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await attempt).toContain('quit and reopen')
    expect(fixture.read).toHaveBeenCalledTimes(40)
    expect(fixture.mint).not.toHaveBeenCalled()
    expect(fixture.restart).not.toHaveBeenCalled()
  })

  it.each([
    'mint',
    'save',
  ] as const)('does not retry or restart after %s fails, even on concurrent calls', async (step) => {
    const fixture = setup()
    if (step === 'mint') fixture.mint.mockRejectedValue(new Error('authenticated request refused'))
    else fixture.save.mockRejectedValue(new Error('target changed'))
    const first = fixture.registration.start(fixture.bridge, fixture.trpc)
    const duplicate = fixture.registration.start(fixture.bridge, fixture.trpc)
    expect(duplicate).toBe(first)
    expect(await first).toContain(step === 'mint' ? 'request refused' : 'target changed')
    await fixture.registration.start(fixture.bridge, fixture.trpc)
    expect(fixture.mint).toHaveBeenCalledTimes(1)
    expect(fixture.restart).not.toHaveBeenCalled()
  })

  it('allows one serialized retry after a new verified login replaces a refused request', async () => {
    const fixture = setup()
    fixture.mint.mockRejectedValueOnce(new Error('authenticated request refused'))
    expect(await fixture.registration.start(fixture.bridge, fixture.trpc)).toContain(
      'request refused',
    )
    await fixture.registration.start(fixture.bridge, fixture.trpc)
    expect(fixture.mint).toHaveBeenCalledTimes(1)
    fixture.registration.retryAfterSignIn()
    const retry = fixture.registration.start(fixture.bridge, fixture.trpc)
    expect(fixture.registration.start(fixture.bridge, fixture.trpc)).toBe(retry)
    expect(await retry).toContain('quit and reopen')
    expect(fixture.mint).toHaveBeenCalledTimes(2)
    expect(fixture.save).toHaveBeenCalledOnce()
    expect(fixture.restart).toHaveBeenCalledOnce()
  })

  it('requires a new verified sign-in to replace a refused saved code, once across cookie remounts', async () => {
    const fixture = setup({
      state: 'rejected',
      message: 'Client registration was refused. Sign in again to retry.',
      retry: {
        target: 'refused-saved-code-receipt',
        machineId: 'retained-client',
        publicKey: `ed25519:${'a'.repeat(43)}`,
      },
    })
    expect(await fixture.registration.start(fixture.bridge, fixture.trpc)).toContain(
      'Sign in again',
    )
    await fixture.registration.start(fixture.bridge, fixture.trpc)
    expect(fixture.mint).not.toHaveBeenCalled()
    expect(fixture.save).not.toHaveBeenCalled()
    expect(fixture.restart).not.toHaveBeenCalled()
    const restartedPage = new ClientRegistration()
    expect(await restartedPage.start(fixture.bridge, fixture.trpc)).toContain('Sign in again')
    expect(fixture.mint).not.toHaveBeenCalled()
    fixture.registration.retryAfterSignIn()
    const retry = fixture.registration.start(fixture.bridge, fixture.trpc)
    expect(fixture.registration.start(fixture.bridge, fixture.trpc)).toBe(retry)
    expect(await retry).toContain('quit and reopen')
    expect(fixture.mint).toHaveBeenCalledExactlyOnceWith({
      podiumManaged: true,
      copyAgentCredentials: false,
      clientRegistration: { machineId: 'retained-client', publicKey: `ed25519:${'a'.repeat(43)}` },
    })
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith('ABCD-EFGH', 'refused-saved-code-receipt')
    expect(fixture.restart).toHaveBeenCalledOnce()
    await fixture.registration.start(fixture.bridge, fixture.trpc)
    expect(fixture.mint).toHaveBeenCalledTimes(1)
  })

  it('honors a verified sign-in before the first attempt in a fresh WebView with a refused saved code', async () => {
    const fixture = setup({
      state: 'rejected',
      message: 'Client registration was refused. Sign in again to retry.',
      retry: { target: 'refused-saved-code-receipt', machineId: 'retained-client' },
    })
    fixture.registration.retryAfterSignIn()
    await fixture.registration.start(fixture.bridge, fixture.trpc)
    await fixture.registration.start(fixture.bridge, fixture.trpc)
    expect(fixture.mint).toHaveBeenCalledOnce()
    expect(fixture.save).toHaveBeenCalledOnce()
    expect(fixture.restart).toHaveBeenCalledOnce()
  })

  it('consumes a sign-in retry even when the actual administrator request is refused', async () => {
    const fixture = setup({
      state: 'rejected',
      message: 'Sign in again to retry.',
      retry: { target: 'refused-receipt', machineId: 'retained-client' },
    })
    fixture.mint.mockRejectedValue(new Error('current administrator authentication required'))
    fixture.registration.retryAfterSignIn()
    expect(await fixture.registration.start(fixture.bridge, fixture.trpc)).toContain(
      'authentication required',
    )
    await fixture.registration.start(fixture.bridge, fixture.trpc)
    const restartedPage = new ClientRegistration()
    expect(await restartedPage.start(fixture.bridge, fixture.trpc)).toContain('Sign in again')
    expect(fixture.mint).toHaveBeenCalledOnce()
    expect(fixture.save).not.toHaveBeenCalled()
    expect(fixture.restart).not.toHaveBeenCalled()
  })

  it('keeps a rejection without validated retry identity terminal after a new sign-in', async () => {
    const fixture = setup({ state: 'rejected', message: 'Inspect the local identity error.' })
    fixture.registration.retryAfterSignIn()
    expect(await fixture.registration.start(fixture.bridge, fixture.trpc)).toContain(
      'identity error',
    )
    expect(fixture.mint).not.toHaveBeenCalled()
    expect(fixture.save).not.toHaveBeenCalled()
  })

  it('settles an in-flight attempt before observing a new login and never remints a saved receipt', async () => {
    const fixture = setup()
    fixture.read
      .mockResolvedValueOnce({
        state: 'needed',
        target: 'native-receipt',
        machineId: 'retained-client',
      })
      .mockResolvedValue({ state: 'enrolled' })
    const first = fixture.registration.start(fixture.bridge, fixture.trpc)
    fixture.registration.retryAfterSignIn()
    const next = fixture.registration.start(fixture.bridge, fixture.trpc)
    expect(fixture.registration.start(fixture.bridge, fixture.trpc)).toBe(next)
    expect(await first).toContain('quit and reopen')
    expect(await next).toBeNull()
    expect(fixture.mint).toHaveBeenCalledOnce()
    expect(fixture.events).toEqual(['mint', 'save', 'restart'])
  })

  it('keeps a persisted handoff actionable when the restart hook is missing', async () => {
    const fixture = setup()
    delete desktop.__PODIUM_RESTART__
    expect(await fixture.registration.start(fixture.bridge, fixture.trpc)).toContain(
      'quit and reopen',
    )
    expect(fixture.save).toHaveBeenCalledOnce()
    expect(fixture.restart).not.toHaveBeenCalled()
  })

  it('shares the managed pairing and restart sequence with explicit hosting', async () => {
    const fixture = setup()
    await expect(
      pairNativeDesktop(
        fixture.trpc,
        fixture.save,
        'Hosting enabled — quit and reopen the app to finish pairing.',
      ),
    ).rejects.toThrow('Hosting enabled')
    expect(fixture.events).toEqual(['mint', 'save', 'restart'])
    expect(fixture.mint).toHaveBeenCalledExactlyOnceWith({
      podiumManaged: true,
      copyAgentCredentials: false,
    })
  })
})

describe('registration principal lifetime', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  function bobClient() {
    const mint = vi.fn().mockResolvedValue({ code: 'BOB-CODE' })
    return { mint, trpc: { machines: { pairingCode: { mutate: mint } } } as unknown as Trpc }
  }

  it('drops a departed member’s pending native read before minting for the next member', async () => {
    const fixture = setup()
    const pending = deferred<NativeClientRegistrationStatus>()
    fixture.read.mockReturnValueOnce(pending.promise)
    const alice = fixture.registration.start(fixture.bridge, fixture.trpc, 'alice')
    const bob = bobClient()
    const next = fixture.registration.start(fixture.bridge, bob.trpc, 'bob')
    pending.resolve({ state: 'needed', target: 'departed-receipt', machineId: 'retained-client' })
    await Promise.all([alice, next])
    expect(fixture.mint).not.toHaveBeenCalled()
    expect(bob.mint).toHaveBeenCalledOnce()
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith('BOB-CODE', 'native-receipt')
    expect(fixture.restart).toHaveBeenCalledOnce()
  })

  it('does not persist a departed member’s late pairing reply or restart on their behalf', async () => {
    const fixture = setup()
    const pending = deferred<{ code: string }>()
    fixture.mint.mockReturnValueOnce(pending.promise)
    const alice = fixture.registration.start(fixture.bridge, fixture.trpc, 'alice')
    await vi.waitFor(() => expect(fixture.mint).toHaveBeenCalledOnce())
    const bob = bobClient()
    const next = fixture.registration.start(fixture.bridge, bob.trpc, 'bob')
    pending.resolve({ code: 'ALICE-CODE' })
    await Promise.all([alice, next])
    expect(bob.mint).toHaveBeenCalledOnce()
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith('BOB-CODE', 'native-receipt')
    expect(fixture.restart).toHaveBeenCalledOnce()
  })
})
