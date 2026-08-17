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

/**
 * A Podium shell around the page. `checkUpdate` answers null by default — the
 * all-in-one case, where the release feed knows nothing about a dev target and
 * the operation's ask is the only thing that says an install is owed.
 */
function stubDesktopShell(over: Record<string, unknown> = {}): void {
  vi.stubGlobal('__PODIUM_DESKTOP__', {
    platform: 'linux',
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    claimUpdateOwnership: vi.fn(async () => {}),
    checkUpdate: vi.fn(async () => null),
    installUpdate: vi.fn(async () => {}),
    ...over,
  })
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
  // The restart handoff is deliberately localStorage — it has to outlive the
  // process — so it has to be swept here too, or one test's update becomes the
  // next one's news.
  globalThis.localStorage?.clear()
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
    expect(results.at(-1)?.view.error?.message).toMatch(/could not download this update/i)
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
    // Everything already on the target, so nothing but the completion could
    // possibly put a panel on screen.
    setPageVersion('0.4.2')
    setupTransport({ appVersion: '0.4.2', target: { ...target, version: '0.4.2' } })
    mocks.active.mockResolvedValue(null)
    mocks.history.mockResolvedValue([finished('done', Date.now() - 5_000)])
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} behind={0} />)
    await waitFor(() => expect(mocks.history).toHaveBeenCalled())
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('none'))
    expect(results.at(-1)?.view.indicator).toBe('none')
  })
})

/**
 * THE ALL-IN-ONE FLOW (§4, §5): one click, one restart, and the same operation
 * id reading `done` on the far side. Every assertion here is about a shape the
 * other surfaces never see — an operation with NO STEPS whose entire content is
 * one required ask addressed to this shell.
 */
describe('useUpdateState — all-in-one: one click, one restart', () => {
  const waitingOnTheShell = {
    id: 'op_aio',
    kind: 'update',
    state: 'waiting',
    details: { target: { version: '0.4.2' } },
    steps: [],
    awaiting: [
      {
        id: 'desktop-install',
        surface: 'desktop-all-in-one',
        title: 'Install the update in Podium Desktop',
        required: true,
      },
    ],
  }

  /**
   * The regression this exists for: `canInstallDesktop` used to be computed
   * ONLY from the offer-time facts — the release feed and the server's target
   * artifact — and in all-in-one neither is present. The shell the operation
   * was explicitly waiting for offered Reload, which does nothing, while the
   * ask it was meant to answer sat there for the ten-minute grace.
   */
  it('offers Restart Podium on the strength of the ask alone', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(waitingOnTheShell)
    stubDesktopShell()
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} withReload />)

    await waitFor(() => expect(results.at(-1)?.view.state).toBe('waiting-you'))
    expect(results.at(-1)?.view.primary?.kind).toBe('install-desktop')
    expect(results.at(-1)?.view.primary?.label).toBe('Restart Podium')
  })

  it('installs on the channel the server resolved, not the shell’s own config', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(waitingOnTheShell)
    const install = vi.fn(
      () => new Promise<void>(() => {}), // never settles: the process is replaced
    )
    stubDesktopShell({ installUpdate: install })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('waiting-you'))

    void results.at(-1)?.run('install-desktop')
    await waitFor(() => expect(install).toHaveBeenCalledWith('stable'))
  })

  /**
   * THE ACCEPTANCE LINE. The shell execs, the webview process is replaced, and
   * a page that has never seen this operation before is handed the successor
   * server's `done`. Without the localStorage handoff the reloaded page
   * congratulates nobody — `watched` is an in-memory Set, and sessionStorage
   * dies with the process too — so one click and one restart end in silence.
   */
  it('still renders done for the operation it restarted for', async () => {
    setPageVersion('0.4.2')
    setupTransport({ appVersion: '0.4.2', target: { ...target, version: '0.4.2' } })
    stubDesktopShell()
    mocks.active.mockResolvedValue(waitingOnTheShell)
    const before: UpdateStateResult[] = []
    render(<Probe onResult={(result) => before.push(result)} behind={0} />)
    await waitFor(() => expect(before.at(-1)?.operation?.id).toBe('op_aio'))

    // The restart. Everything in memory goes; localStorage is what crosses.
    cleanup()
    resetPolledQueryCache()
    mocks.active.mockResolvedValue(null)
    mocks.history.mockResolvedValue([
      { ...waitingOnTheShell, state: 'done', awaiting: [], finishedAt: Date.now() - 2_000 },
    ])
    const after: UpdateStateResult[] = []

    render(<Probe onResult={(result) => after.push(result)} behind={0} />)

    await waitFor(() => expect(after.at(-1)?.view.state).toBe('done'))
    expect(after.at(-1)?.operation?.id).toBe('op_aio')
  })

  /**
   * The bound on the handoff. It is a baton passed between two lives of the
   * same app, not a memory of every update this machine has ever run — an app
   * opened the next morning has nothing to celebrate (§6.2).
   */
  it('lets the handoff expire rather than congratulating tomorrow’s launch', async () => {
    setPageVersion('0.4.2')
    setupTransport({ appVersion: '0.4.2', target: { ...target, version: '0.4.2' } })
    stubDesktopShell()
    globalThis.localStorage?.setItem(
      'podium.update.watched-operation',
      JSON.stringify({ id: 'op_aio', at: Date.now() - 60 * 60_000 }),
    )
    mocks.active.mockResolvedValue(null)
    mocks.history.mockResolvedValue([
      { ...waitingOnTheShell, state: 'done', awaiting: [], finishedAt: Date.now() - 60 * 60_000 },
    ])
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} behind={0} />)

    await waitFor(() => expect(mocks.history).toHaveBeenCalled())
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

  /**
   * `install_update` ends in `app.restart()`, which diverges: on success the
   * promise is dropped with the process. So a RESOLVED install is the shell
   * saying it installed and stayed put, and until now that produced a silent
   * no-op — the panel cleared its spinner and went back to offering the same
   * update (POD-2152, which found `restart-failed` had no producer at all).
   */
  it('treats an install that returned instead of restarting as restart-failed', async () => {
    setupTransport()
    mocks.active.mockResolvedValue(null)
    const install = vi.fn(async () => {})
    stubDesktopShell({ installUpdate: install })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} />)
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('offer'))

    await results.at(-1)?.run('install-desktop')
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('failed'))
    expect(results.at(-1)?.view.error?.message).toMatch(/could not restart itself/i)
    expect(results.at(-1)?.view.error?.nextAction).toMatch(/open it again/i)
  })

  it('surfaces a missing channel release instead of calling it a download failure', async () => {
    setPageVersion('0.4.2')
    setupTransport({ appVersion: '0.4.2', target: { ...target, version: '0.4.2' } })
    mocks.active.mockResolvedValue(null)
    mocks.checkNow.mockResolvedValue({ checked: true })
    stubDesktopShell({
      checkUpdate: vi.fn(async () => {
        throw {
          code: 'no-release-on-channel',
          message: 'Nothing has been published on the stable channel yet.',
        }
      }),
    })
    const results: UpdateStateResult[] = []

    render(<Probe onResult={(result) => results.push(result)} behind={0} />)
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('none'))

    await results.at(-1)?.checkNow()
    await waitFor(() => expect(results.at(-1)?.view.state).toBe('failed'))
    expect(results.at(-1)?.view.error).toMatchObject({
      message: 'Nothing has been published on the stable channel yet.',
      nextAction: 'Choose a different release channel.',
    })
    expect(results.at(-1)?.view.error?.detail).toContain('code: no-release-on-channel')
    expect(results.at(-1)?.view.primary).toBeUndefined()
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
