import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUpdateState, type UpdateFleetState, type UpdateStateResult } from './use-update-state'

const mocks = vi.hoisted(() => ({
  makeTrpc: vi.fn(),
  mutate: vi.fn(),
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
}: {
  onResult: (result: UpdateStateResult) => void
  withReload?: boolean
  liveFleet?: boolean
}) {
  const result = useUpdateState({
    httpOrigin: 'http://podium.test',
    needRefresh: false,
    ...(liveFleet ? {} : { fleet: { total: 1, behind: 1, converging: 0, failed: 0 } }),
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__
})

function setupTransport(version = { appVersion: '0.4.1', target }): void {
  mocks.makeTrpc.mockReturnValue({
    setup: { channel: { query: vi.fn(async () => 'stable') } },
    updates: {
      fleet: { query: mocks.query },
      converge: { mutate: mocks.mutate },
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
