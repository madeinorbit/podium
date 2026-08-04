import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUpdateState, type UpdateStateResult } from './use-update-state'

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
}: {
  onResult: (result: UpdateStateResult) => void
  withReload?: boolean
}) {
  const result = useUpdateState({
    httpOrigin: 'http://podium.test',
    needRefresh: false,
    fleet: { total: 1, behind: 1, converging: 0, failed: 0 },
    reload: withReload ? reloadAction : undefined,
  })
  useEffect(() => {
    onResult(result)
  }, [onResult, result])
  return (
    <>
      {result.actions.updateServer && (
        <button type="button" onClick={() => void result.actions.updateServer?.()}>
          update server
        </button>
      )}
      <output data-testid="view-state">
        {result.view.state === 'failed'
          ? result.view.detail
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

describe('useUpdateState server action', () => {
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
    await waitFor(() => expect(screen.getByRole('button', { name: /update server/i })).toBeTruthy())

    screen.getByRole('button', { name: /update server/i }).click()
    await waitFor(() => expect(screen.getByTestId('view-state').textContent).toContain('in-progress'))

    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    expect(results.at(-1)?.view).toMatchObject({
      state: 'in-progress',
      version: '0.4.2',
      done: 0,
      total: 2,
    })
  })

  it('moves the shared dialog to failed with the server detail', async () => {
    setupTransport()
    mocks.mutate.mockRejectedValue(new Error('The update transport is unavailable.'))
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /update server/i })).toBeTruthy())

    screen.getByRole('button', { name: /update server/i }).click()
    await waitFor(() =>
      expect(screen.getByTestId('view-state').textContent).toContain(
        'The update transport is unavailable.',
      ),
    )

    expect(results.at(-1)?.view).toEqual({
      state: 'failed',
      detail: 'The update transport is unavailable.',
    })
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
    await waitFor(() => expect(screen.getByRole('button', { name: /update server/i })).toBeTruthy())
    expect(screen.queryByText('install action')).toBeNull()
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
    await waitFor(() => expect(screen.getByRole('button', { name: /update server/i })).toBeTruthy())
    expect(screen.queryByText('reload action')).toBeNull()
  })

  it('does not expose reload when only machines are touched', async () => {
    setupTransport({ appVersion: '0.4.2', target })

    render(<Probe onResult={() => {}} withReload />)
    await waitFor(() => expect(screen.getByTestId('view-state').textContent).toBe('available'))
    expect(screen.queryByText('reload action')).toBeNull()
    expect(screen.queryByRole('button', { name: /update server/i })).toBeNull()
  })
})
