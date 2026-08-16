/**
 * The hook's remaining job, tested at its seams (POD-2102): does it read the
 * operation, does it hold this surface's local fact, and does EVERY action it
 * dispatches come back as something the user can see?
 *
 * The states themselves are table-tested in `operation-view.test.ts` — this file
 * is deliberately about the wiring, not the copy.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetPolledQueryCache } from '@/lib/use-polled-query'
import { type UpdateStateResult, useUpdateState } from './use-update-state'

const mocks = vi.hoisted(() => ({
  makeTrpc: vi.fn(),
  active: vi.fn(),
  history: vi.fn(),
  fleet: vi.fn(),
  converge: vi.fn(),
  start: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  checkNow: vi.fn(),
}))

vi.mock('@/app/trpc', () => ({ makeTrpc: mocks.makeTrpc }))

const target = { version: '0.4.2', critical: false, artifacts: {} }

const reloadAction = vi.fn()

function Probe({
  onResult,
  withReload = false,
  behind = 1,
}: {
  onResult: (result: UpdateStateResult) => void
  withReload?: boolean
  /** How many fleet machines are behind — the offer's only reason to exist here. */
  behind?: number
}) {
  const result = useUpdateState({
    httpOrigin: 'http://podium.test',
    needRefresh: false,
    fleet: { total: 1, behind, converging: 0, failed: 0 },
    reload: withReload ? reloadAction : undefined,
  })
  useEffect(() => {
    onResult(result)
  }, [onResult, result])
  return (
    <output data-testid="view-state">
      {result.view.state}
      {result.view.error ? `|${result.view.error.message}` : ''}
    </output>
  )
}

/** A tRPC path this server has never heard of answers exactly like this. */
function notFound(path: string): Error & { data: { code: string } } {
  const error = new Error(`No procedure found on path "${path}"`) as Error & {
    data: { code: string }
  }
  error.data = { code: 'NOT_FOUND' }
  return error
}

function setupTransport(
  version: { appVersion: string; target?: typeof target } = { appVersion: '0.4.1', target },
): void {
  mocks.makeTrpc.mockReturnValue({
    setup: { channel: { query: vi.fn(async () => 'stable') } },
    operations: {
      active: { query: mocks.active },
      history: { query: mocks.history },
      cancel: { mutate: mocks.cancel },
    },
    updates: {
      fleet: { query: mocks.fleet },
      converge: { mutate: mocks.converge },
      start: { mutate: mocks.start },
      retry: { mutate: mocks.retry },
      checkNow: { mutate: mocks.checkNow },
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

function setPageVersion(version: string): void {
  document.head.querySelector('meta[name="podium-version"]')?.remove()
  const meta = document.createElement('meta')
  meta.setAttribute('name', 'podium-version')
  meta.setAttribute('content', version)
  document.head.append(meta)
}

afterEach(() => {
  cleanup()
  // The poll cache is process-wide by design, so one test's answer would
  // otherwise be the next test's first render.
  resetPolledQueryCache()
  globalThis.sessionStorage?.clear()
  document.head.querySelector('meta[name="podium-version"]')?.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__
})

describe('useUpdateState — reading the operation', () => {
  it('renders the offer while the server has no operation', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(null)
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)

    await waitFor(() => expect(results.at(-1)?.view.state).toBe('offer'))
    expect(results.at(-1)?.view.primary?.kind).toBe('start')
  })

  it('renders the server’s operation instead of the offer, verbatim', async () => {
    setupTransport()
    mocks.active.mockResolvedValue({
      id: 'op_7',
      kind: 'update',
      state: 'running',
      details: { target: { version: '0.4.2' } },
      steps: [
        { id: 'prepare', title: 'Preparing the update', state: 'done' },
        { id: 'machines', title: 'Updating your machines', state: 'running' },
      ],
    })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)

    await waitFor(() => expect(results.at(-1)?.view.state).toBe('running'))
    expect(results.at(-1)?.view.stepPosition).toEqual({ current: 2, total: 2 })
    expect(results.at(-1)?.operation?.id).toBe('op_7')
    // The fleet snapshot is not a second opinion while an operation exists.
    expect(mocks.fleet).not.toHaveBeenCalled()
  })

  it('drops a payload that is not an operation rather than rendering a blank', async () => {
    setupTransport()
    mocks.active.mockResolvedValue({ kind: 'update' })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)

    await waitFor(() => expect(results.at(-1)?.view.state).toBe('offer'))
    expect(results.at(-1)?.operation).toBeNull()
  })

  it('shows the running page version, not a stale built stamp', async () => {
    setPageVersion('0.4.2')
    setupTransport({ appVersion: '0.4.2', target: { ...target, version: '0.4.2' } })
    mocks.active.mockResolvedValue(null)
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} behind={0} />)

    await waitFor(() => expect(results.length).toBeGreaterThan(0))
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('none'))
  })
})

/**
 * `operations.active` filters terminal states out by design, so the two
 * outcomes the panel must show — "done" and "failed" — can only come from
 * `history`. Without this the failure would blink out of existence at the
 * moment it became true.
 */
describe('useUpdateState — the outcome, which `active` cannot carry', () => {
  const finished = (state: string, finishedAt: number) => ({
    id: 'op_done',
    kind: 'update',
    state,
    details: { target: { version: '0.4.2' } },
    finishedAt,
    steps: [{ id: 'prepare', title: 'Preparing the update', state: 'done' }],
  })

  it('shows a failure from history, and keeps showing it across a reload', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(null)
    mocks.history.mockResolvedValue([
      { ...finished('failed', Date.now() - 5_000), error: { code: 'download-failed' } },
    ])
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)

    await waitFor(() => expect(results.at(-1)?.view.state).toBe('failed'))
    expect(results.at(-1)?.view.error?.message).toMatch(/couldn't be downloaded/i)
  })

  it('stops showing a failure the user acknowledged', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(null)
    mocks.history.mockResolvedValue([
      { ...finished('failed', Date.now() - 5_000), error: { code: 'download-failed' } },
    ])
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('failed'))

    act(() => results.at(-1)?.acknowledge())
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('offer'))
  })

  it('lets an old failure go: after the window it belongs to Settings, not the corner', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(null)
    mocks.history.mockResolvedValue([
      { ...finished('failed', Date.now() - 60 * 60_000), error: { code: 'download-failed' } },
    ])
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(results.length).toBeGreaterThan(0))
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('offer'))
  })

  it('does not congratulate a tab that never watched the update run', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(null)
    mocks.history.mockResolvedValue([finished('done', Date.now() - 5_000)])
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} behind={0} />)
    await waitFor(() => expect(results.length).toBeGreaterThan(0))
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('none'))
  })
})

describe('useUpdateState — dispatching actions', () => {
  it('starts the update through the operation verb', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(null)
    mocks.start.mockResolvedValue({ id: 'op_1' })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('offer'))

    await results.at(-1)?.run('start')
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(mocks.converge).not.toHaveBeenCalled()
  })

  /**
   * A server older than the operation verbs is a REAL case, not scaffolding:
   * the bundle is swapped during the very update it is driving (P8).
   */
  it('falls back to converge when the server has never heard of updates.start', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(null)
    mocks.start.mockRejectedValue(notFound('updates.start'))
    mocks.converge.mockResolvedValue({ fleet: { total: 1, behind: 0, converging: 1, failed: 0 } })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('offer'))

    await results.at(-1)?.run('start')
    expect(mocks.converge).toHaveBeenCalledTimes(1)
    expect(results.at(-1)?.view.state).toBe('offer')
  })

  /**
   * THE RETIRED POD-2091 BUG. A rejected action used to disappear into
   * `runAction`'s try/finally: the spinner stopped and the user was told
   * nothing at all.
   */
  it('surfaces a refused start as a failure the user can read', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(null)
    mocks.start.mockRejectedValue(
      Object.assign(new Error('another update is already running'), {
        data: { code: 'CONFLICT' },
      }),
    )
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('offer'))

    await results.at(-1)?.run('start')
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('failed'))
    expect(screen.getByTestId('view-state').textContent).toContain('already running')
    expect(results.at(-1)?.view.primary?.kind).toBe('retry')
  })

  it('surfaces the shell’s typed install failure', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(null)
    const install = vi.fn(async () => {
      throw { code: 'signature-invalid', message: 'The desktop update could not be verified.' }
    })
    vi.stubGlobal('__PODIUM_DESKTOP__', {
      platform: 'linux',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      claimUpdateOwnership: vi.fn(async () => {}),
      checkUpdate: vi.fn(async () => ({
        current_version: '0.4.1',
        version: '0.4.2',
        critical: false,
        notes: null,
      })),
      installUpdate: install,
    })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('offer'))

    await results.at(-1)?.run('install-desktop')
    // The channel the SERVER resolved, passed as an argument (POD-2135).
    expect(install).toHaveBeenCalledWith('stable')
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('failed'))
    expect(results.at(-1)?.view.error?.message).toMatch(/couldn't be verified/i)
    expect(results.at(-1)?.view.error?.detail).toContain('code: signature-invalid')
  })

  it('claims update ownership so the shell does not raise its own dialog', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(null)
    const claim = vi.fn(async () => {})
    vi.stubGlobal('__PODIUM_DESKTOP__', {
      platform: 'linux',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      claimUpdateOwnership: claim,
    })

    render(<Probe onResult={() => {}} />)
    await waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
  })

  it('turns a refused cancel into a sentence instead of an exception', async () => {
    setupTransport()
    mocks.active.mockResolvedValue({ id: 'op_9', kind: 'update', state: 'running' })
    mocks.cancel.mockResolvedValue({ canceled: false, refused: 'irreversible', step: 'server' })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('running'))

    await results.at(-1)?.run('cancel')
    await waitFor(() => expect(results.at(-1)?.view.note).toMatch(/finish or fail/i))
    expect(results.at(-1)?.view.state).toBe('running')
  })

  it('reports “up to date” after a manual check finds nothing', async () => {
    setPageVersion('0.4.2')
    setupTransport({ appVersion: '0.4.2', target: { ...target, version: '0.4.2' } })
    mocks.active.mockResolvedValue(null)
    mocks.checkNow.mockResolvedValue({ checked: true })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} behind={0} />)
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('none'))

    await results.at(-1)?.checkNow()
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('done'))
    expect(results.at(-1)?.view.title).toBe('Podium is up to date')
    expect(results.at(-1)?.view.indicator).toBe('none')
  })
})
