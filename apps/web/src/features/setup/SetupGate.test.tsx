import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WIRE_VERSION } from '@podium/protocol'

const connect = vi.hoisted(() => vi.fn().mockResolvedValue({ mode: 'all-in-one' }))

vi.mock('@/app/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/trpc')>()
  return {
    ...actual,
    makeTrpc: () => ({ setup: { connect: { mutate: connect } } }),
  }
})

import {
  classifySetupStatus,
  isTrustedLocalSetupOrigin,
  SetupGate,
  shouldApplyLocalSetupDefault,
} from './SetupGate'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.clear()
  ;(globalThis as { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = undefined
  ;(globalThis as { __PODIUM_LOCAL_SETUP__?: boolean }).__PODIUM_LOCAL_SETUP__ = undefined
  ;(globalThis as { __PODIUM_LOCAL_BUILD__?: unknown }).__PODIUM_LOCAL_BUILD__ = undefined
  connect.mockClear()
})

const child = <div>APP-READY</div>

/** The durable evidence a device has synced before: one principal namespace marker,
 *  written at the address `preparePrincipalNamespace` uses (spelled out here so a
 *  change to that address has to be a deliberate one). */
function seedSyncedReplica(principal: string): void {
  localStorage.setItem(
    `podium.kernel-replica.principal.${encodeURIComponent(principal)}.namespace.v1`,
    JSON.stringify({ principal, lastUsedAt: Date.now() }),
  )
}

/** What the desktop shell injects into a local document: the build that last owned this
 *  device's data (bootstrap::local_build_injection_script). */
function stubShellLocalBuild(stamp: Record<string, unknown>): void {
  ;(globalThis as { __PODIUM_LOCAL_BUILD__?: unknown }).__PODIUM_LOCAL_BUILD__ = stamp
}

/** Drive the bounded backoff to exhaustion. */
async function exhaustRetries(): Promise<void> {
  for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(4000)
}

describe('SetupGate', () => {
  it('starts version and setup together, but waits for version before revealing the app', async () => {
    /**
     * THREE PROBES, AND `/version` IS ASKED TWICE ON PURPOSE.
     *
     * This test was written against a boot that probed twice. The gate now also
     * starts the served-assets check beside the handshake (POD-2721): the wire
     * version can match perfectly while the served website has been swapped out
     * from under this page, and a tab restored from the back-forward cache boots
     * against whatever the server happens to be serving now. That check asks
     * `/version` as well, is deliberately unawaited, and only ever raises a
     * banner — it never reloads and it cannot divert this gate.
     *
     * So the two `/version` resolvers are kept APART rather than sharing one
     * variable. That is the load-bearing part: what un-gates the app must be the
     * HANDSHAKE answering, not the assets probe. Collapsing them would let this
     * test pass while the gate revealed the app on the wrong answer.
     */
    const versionResolvers: Array<(response: Response) => void> = []
    let resolveSetup: (response: Response) => void = () => {}
    const order: string[] = []
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://podium.test').pathname
      order.push(path)
      if (path === '/version') {
        return new Promise<Response>((resolve) => {
          versionResolvers.push(resolve)
        })
      }
      if (path === '/setup/config') {
        return new Promise<Response>((resolve) => {
          resolveSetup = resolve
        })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SetupGate>{child}</SetupGate>)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(order).toEqual(['/version', '/setup/config', '/version'])

    resolveSetup(
      new Response(JSON.stringify({ needsSetup: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await Promise.resolve()
    expect(screen.queryByText('APP-READY')).toBeNull()

    // The HANDSHAKE's own probe — the first — is what un-gates the app. The
    // assets probe's copy is left pending deliberately: it is unawaited in the
    // gate, and nothing here should depend on it answering.
    versionResolvers[0]!(
      new Response('<!doctype html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('trusts only loopback and bundled desktop origins for automatic local setup', () => {
    expect(isTrustedLocalSetupOrigin({ protocol: 'http:', hostname: 'localhost' })).toBe(true)
    expect(isTrustedLocalSetupOrigin({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(true)
    expect(isTrustedLocalSetupOrigin({ protocol: 'http:', hostname: '[::1]' })).toBe(true)
    expect(isTrustedLocalSetupOrigin({ protocol: 'tauri:', hostname: 'tauri.localhost' })).toBe(
      true,
    )
    expect(isTrustedLocalSetupOrigin({ protocol: 'https:', hostname: 'podium.example' })).toBe(
      false,
    )
    expect(
      shouldApplyLocalSetupDefault(
        { needsSetup: true },
        { protocol: 'https:', hostname: 'podium.example' },
        false,
        true,
      ),
    ).toBe(false)
  })

  it('uses only public readiness for a ready remote desktop client', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: 'ready', reason: null, dataPlane: 'available' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/readiness$/)
  })

  it('directs an unconfigured remote desktop client back to its host without mutations', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        state: 'unconfigured',
        reason: 'setup_required',
        dataPlane: 'blocked',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
    render(<SetupGate>{child}</SetupGate>)

    expect(await screen.findByText(/finish setup on the server/i)).toBeTruthy()
    expect(screen.queryByText('APP-READY')).toBeNull()
    expect(connect).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/readiness$/)
  })

  it('keeps compatibility with a remote server that predates public readiness', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('CORS unavailable')))
    ;(globalThis as { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
    render(<SetupGate>{child}</SetupGate>)

    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('shows onboarding when the backend reports needsSetup', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ status: 200, ok: true, json: async () => ({ needsSetup: true }) }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText(/welcome to podium/i)).toBeTruthy()
    expect(screen.queryByText('APP-READY')).toBeNull()
  })

  it('sends an unconfigured remote browser to the host without exposing mutations', () => {
    expect(
      classifySetupStatus(
        {
          needsSetup: true,
          state: 'unconfigured',
          reason: 'setup_required',
          dataPlane: 'blocked',
        },
        { protocol: 'https:', hostname: 'podium.example' },
      ),
    ).toBe('remote-setup')
  })

  it('renders activation pending as restart-only and never reconnects setup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => ({
          needsSetup: true,
          state: 'activation_pending',
          reason: 'restart_required',
          dataPlane: 'blocked',
        }),
      }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText(/setup is saved; podium needs to restart/i)).toBeTruthy()
    expect(connect).not.toHaveBeenCalled()
  })

  it('carries the stale setting from the readiness probe onto the screen [POD-2766]', async () => {
    // The gate is the only thing that can: the data plane is blocked, so the
    // screen behind it cannot ask the server anything itself. If the gate drops
    // `stale` on the floor the screen falls back to "something changed" and the
    // operator is left guessing which of their changes did this.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => ({
          needsSetup: true,
          state: 'activation_pending',
          reason: 'restart_required',
          dataPlane: 'blocked',
          controlPlane: 'available',
          stale: ['persistence'],
        }),
      }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText(/how podium is kept running/i)).toBeTruthy()
  })

  it('renders the app for degraded readiness because the data plane is available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => ({
          needsSetup: false,
          state: 'degraded',
          reason: 'agent_unavailable',
          dataPlane: 'available',
        }),
      }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('applies a source launcher local default before entering the app', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'X-Podium-Local-Setup': 'all-in-one' }),
        json: async () => ({ needsSetup: true }),
      }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText(/starting podium on this machine/i)).toBeTruthy()
    expect(screen.queryByText(/how should this install run/i)).toBeNull()
    expect(connect).toHaveBeenCalledWith({ mode: 'all-in-one' })
  })

  it('renders the app when setup is already done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ needsSetup: false }),
      }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('treats a 404 (backend without the setup route) as ready, not a block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 404, ok: false, json: async () => ({}) }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('treats a 200 that is not JSON (SPA index.html fallback) as ready, not unreachable', async () => {
    // A relay without the setup route serves the SPA HTML for /setup/config — res.json() throws.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON')
        },
      }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('treats a 200 with an unexpected JSON shape as ready, not a block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ unrelated: 1 }) }),
    )
    render(<SetupGate>{child}</SetupGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('surfaces an error (not the app) when the backend is unreachable', async () => {
    vi.useFakeTimers()
    // Reject every probe — the cross-origin/CORS-blocked case that used to silently skip onboarding.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    render(<SetupGate>{child}</SetupGate>)
    // Drive all bounded-backoff retries to exhaustion.
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByRole('heading', { name: /the backend went quiet/i })).toBeTruthy()
    expect(screen.getByText('podium status')).toBeTruthy()
    expect(screen.getByRole('button', { name: /retry connection/i })).toBeTruthy()
    expect(screen.queryByText('APP-READY')).toBeNull()
  })

  it('restarts the setup probe when the recovery console retries', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    render(<SetupGate>{child}</SetupGate>)
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(4000)

    screen.getByRole('button', { name: /retry connection/i }).click()
    await vi.advanceTimersByTimeAsync(1)

    expect(fetchMock.mock.calls.length).toBeGreaterThan(7)
  })

  it('renders the cached app when the backend is unreachable but this device has synced', async () => {
    vi.useFakeTimers()
    seedSyncedReplica('user-1')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    render(<SetupGate>{child}</SetupGate>)
    await exhaustRetries()

    expect(screen.getByText('APP-READY')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /the backend went quiet/i })).toBeNull()
  })

  it('refuses to run a built-in UI older than the data on this device', async () => {
    // The baked-fallback stale guard (spec §2.1, durability layer 3). The shell fell back to
    // the UI inside the .app, nothing is answering, and that copy predates the build that last
    // wrote this box's replica — so it must not open the workspace, cached or not.
    vi.useFakeTimers()
    seedSyncedReplica('user-1')
    stubShellLocalBuild({ wireVersion: WIRE_VERSION + 1, appVersion: '9.9.9' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    render(<SetupGate>{child}</SetupGate>)
    await exhaustRetries()

    expect(screen.getByRole('heading', { name: /too old to open your work/i })).toBeTruthy()
    expect(screen.getByText(/9\.9\.9/)).toBeTruthy()
    expect(screen.queryByText('APP-READY')).toBeNull()
    expect(screen.queryByRole('heading', { name: /the backend went quiet/i })).toBeNull()
  })

  it('leaves a reachable server to its own handshake, however old this build is', async () => {
    // The guard answers one question — "no server AND the UI is older than the data". With a
    // server answering, the wire-version handshake in version-guard.ts is better informed and
    // owns the outcome; blocking here would ground a device that can fix itself.
    vi.useFakeTimers()
    stubShellLocalBuild({ wireVersion: WIRE_VERSION + 1, appVersion: '9.9.9' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({}) }),
    )
    render(<SetupGate>{child}</SetupGate>)
    await exhaustRetries()

    expect(screen.getByText('APP-READY')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /too old to open your work/i })).toBeNull()
  })

  it('does not treat a namespace created during this boot as an offline replica', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    render(<SetupGate>{child}</SetupGate>)

    // The replica open now runs beside this gate and creates its namespace early.
    // That marker cannot prove the device completed an earlier sync.
    seedSyncedReplica('user-1')
    await exhaustRetries()

    expect(screen.getByRole('heading', { name: /the backend went quiet/i })).toBeTruthy()
    expect(screen.queryByText('APP-READY')).toBeNull()

    // Retrying must keep the mount-time evidence. The new namespace still belongs to this boot.
    screen.getByRole('button', { name: /retry connection/i }).click()
    await exhaustRetries()

    expect(screen.getByRole('heading', { name: /the backend went quiet/i })).toBeTruthy()
    expect(screen.queryByText('APP-READY')).toBeNull()
  })

  it('keeps the recovery console when the device holds more than one principal', async () => {
    // The replica gate refuses to pick a slice owner offline when two are retained,
    // so falling through here would only trade this screen for its fatal one.
    vi.useFakeTimers()
    seedSyncedReplica('user-1')
    seedSyncedReplica('user-2')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    render(<SetupGate>{child}</SetupGate>)
    await exhaustRetries()

    expect(screen.getByRole('heading', { name: /the backend went quiet/i })).toBeTruthy()
    expect(screen.queryByText('APP-READY')).toBeNull()
  })

  it('keeps probing after the offline fall-through, and honours a backend that needs setup', async () => {
    vi.useFakeTimers()
    seedSyncedReplica('user-1')
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    render(<SetupGate>{child}</SetupGate>)
    await exhaustRetries()
    expect(screen.getByText('APP-READY')).toBeTruthy()

    fetchMock.mockResolvedValue({ status: 200, ok: true, json: async () => ({ needsSetup: true }) })
    await vi.advanceTimersByTimeAsync(20_000)
    await vi.advanceTimersByTimeAsync(1)

    expect(screen.getByText(/welcome to podium/i)).toBeTruthy()
  })

  it('recovers on its own when the network returns while the recovery console is up', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    render(<SetupGate>{child}</SetupGate>)
    await exhaustRetries()
    expect(screen.getByRole('heading', { name: /the backend went quiet/i })).toBeTruthy()

    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ needsSetup: false }),
    })
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)

    // Only 2ms of clock has passed since the event: far too little for the
    // periodic poll, so this recovery is the listener's doing.
    expect(screen.getByText('APP-READY')).toBeTruthy()
  })

  it('keeps retrying on a timer while the recovery console is up', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    render(<SetupGate>{child}</SetupGate>)
    await exhaustRetries()
    expect(screen.getByRole('heading', { name: /the backend went quiet/i })).toBeTruthy()

    // No 'online' event: a server that came back behind a healthy network is the
    // case the browser never announces.
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ needsSetup: false }),
    })
    await vi.advanceTimersByTimeAsync(20_000)

    expect(screen.getByText('APP-READY')).toBeTruthy()
  })
})
