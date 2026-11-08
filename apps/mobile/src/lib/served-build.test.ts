import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readServedBuild,
  type ServedBuild,
  servesNewerBuild,
  useServedBuildRefresh,
} from './served-build'

describe('servesNewerBuild', () => {
  it('offers a refresh when the server serves a build this page is not running', () => {
    expect(servesNewerBuild('0.1.1-edge.1', { appVersion: '0.1.1-edge.2' })).toBe(true)
  })

  it('stays quiet when the served build is the one already running', () => {
    expect(servesNewerBuild('0.1.1-edge.1', { appVersion: '0.1.1-edge.1' })).toBe(false)
  })

  it('stays quiet when either side cannot say what it is', () => {
    // An unstamped page reports the honest `dev`; that is not grounds to tell
    // anyone their page is old.
    expect(servesNewerBuild('dev', { appVersion: '0.1.1-edge.2' })).toBe(false)
    expect(servesNewerBuild('', { appVersion: '0.1.1-edge.2' })).toBe(false)
    expect(servesNewerBuild('0.1.1-edge.1', {})).toBe(false)
    expect(servesNewerBuild('0.1.1-edge.1', undefined)).toBe(false)
  })
})

describe('readServedBuild', () => {
  it('asks the server rather than the cache, and returns the served version', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ appVersion: '0.1.1-edge.2', sourceSha: 'abc' }),
    })) as unknown as typeof fetch

    expect(await readServedBuild(fetchImpl, '/mobile/podium-build.json')).toEqual({
      appVersion: '0.1.1-edge.2',
    })
    expect(fetchImpl).toHaveBeenCalledWith('/mobile/podium-build.json', { cache: 'no-store' })
  })

  it('treats every failure as silence, never as a new build', async () => {
    // The body PARSES and names a version: the only thing that can make this
    // undefined is the status check. A stub with no `json` would pass whether
    // that check existed or not — it would throw its way to the same answer.
    const notFound = vi.fn(async () => ({
      ok: false,
      json: async () => ({ appVersion: '0.1.1-edge.9' }),
    })) as unknown as typeof fetch
    expect(await readServedBuild(notFound)).toBeUndefined()

    const offline = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await readServedBuild(offline)).toBeUndefined()

    const garbage = vi.fn(async () => ({
      ok: true,
      json: async () => 'not an object',
    })) as unknown as typeof fetch
    expect(await readServedBuild(garbage)).toBeUndefined()
  })

  it('reports a stamp with no version as present-but-unversioned', async () => {
    const unversioned = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sourceSha: 'abc' }),
    })) as unknown as typeof fetch
    expect(await readServedBuild(unversioned)).toEqual({})
  })
})

/**
 * WHAT MAKES THE OFFER ARRIVE (POD-5798): no timer. The server names its build
 * in every `welcome`, so a redeploy reaches an open phone as a new
 * `serverBuild` on its reconnect, and that is when the stamp is read. The
 * foreground catch-up stays: a suspended page asks once when it is shown.
 */
describe('useServedBuildRefresh asks on each server build and on foreground', () => {
  function mountHook(read: () => Promise<ServedBuild | undefined>, serverBuild = '0.1.1-edge.3') {
    const intervals: number[] = []
    const real = window.setInterval.bind(window)
    vi.spyOn(window, 'setInterval').mockImplementation(((
      fn: () => void,
      ms: number,
      ...rest: unknown[]
    ) => {
      intervals.push(ms)
      return real(fn, ms, ...rest)
    }) as unknown as typeof window.setInterval)
    const view = renderHook(
      ({ build }: { build: string | undefined }) =>
        useServedBuildRefresh(build, read, '0.1.1-edge.3'),
      { initialProps: { build: serverBuild as string | undefined } },
    )
    return { intervals, view }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a redeploy seen in welcome is checked at once, with no poll armed', async () => {
    const read = vi
      .fn<() => Promise<ServedBuild | undefined>>()
      .mockResolvedValueOnce({ appVersion: '0.1.1-edge.3' })
      .mockResolvedValue({ appVersion: '0.1.1-edge.4' })
    const { intervals, view } = mountHook(read)

    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    expect(view.result.current.needsRefresh).toBe(false)
    // `waitFor` runs a 50 ms timer of its own; nothing else may repeat.
    expect(intervals.filter((ms) => ms !== 50)).toEqual([])

    // The server came back on a new build: the reconnect's welcome names it.
    view.rerender({ build: '0.1.1-edge.4' })
    await waitFor(() => expect(view.result.current.needsRefresh).toBe(true))
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('catches up the moment the phone comes back to the foreground', async () => {
    const read = vi
      .fn<() => Promise<ServedBuild | undefined>>()
      .mockResolvedValueOnce({ appVersion: '0.1.1-edge.3' })
      .mockResolvedValue({ appVersion: '0.1.1-edge.4' })
    const { view } = mountHook(read)

    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    expect(view.result.current.needsRefresh).toBe(false)

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() => expect(view.result.current.needsRefresh).toBe(true))
  })

  it('stops asking once the offer is up: the answer cannot become false', async () => {
    const read = vi
      .fn<() => Promise<ServedBuild | undefined>>()
      .mockResolvedValue({ appVersion: '0.1.1-edge.4' })
    const { view } = mountHook(read)

    await waitFor(() => expect(view.result.current.needsRefresh).toBe(true))
    const settled = read.mock.calls.length
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(read).toHaveBeenCalledTimes(settled)
  })
})
