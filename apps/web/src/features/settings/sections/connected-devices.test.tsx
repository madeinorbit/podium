import type {
  MobileClientSession,
  MobilePairStartResponse,
  MobilePairStatusResponse,
} from '@podium/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConnectedDevicesSection,
  createMobilePairingApi,
  type MobilePairingApi,
  mobileServerUrl,
} from './connected-devices'

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <span data-testid="pairing-qr" data-value={value} />,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const HTTPS_TRANSPORT = {
  grade: 'https',
  title: 'Server says HTTPS is ready',
  guidance: 'Use this exact server-provided HTTPS guidance.',
} as const

function pairStart(overrides: Partial<Extract<MobilePairStartResponse, { mode: 'pair' }>> = {}) {
  const fixture = {
    mode: 'pair',
    pairingId: 'request-safe-id',
    envelope: 'ephemeral-envelope',
    pairingUrl: 'https://canonical.example/mobile#pair=ephemeral-envelope',
    canonicalOrigin: 'https://canonical.example',
    transport: HTTPS_TRANSPORT,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    instanceId: 'podium-instance',
    ...overrides,
  } satisfies MobilePairStartResponse
  return fixture
}

function openStart(overrides: Partial<Extract<MobilePairStartResponse, { mode: 'open' }>> = {}) {
  const fixture = {
    mode: 'open',
    mobileUrl: 'http://open.example/mobile',
    canonicalOrigin: 'http://open.example',
    transport: {
      grade: 'insecure',
      title: 'Open server on HTTP',
      guidance: 'This URL is allowed only because the server has no login.',
    },
    instanceId: 'open-instance',
    ...overrides,
  } satisfies MobilePairStartResponse
  return fixture
}

function pendingStatus(): MobilePairStatusResponse {
  return {
    state: 'pending',
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  } satisfies MobilePairStatusResponse
}

function claimedStatus(): MobilePairStatusResponse {
  return {
    state: 'claimed',
    deviceId: 'device-safe-id',
    deviceName: 'Sam’s iPhone',
    platform: 'ios',
    delivery: 'native',
    phrase: ['velvet', 'orbit', 'pine'],
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  } satisfies MobilePairStatusResponse
}

function mobileSession(overrides: Partial<MobileClientSession> = {}): MobileClientSession {
  return {
    sessionId: 'a'.repeat(24),
    userId: 'user-one',
    label: 'mobile',
    deviceId: 'device-one',
    deviceName: 'Travel phone',
    platform: 'android',
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    current: false,
    ...overrides,
  }
}

function pairingApi(start: MobilePairStartResponse = pairStart()): MobilePairingApi {
  return {
    auth: {
      mobilePairingStart: { mutate: vi.fn().mockResolvedValue(start) },
      mobilePairingStatus: { query: vi.fn().mockResolvedValue(pendingStatus()) },
      mobilePairingApprove: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      mobilePairingDeny: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      mobileSessions: { query: vi.fn().mockResolvedValue([]) },
      revokeMobileSession: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
    },
  } satisfies MobilePairingApi
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('mobile pairing REST adapter', () => {
  it('parses the current start contract and binds the reviewed REST paths', async () => {
    const start = pairStart()
    const sessions = [mobileSession()]
    const responses = [start, pendingStatus(), { sessions }, { ok: true }]
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(responses.shift())))
    vi.stubGlobal('fetch', fetchMock)
    const api = createMobilePairingApi('https://podium.example')

    await api.auth.mobilePairingStart.mutate()
    await api.auth.mobilePairingStatus.query({ pairingId: start.pairingId })
    await api.auth.mobileSessions.query()
    await api.auth.revokeMobileSession.mutate({ sessionId: sessions[0]!.sessionId })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://podium.example/auth/mobile-pair/start',
      'https://podium.example/auth/mobile-pair/status',
      'https://podium.example/auth/client-sessions',
      'https://podium.example/auth/client-sessions/revoke',
    ])
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.credentials).toBe('include')
      expect(init?.referrerPolicy).toBe('no-referrer')
    }
  })

  it('omits legacy rows that have no valid public revocation id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          sessions: [
            mobileSession({ sessionId: '' }),
            mobileSession({ sessionId: 'b'.repeat(24) }),
          ],
        }),
      ),
    )

    const sessions =
      await createMobilePairingApi('https://podium.example').auth.mobileSessions.query()

    expect(sessions.map((session) => session.sessionId)).toEqual(['b'.repeat(24)])
  })
})

describe('ConnectedDevicesSection', () => {
  it('uses the server canonical origin and readiness for the credential QR', async () => {
    const api = pairingApi()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    render(<ConnectedDevicesSection api={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }))

    const qr = await screen.findByTestId('pairing-qr')
    expect(qr.getAttribute('data-value')).toBe(
      'https://canonical.example/mobile#pair=ephemeral-envelope',
    )
    expect(screen.getByText('https://canonical.example')).toBeTruthy()
    expect(screen.getByText(HTTPS_TRANSPORT.title)).toBeTruthy()
    expect(screen.getByText(HTTPS_TRANSPORT.guidance)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'https://canonical.example/mobile#pair=ephemeral-envelope',
      ),
    )
    expect(await screen.findByText(/temporary pairing secret copied/i)).toBeTruthy()
  })

  it('renders the exact current open response as a URL-only QR', async () => {
    const api = pairingApi(openStart())

    render(<ConnectedDevicesSection api={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }))

    const qr = await screen.findByTestId('pairing-qr')
    expect(qr.getAttribute('data-value')).toBe('http://open.example/mobile')
    expect(screen.getByText('Open server on HTTP')).toBeTruthy()
    expect(screen.getByText(/contains only its mobile URL/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve phone' })).toBeNull()
    expect(api.auth.mobilePairingStatus.query).not.toHaveBeenCalled()
  })

  it('shows the requesting device, accessible phrase, announcement, and focus', async () => {
    const api = pairingApi()
    vi.mocked(api.auth.mobilePairingStatus.query).mockResolvedValue(claimedStatus())

    render(<ConnectedDevicesSection api={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }))

    expect(await screen.findByText('Sam’s iPhone wants to connect')).toBeTruthy()
    expect(
      screen.getByRole('group', { name: 'Verification phrase: velvet orbit pine' }),
    ).toBeTruthy()
    expect(
      screen.getByText(/Sam’s iPhone wants to connect. Verification phrase: velvet orbit pine./),
    ).toBeTruthy()
    const flowRegion = screen.getByRole('region', { name: 'Phone pairing status' })
    await waitFor(() => expect(document.activeElement).toBe(flowRegion))

    fireEvent.click(screen.getByRole('button', { name: 'Approve phone' }))
    expect(await screen.findByText('Phone approved')).toBeTruthy()
    expect(api.auth.mobilePairingApprove.mutate).toHaveBeenCalledWith({
      pairingId: 'request-safe-id',
    })
  })

  it('keeps polling a claimed grant and recovers from expiry or restart', async () => {
    const api = pairingApi()
    vi.mocked(api.auth.mobilePairingStatus.query)
      .mockResolvedValueOnce(claimedStatus())
      .mockResolvedValue({ state: 'expired' } satisfies MobilePairStatusResponse)

    render(<ConnectedDevicesSection api={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }))

    expect(await screen.findByText('Pairing code expired')).toBeTruthy()
    expect(screen.getByText(/timed out or been cleared by a server restart/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create a new code' })).toBeTruthy()
  })

  it('clears the temporary link from local UI state after a phone claims it', async () => {
    const api = pairingApi()
    vi.mocked(api.auth.mobilePairingStatus.query).mockResolvedValue(claimedStatus())

    render(<ConnectedDevicesSection api={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }))

    expect(await screen.findByText('Sam’s iPhone wants to connect')).toBeTruthy()
    expect(screen.queryByTestId('pairing-qr')).toBeNull()
    expect(screen.queryByText(/ephemeral-envelope/)).toBeNull()
  })

  it.each([
    [409, /Set the address this phone can reach/],
    [400, /works only over trusted HTTPS/],
    [401, /sign-in is no longer authorized/],
  ] as const)('maps start HTTP %s to safe actionable copy', async (status, expected) => {
    const openNetwork = vi.fn()
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/auth/client-sessions'))
        return Promise.resolve(jsonResponse({ sessions: [] }))
      return Promise.resolve(jsonResponse({ error: 'pairCode=do-not-render-this' }, status))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ConnectedDevicesSection
        api={createMobilePairingApi('https://podium.example')}
        onOpenNetwork={openNetwork}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }))

    expect(await screen.findByText(expected)).toBeTruthy()
    expect(screen.getAllByText(expected)).toHaveLength(1)
    expect(screen.queryByText(/do-not-render-this/i)).toBeNull()
    if (status === 400 || status === 409) {
      expect(screen.queryByRole('button', { name: /new code|try again/i })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Open Network settings' }))
      expect(openNetwork).toHaveBeenCalledOnce()
    } else {
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Open Network settings' })).toBeNull()
    }
  })

  it('distinguishes a network failure without reflecting arbitrary error text', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/auth/client-sessions')) {
        return Promise.resolve(jsonResponse({ sessions: [] }))
      }
      return Promise.reject(new TypeError('pairCode=do-not-render-this'))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ConnectedDevicesSection api={createMobilePairingApi('https://podium.example')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }))

    expect(await screen.findByText(/Couldn’t reach this server/)).toBeTruthy()
    expect(screen.getAllByText(/Couldn’t reach this server/)).toHaveLength(1)
    expect(screen.queryByText(/do-not-render-this/i)).toBeNull()
  })

  it('classifies malformed server URLs as invalid responses, not network failures', async () => {
    const api = pairingApi(
      pairStart({
        pairingUrl: 'not a URL',
      }),
    )

    render(<ConnectedDevicesSection api={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }))

    expect(await screen.findByText(/unexpected pairing response/i)).toBeTruthy()
    expect(screen.queryByText(/Couldn’t reach this server/)).toBeNull()
  })

  it('refuses a credential-bearing HTTP QR even when the typed payload is otherwise complete', async () => {
    const api = pairingApi(
      pairStart({
        pairingUrl: 'http://canonical.example/mobile#pair=ephemeral-envelope',
      }),
    )

    render(<ConnectedDevicesSection api={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }))

    expect(await screen.findByText(/unexpected pairing response/i)).toBeTruthy()
    expect(screen.queryByTestId('pairing-qr')).toBeNull()
  })

  it('reports a successful open-tab request without weakening noopener', async () => {
    const open = vi.fn().mockReturnValue(null)
    vi.stubGlobal('open', open)
    render(<ConnectedDevicesSection api={pairingApi(openStart())} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open on this device' }))

    expect(open).toHaveBeenCalledWith('http://open.example/mobile', '_blank', 'noopener,noreferrer')
    expect(screen.getByText('Opened the mobile page in a new tab.')).toBeTruthy()
  })

  it('cancels explicitly and best-effort denies an active grant on exit', async () => {
    const explicitApi = pairingApi()
    const { unmount } = render(<ConnectedDevicesSection api={explicitApi} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel code' }))
    expect(await screen.findByText('Request denied')).toBeTruthy()
    expect(explicitApi.auth.mobilePairingDeny.mutate).toHaveBeenCalledWith({
      pairingId: 'request-safe-id',
    })
    unmount()

    const exitApi = pairingApi()
    const mounted = render(<ConnectedDevicesSection api={exitApi} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }))
    await screen.findByTestId('pairing-qr')
    mounted.unmount()
    expect(exitApi.auth.mobilePairingDeny.mutate).toHaveBeenCalledWith({
      pairingId: 'request-safe-id',
    })
  })

  it('badges the current session, warns about self-revoke, and moves focus', async () => {
    const api = pairingApi()
    vi.mocked(api.auth.mobileSessions.query).mockResolvedValue([
      mobileSession({ current: true, deviceName: 'This browser phone' }),
    ])

    render(<ConnectedDevicesSection api={api} />)
    expect(await screen.findByText('This browser phone')).toBeTruthy()
    expect(screen.getByText('This device')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    const confirmation = screen.getByRole('group', {
      name: 'Confirm revoking This browser phone',
    })
    expect(screen.getByText(/this browser will be signed out immediately/i)).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(confirmation))
  })

  it('ignores a stale session load after a newer request has settled', async () => {
    let resolveStale: ((sessions: MobileClientSession[]) => void) | undefined
    const staleApi = pairingApi()
    vi.mocked(staleApi.auth.mobileSessions.query).mockReturnValue(
      new Promise((resolve) => {
        resolveStale = resolve
      }),
    )
    const currentApi = pairingApi()
    vi.mocked(currentApi.auth.mobileSessions.query).mockResolvedValue([])

    const view = render(<ConnectedDevicesSection api={staleApi} />)
    view.rerender(<ConnectedDevicesSection api={currentApi} />)
    expect(await screen.findByText('No mobile devices are connected to your account.')).toBeTruthy()

    await act(async () => {
      resolveStale?.([mobileSession()])
      await Promise.resolve()
    })
    expect(screen.queryByText('Travel phone')).toBeNull()
  })

  it('remotely revokes only the selected device', async () => {
    const api = pairingApi()
    const travelId = 'a'.repeat(24)
    const workId = 'b'.repeat(24)
    vi.mocked(api.auth.mobileSessions.query).mockResolvedValue([
      mobileSession({ sessionId: travelId }),
      mobileSession({
        sessionId: workId,
        deviceId: 'device-two',
        deviceName: 'Work phone',
        platform: 'ios',
        current: false,
      }),
    ])

    render(<ConnectedDevicesSection api={api} />)
    expect(await screen.findByText('Travel phone')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke device' }))

    await waitFor(() => expect(screen.queryByText('Travel phone')).toBeNull())
    expect(screen.getByText('Work phone')).toBeTruthy()
    expect(api.auth.revokeMobileSession.mutate).toHaveBeenCalledWith({ sessionId: travelId })
  })
})

describe('mobileServerUrl', () => {
  it('keeps open mode URL-only even if the input carried navigation state', () => {
    expect(mobileServerUrl('https://podium.example?source=test#old')).toBe(
      'https://podium.example/mobile',
    )
  })
})
