import { wireSchemaDigest } from '@podium/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type UpdateFleetState, type UpdateStateResult, useUpdateState } from './use-update-state'

const mocks = vi.hoisted(() => ({
  makeTrpc: vi.fn(),
  mutate: vi.fn(),
  repair: vi.fn(),
  query: vi.fn(),
}))

vi.mock('@/app/trpc', () => ({ makeTrpc: mocks.makeTrpc }))

const target = {
  version: '0.4.2',
  critical: false,
  artifacts: {},
}
const reloadAction = vi.fn()

function Probe({
  onResult,
  withReload = false,
  liveFleet = false,
  fleet,
}: {
  onResult: (result: UpdateStateResult) => void
  withReload?: boolean
  liveFleet?: boolean
  fleet?: UpdateFleetState
}) {
  const result = useUpdateState({
    httpOrigin: 'http://podium.test',
    needRefresh: false,
    ...(fleet
      ? { fleet }
      : liveFleet
        ? {}
        : { fleet: { total: 1, behind: 1, converging: 0, failed: 0 } }),
    reload: withReload ? reloadAction : undefined,
  })
  useEffect(() => {
    onResult(result)
  }, [onResult, result])
  return (
    <>
      {result.actions.startUpdate && (
        <button type="button" onClick={() => void result.actions.startUpdate?.()}>
          update Podium
        </button>
      )}
      {result.actions.repairCompatibility && (
        <button type="button" onClick={() => void result.actions.repairCompatibility?.()}>
          repair and reload
        </button>
      )}
      <output data-testid="view-state">
        {result.view.state === 'failed'
          ? [result.view.message, result.view.guidance, result.view.diagnostic].join('|')
          : result.view.state === 'in-progress'
            ? `${result.view.state}:${result.view.version}:${result.view.done}:${result.view.total}`
            : result.view.state}
      </output>
      {result.actions.installApp && <span>install action</span>}
      {result.actions.reload && <span>reload action</span>}
    </>
  )
}

function setPageVersion(version: string): void {
  document.head.querySelector('meta[name="podium-version"]')?.remove()
  const meta = document.createElement('meta')
  meta.setAttribute('name', 'podium-version')
  meta.setAttribute('content', version)
  document.head.append(meta)
}

afterEach(() => {
  cleanup()
  document.head.querySelector('meta[name="podium-version"]')?.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__
})

function setupTransport(
  version: { appVersion: string; target?: typeof target } = { appVersion: '0.4.1', target },
): void {
  mocks.makeTrpc.mockReturnValue({
    setup: { channel: { query: vi.fn(async () => 'stable') } },
    updates: {
      fleet: { query: mocks.query },
      converge: { mutate: mocks.mutate },
      repairCompatibility: { mutate: mocks.repair },
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url.endsWith('/version') ? version : { appVersion: '0.4.1' }),
    })),
  )
}

describe('useUpdateState update action', () => {
  it('surfaces a background preparation failure instead of hanging near completion', async () => {
    setupTransport()
    let calls = 0
    mocks.query.mockImplementation(async () => {
      calls += 1
      return calls === 1
        ? { total: 1, behind: 1, converging: 0, failed: 0, targetVersion: '0.4.2' }
        : {
            total: 1,
            behind: 0,
            converging: 0,
            failed: 0,
            targetVersion: '0.4.2',
            preparation: {
              webReady: false,
              bundleReady: false,
              failureDetail: 'The website could not be rebuilt. See the server log.',
            },
          }
    })
    mocks.mutate.mockResolvedValue({
      state: 'in-progress',
      version: '0.4.2',
      done: 0,
      total: 3,
      includesBundle: true,
      fleet: { total: 1, behind: 1, converging: 0, failed: 0, targetVersion: '0.4.2' },
    })

    const results: UpdateStateResult[] = []
    render(<Probe onResult={(result) => results.push(result)} liveFleet />)
    const update = await screen.findByRole('button', { name: /update Podium/i })
    update.click()

    await waitFor(() => expect(results.at(-1)?.view.state).toBe('failed'))
    expect(screen.getByTestId('view-state').textContent).toContain(
      'The website could not be rebuilt. See the server log.',
    )
  })

  it('does not count development packaging before the server reports it ready', async () => {
    setupTransport()
    mocks.query.mockResolvedValue({
      total: 0,
      behind: 0,
      converging: 0,
      failed: 0,
      targetVersion: '0.4.2',
      preparation: { webReady: true, bundleReady: false },
    })
    mocks.mutate.mockResolvedValue({
      state: 'in-progress',
      version: '0.4.2',
      done: 0,
      total: 2,
      includesBundle: true,
      fleet: { total: 0, behind: 0, converging: 0, failed: 0, targetVersion: '0.4.2' },
    })

    const results: UpdateStateResult[] = []
    render(<Probe onResult={(result) => results.push(result)} liveFleet />)
    const update = await screen.findByRole('button', { name: /update Podium/i })
    update.click()

    await waitFor(() =>
      expect(
        results.some(
          (result) =>
            result.view.state === 'in-progress' &&
            result.view.total === 2 &&
            result.view.done === 0,
        ),
      ).toBe(true),
    )
  })

  it('moves the shared dialog to in-progress after a successful convergence call', async () => {
    setupTransport()
    mocks.mutate.mockResolvedValue({
      state: 'in-progress',
      version: '0.4.2',
      done: 0,
      total: 2,
      fleet: { total: 1, behind: 1, converging: 1, failed: 0, targetVersion: '0.4.2' },
    })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /update Podium/i })).toBeTruthy())

    screen.getByRole('button', { name: /update Podium/i }).click()
    await waitFor(() =>
      expect(screen.getByTestId('view-state').textContent).toContain('in-progress'),
    )

    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    expect(results.at(-1)?.view).toMatchObject({
      state: 'in-progress',
      version: '0.4.2',
      done: 0,
      total: 2,
    })
  })

  it('offers Update and reloads when the server is current but the web stamp SHA is old', async () => {
    let rebuilt = false
    mocks.mutate.mockImplementation(async () => {
      rebuilt = true
      return {
        state: 'in-progress',
        version: 'dev+abc1234',
        done: 0,
        total: 1,
        fleet: { total: 0, behind: 0, converging: 0, failed: 0, machines: [] },
      }
    })
    mocks.makeTrpc.mockReturnValue({
      setup: { channel: { query: vi.fn(async () => ({ channel: 'dev' })) } },
      updates: {
        fleet: {
          query: vi.fn(async () => ({
            total: 0,
            behind: 0,
            converging: 0,
            failed: 0,
            machines: [],
          })),
        },
        converge: { mutate: mocks.mutate },
        repairCompatibility: { mutate: mocks.repair },
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.endsWith('/version')
            ? {
                appVersion: 'dev+abc1234',
                wireSchemaDigest: wireSchemaDigest(),
                target: {
                  version: 'dev+abc1234',
                  critical: false,
                  artifacts: { web: { digest: 'abc1234' } },
                },
              }
            : {
                appVersion: rebuilt ? 'dev+abc1234' : 'dev+old1234',
                sourceSha: rebuilt ? 'abc1234' : 'old1234',
                wireSchemaDigest: wireSchemaDigest(),
              },
      })),
    )

    render(<Probe onResult={() => {}} withReload liveFleet />)
    const update = await screen.findByRole('button', { name: /update Podium/i })
    expect(screen.queryByRole('button', { name: /repair and reload/i })).toBeNull()
    update.click()
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce())
    await waitFor(() => expect(reloadAction).toHaveBeenCalledOnce())
  })

  /**
   * POD-1980. The desktop half of the website can be fresh while the phone
   * export is weeks old — one `podium-web` run builds both, and a failed or
   * skipped export leaves only the phone behind. Nothing on this page can see
   * that, so the server says it on `/version` and the dialog acts on it.
   */
  it('offers Update when only the phone export is behind, and waits for it before reloading', async () => {
    let rebuilt = false
    mocks.mutate.mockImplementation(async () => {
      rebuilt = true
      return {
        state: 'in-progress',
        version: 'dev+abc1234',
        done: 0,
        total: 1,
        fleet: { total: 0, behind: 0, converging: 0, failed: 0, machines: [] },
      }
    })
    mocks.makeTrpc.mockReturnValue({
      setup: { channel: { query: vi.fn(async () => ({ channel: 'dev' })) } },
      updates: {
        fleet: {
          query: vi.fn(async () => ({
            total: 0,
            behind: 0,
            converging: 0,
            failed: 0,
            machines: [],
          })),
        },
        converge: { mutate: mocks.mutate },
        repairCompatibility: { mutate: mocks.repair },
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.endsWith('/version')
            ? {
                appVersion: 'dev+abc1234',
                wireSchemaDigest: wireSchemaDigest(),
                target: {
                  version: 'dev+abc1234',
                  critical: false,
                  artifacts: { web: { digest: 'abc1234' } },
                },
                // This page's own dist is already current; the phone's is not.
                mobileWeb: { present: true, digest: rebuilt ? 'abc1234' : 'old1234' },
              }
            : {
                appVersion: 'dev+abc1234',
                sourceSha: 'abc1234',
                wireSchemaDigest: wireSchemaDigest(),
              },
      })),
    )

    const results: UpdateStateResult[] = []
    render(<Probe onResult={(result) => results.push(result)} withReload liveFleet />)

    const update = await screen.findByRole('button', { name: /update Podium/i })
    // The dialog must have something to show, or the button has nowhere to live.
    const view = results.at(-1)?.view as { state: string; places?: { kind: string }[] }
    expect(view.state).toBe('available')
    expect(view.places?.map((place) => place.kind)).toContain('phone')

    update.click()
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce())
    await waitFor(() => expect(reloadAction).toHaveBeenCalledOnce())
  })

  it('says nothing when the phone export names the same commit as this page', async () => {
    setupTransport()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.endsWith('/version')
            ? {
                appVersion: 'dev+abc1234',
                wireSchemaDigest: wireSchemaDigest(),
                target: {
                  version: 'dev+abc1234',
                  critical: false,
                  artifacts: { web: { digest: 'abc1234' } },
                },
                mobileWeb: { present: true, digest: 'abc1234' },
              }
            : {
                appVersion: 'dev+abc1234',
                sourceSha: 'abc1234',
                wireSchemaDigest: wireSchemaDigest(),
              },
      })),
    )

    const results: UpdateStateResult[] = []
    render(<Probe onResult={(result) => results.push(result)} withReload liveFleet />)
    await waitFor(() => expect(results.at(-1)?.server.appVersion).toBe('dev+abc1234'))
    expect(screen.queryByRole('button', { name: /update Podium/i })).toBeNull()
    expect(results.at(-1)?.view.state).toBe('none')
  })

  it('repairs and reloads when the source server is current but its web build is incompatible', async () => {
    let rebuilt = false
    mocks.repair.mockImplementation(async () => {
      rebuilt = true
      return { state: 'in-progress', version: 'dev+abc1234' }
    })
    mocks.makeTrpc.mockReturnValue({
      setup: { channel: { query: vi.fn(async () => ({ channel: 'dev' })) } },
      updates: {
        fleet: {
          query: vi.fn(async () => ({
            total: 0,
            behind: 0,
            converging: 0,
            failed: 0,
            machines: [],
          })),
        },
        converge: { mutate: mocks.mutate },
        repairCompatibility: { mutate: mocks.repair },
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.endsWith('/version')
            ? {
                appVersion: 'dev+abc1234',
                wireSchemaDigest: 'server-schema',
                target: { version: 'dev+abc1234', critical: false, artifacts: {} },
              }
            : {
                appVersion: 'dev+abc1234',
                wireSchemaDigest: rebuilt ? 'server-schema' : 'older-web-schema',
              },
      })),
    )

    render(<Probe onResult={() => {}} withReload liveFleet />)
    const repair = await screen.findByRole('button', { name: /repair and reload/i })
    repair.click()
    await waitFor(() => expect(mocks.repair).toHaveBeenCalledOnce())
    await waitFor(() => expect(reloadAction).toHaveBeenCalledOnce())
  })

  it('polls fleet state so progress advances beyond the initial zero', async () => {
    setupTransport()
    let calls = 0
    mocks.query.mockImplementation(async () => {
      calls += 1
      if (calls === 1) return { total: 3, behind: 3, converging: 0, failed: 0 }
      if (calls === 2)
        return { total: 3, behind: 3, converging: 1, failed: 0, targetVersion: '0.4.2' }
      if (calls === 3)
        return { total: 3, behind: 2, converging: 2, failed: 0, targetVersion: '0.4.2' }
      return { total: 3, behind: 0, converging: 0, failed: 0, targetVersion: '0.4.2' }
    })
    mocks.mutate.mockResolvedValue({
      state: 'in-progress',
      version: '0.4.2',
      done: 0,
      total: 4,
      fleet: { total: 3, behind: 3, converging: 3, failed: 0, targetVersion: '0.4.2' },
    })

    const results: UpdateStateResult[] = []
    render(<Probe onResult={(result) => results.push(result)} liveFleet />)
    await waitFor(() => expect(screen.getByRole('button', { name: /update Podium/i })).toBeTruthy())
    screen.getByRole('button', { name: /update Podium/i }).click()

    await waitFor(() => {
      expect(
        results.some(
          (result) =>
            result.view.state === 'in-progress' &&
            result.view.version === '0.4.2' &&
            result.view.done === 1 &&
            result.view.total === 4,
        ),
      ).toBe(true)
    })
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  /**
   * The fleet read used to happen ONCE at mount and swallow its failure, so a
   * read that failed before the session was established (a 401 on the live
   * server) left `behind: 0` for the life of the page — and with it, no server
   * or machine places in the dialog, only "This app". The retry is what makes
   * those places appear at all.
   */
  it('recovers the fleet after a failed first read, so the places appear', async () => {
    vi.useFakeTimers()
    try {
      setupTransport()
      let calls = 0
      mocks.query.mockImplementation(async () => {
        calls += 1
        if (calls === 1) throw new Error('unauthorized')
        return { total: 2, behind: 2, converging: 0, failed: 0, targetVersion: '0.4.2' }
      })

      const results: UpdateStateResult[] = []
      render(<Probe onResult={(result) => results.push(result)} liveFleet />)

      // The first read failed: nothing knows of any machine yet.
      await vi.advanceTimersByTimeAsync(0)
      expect(results.at(-1)?.fleet.behind ?? 0).toBe(0)

      // The idle refresh recovers it without a reload or any user action.
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBeGreaterThanOrEqual(2)
      expect(results.at(-1)?.fleet.behind).toBe(2)

      const view = results.at(-1)?.view
      const places = view && 'places' in view ? view.places.map((place) => place.kind) : []
      expect(places).toContain('machines')
    } finally {
      vi.useRealTimers()
    }
  })

  it('discovers a newly ready target on the idle refresh without reloading', async () => {
    vi.useFakeTimers()
    try {
      mocks.makeTrpc.mockReturnValue({
        setup: { channel: { query: vi.fn(async () => 'stable') } },
        updates: {
          fleet: { query: vi.fn().mockRejectedValue(new Error('unauthorized')) },
          converge: { mutate: mocks.mutate },
        },
      })
      let versionReads = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => ({
          ok: true,
          json: async () => {
            if (!url.endsWith('/version')) return { appVersion: '0.4.1' }
            versionReads += 1
            return versionReads > 2 ? { appVersion: '0.4.1', target } : { appVersion: '0.4.1' }
          },
        })),
      )

      render(<Probe onResult={() => {}} liveFleet />)
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.queryByRole('button', { name: /update Podium/i })).toBeNull()

      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.getByRole('button', { name: /update Podium/i })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves the shared dialog to a translated, actionable server failure', async () => {
    setupTransport()
    mocks.mutate.mockRejectedValueOnce(
      new Error('Unable to connect. Is the computer able to access the url?'),
    )
    mocks.mutate.mockResolvedValueOnce({
      state: 'in-progress',
      version: '0.4.2',
      done: 0,
      total: 2,
      fleet: { total: 1, behind: 1, converging: 1, failed: 0, targetVersion: '0.4.2' },
    })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /update Podium/i })).toBeTruthy())

    screen.getByRole('button', { name: /update Podium/i }).click()
    await waitFor(() => expect(screen.getByTestId('view-state').textContent).toContain('try'))

    expect(results.at(-1)?.view).toEqual({
      state: 'failed',
      message: 'Podium could not reach the update source.',
      guidance: "Check this server's internet connection, then try the update again.",
      diagnostic: 'The update could not be downloaded.',
    })
    expect(screen.getByTestId('view-state').textContent).not.toMatch(/unable to connect|url/i)

    screen.getByRole('button', { name: /update Podium/i }).click()
    await waitFor(() =>
      expect(screen.getByTestId('view-state').textContent).toContain('in-progress'),
    )
    expect(mocks.mutate).toHaveBeenCalledTimes(2)
  })

  it('retains the guarded retry when the server reaches target before the attempt fails', async () => {
    setupTransport()
    const settledFleet: UpdateFleetState = {
      total: 1,
      behind: 1,
      converging: 0,
      failed: 0,
      targetVersion: '0.4.2',
    }
    let queryCalls = 0
    mocks.query.mockImplementation(() => {
      queryCalls += 1
      return Promise.resolve(settledFleet)
    })

    let failAttempt: (() => void) | undefined
    mocks.mutate.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failAttempt = () =>
            reject(new Error('Unable to connect. Is the computer able to access the url?'))
        }),
    )
    mocks.mutate.mockResolvedValueOnce({
      state: 'in-progress',
      version: '0.4.2',
      done: 0,
      total: 2,
      fleet: { ...settledFleet, converging: 1, failed: 0 },
    })

    let versionReads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.endsWith('/version')
            ? { appVersion: ++versionReads === 1 ? '0.4.1' : '0.4.2', target }
            : { appVersion: '0.4.1' },
      })),
    )
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} liveFleet />)
    await waitFor(() => expect(screen.getByRole('button', { name: /update Podium/i })).toBeTruthy())
    screen.getByRole('button', { name: /update Podium/i }).click()
    await waitFor(() => {
      expect(queryCalls).toBeGreaterThanOrEqual(2)
      expect(results.at(-1)?.server.appVersion).toBe('0.4.2')
    })

    failAttempt?.()
    await waitFor(() => {
      expect(results.at(-1)?.view.state).toBe('failed')
      expect(screen.getByRole('button', { name: /update Podium/i })).toBeTruthy()
    })

    screen.getByRole('button', { name: /update Podium/i }).click()
    await waitFor(() =>
      expect(screen.getByTestId('view-state').textContent).toContain('in-progress'),
    )
    expect(mocks.mutate).toHaveBeenCalledTimes(2)
  })

  it('does not expose an install action without the desktop bridge', async () => {
    setupTransport()
    mocks.mutate.mockResolvedValue({
      state: 'in-progress',
      version: '0.4.2',
      done: 0,
      total: 1,
      fleet: { total: 1, behind: 1, converging: 1, failed: 0 },
    })

    render(<Probe onResult={() => {}} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /update Podium/i })).toBeTruthy())
    expect(screen.queryByText('install action')).toBeNull()
  })

  it('a manual check reports current when nothing is behind', async () => {
    setPageVersion('0.4.2')
    setupTransport({ appVersion: '0.4.2' })
    const results: UpdateStateResult[] = []

    render(
      <Probe
        onResult={(result) => results.push(result)}
        fleet={{ total: 0, behind: 0, converging: 0, failed: 0 }}
      />,
    )
    await waitFor(() => expect(results.at(-1)?.checkNow).toBeTypeOf('function'))
    await results.at(-1)?.checkNow()
    await waitFor(() =>
      expect(results.at(-1)?.view).toEqual({ state: 'current', version: '0.4.2' }),
    )
  })

  it('shows the running page version, not a stale built stamp', async () => {
    setPageVersion('dev+abc1234')
    setupTransport({
      appVersion: 'dev+abc1234',
      target: { version: 'dev+abc1234', critical: false, artifacts: {} },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.endsWith('/version')
            ? {
                appVersion: 'dev+abc1234',
                target: { version: 'dev+abc1234', critical: false, artifacts: {} },
              }
            : { appVersion: 'dev+old1234', sourceSha: 'old1234' },
      })),
    )
    const results: UpdateStateResult[] = []

    render(
      <Probe
        onResult={(result) => results.push(result)}
        fleet={{ total: 0, behind: 0, converging: 0, failed: 0 }}
      />,
    )
    await waitFor(() => expect(results.at(-1)?.checkNow).toBeTypeOf('function'))
    await results.at(-1)?.checkNow()
    await waitFor(() =>
      expect(results.at(-1)?.view).toEqual({ state: 'current', version: 'dev+abc1234' }),
    )
  })

  it('a manual check surfaces a failed desktop lookup', async () => {
    setupTransport({ appVersion: '0.4.2' })
    vi.stubGlobal('__PODIUM_DESKTOP__', {
      platform: 'macos',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      checkUpdate: vi.fn(async () => {
        throw new Error('update check failed: network down')
      }),
    })
    const results: UpdateStateResult[] = []

    render(
      <Probe
        onResult={(result) => results.push(result)}
        fleet={{ total: 0, behind: 0, converging: 0, failed: 0 }}
      />,
    )
    await waitFor(() => expect(results.at(-1)?.checkNow).toBeTypeOf('function'))
    await results.at(-1)?.checkNow()
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('failed'))
    expect(results.at(-1)?.view).toMatchObject({
      state: 'failed',
      diagnostic: 'update check failed: network down',
    })
  })

  it('claims update ownership and exposes the install action when the shell provides it', async () => {
    setupTransport()
    const claim = vi.fn(async () => {})
    const install = vi.fn(async () => {})
    vi.stubGlobal('__PODIUM_DESKTOP__', {
      platform: 'linux',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      claimUpdateOwnership: claim,
      checkUpdate: vi.fn(async () => ({
        current_version: '0.4.1',
        version: '0.4.2',
        critical: false,
        notes: 'A calmer update flow.',
      })),
      installUpdate: install,
    })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(screen.getByText('install action')).toBeTruthy())
    expect(claim).toHaveBeenCalledTimes(1)

    await results.at(-1)?.actions.installApp?.()
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('only exposes reload when the app place is touched', async () => {
    setupTransport({
      appVersion: '0.4.1',
      target: { ...target, artifacts: { web: { digest: 'new-web-digest' } } },
    })

    render(<Probe onResult={() => {}} withReload />)
    await waitFor(() => expect(screen.getByText('reload action')).toBeTruthy())
  })

  it('does not expose reload when only the server place is touched', async () => {
    setupTransport()

    render(<Probe onResult={() => {}} withReload />)
    await waitFor(() => expect(screen.getByRole('button', { name: /update Podium/i })).toBeTruthy())
    expect(screen.queryByText('reload action')).toBeNull()
  })

  it('starts a machine-only update and counts only the affected machine', async () => {
    setupTransport({ appVersion: '0.4.2', target })
    mocks.mutate.mockResolvedValue({
      state: 'in-progress',
      version: '0.4.2',
      done: 0,
      total: 1,
      fleet: {
        total: 1,
        behind: 1,
        converging: 1,
        failed: 0,
        targetVersion: '0.4.2',
      },
    })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} withReload />)
    await waitFor(() => expect(screen.getByRole('button', { name: /update Podium/i })).toBeTruthy())
    expect(screen.queryByText('reload action')).toBeNull()

    screen.getByRole('button', { name: /update Podium/i }).click()
    await waitFor(() =>
      expect(screen.getByTestId('view-state').textContent).toBe('in-progress:0.4.2:0:1'),
    )
    expect(results.at(-1)?.view).toMatchObject({ state: 'in-progress', total: 1 })
    expect(mocks.mutate).toHaveBeenCalledOnce()
  })
})
