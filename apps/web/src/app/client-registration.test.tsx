import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeClientRegistrationStatus, NativeDesktopBridge } from '@/lib/nativeDesktop'
import { ClientRegistrationNotice } from './ClientRegistrationNotice'
import { ClientRegistration, clientRegistration } from './client-registration'
import { enableNativeHosting, pairNativeDesktop } from './native-pairing'
import type { Trpc } from './trpc'

const desktop = window as typeof window & {
  __PODIUM_DESKTOP__?: NativeDesktopBridge
  __PODIUM_RESTART__?: () => Promise<void>
}

function setup(
  status: NativeClientRegistrationStatus = { state: 'needed', target: 'native-receipt' },
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

  it('keeps explicit hosting working for an enrolled client through the existing assignment API', async () => {
    const fixture = setup({ state: 'enrolled' })
    const assignment = vi.fn(async () => {
      fixture.events.push('assignment')
    })
    fixture.trpc.machines.setAssignment = {
      mutate: assignment,
    } as unknown as Trpc['machines']['setAssignment']
    fixture.bridge.machineId = 'existing-machine' as NativeDesktopBridge['machineId']
    fixture.bridge.enableHosting = vi.fn(async () => {
      fixture.events.push('hosting')
    })
    await expect(enableNativeHosting(fixture.trpc, fixture.bridge)).rejects.toThrow(
      'quit and reopen',
    )
    expect(assignment).toHaveBeenCalledExactlyOnceWith({
      id: 'existing-machine',
      assignment: { server: false, agentExecution: true },
      requestId: expect.any(String),
    })
    expect(fixture.bridge.enableHosting).toHaveBeenCalledExactlyOnceWith()
    expect(fixture.mint).not.toHaveBeenCalled()
    expect(fixture.events).toEqual(['assignment', 'hosting', 'restart'])
  })

  it('retains the code handoff for an older shell explicitly enabling hosting', async () => {
    const fixture = setup()
    delete fixture.bridge.clientRegistrationStatus
    fixture.bridge.enableHosting = fixture.save
    await expect(enableNativeHosting(fixture.trpc, fixture.bridge)).rejects.toThrow(
      'Hosting enabled',
    )
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith('ABCD-EFGH')
    expect(fixture.events).toEqual(['mint', 'save', 'restart'])
  })
})
