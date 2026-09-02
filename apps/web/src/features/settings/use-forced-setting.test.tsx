import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trpc = { setup: { provenance: { query: vi.fn() } } }

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (store: unknown) => unknown) => selector({ trpc }),
}))

import { forcedNotice, resetForcedSettingCache, useForcedSetting } from './use-forced-setting'

describe('useForcedSetting', () => {
  beforeEach(() => {
    resetForcedSettingCache()
    trpc.setup.provenance.query = vi.fn()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is not forced while provenance has not resolved', () => {
    trpc.setup.provenance.query.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useForcedSetting('updateChannel'))
    expect(result.current).toEqual({ forced: false })
  })

  it('reports forced AND names the variable to unset', async () => {
    trpc.setup.provenance.query.mockResolvedValue({
      publicUrl: { source: 'env', env: 'PODIUM_PUBLIC_URL' },
    })
    const { result } = renderHook(() => useForcedSetting('publicUrl'))
    await waitFor(() => expect(result.current).toEqual({ forced: true, env: 'PODIUM_PUBLIC_URL' }))
  })

  it('a file or default value is not forced', async () => {
    trpc.setup.provenance.query.mockResolvedValue({ publicUrl: { source: 'file' } })
    const { result } = renderHook(() => useForcedSetting('publicUrl'))
    await waitFor(() => expect(result.current).toEqual({ forced: false }))
    expect(result.current.env).toBeUndefined()
  })

  it('reads provenance ONCE however many controls ask', async () => {
    trpc.setup.provenance.query.mockResolvedValue({ mode: { source: 'env', env: 'PODIUM_MODE' } })
    const a = renderHook(() => useForcedSetting('mode'))
    const b = renderHook(() => useForcedSetting('publicUrl'))
    await waitFor(() => expect(a.result.current.forced).toBe(true))
    await waitFor(() => expect(b.result.current.forced).toBe(false))
    expect(trpc.setup.provenance.query).toHaveBeenCalledTimes(1)
  })

  it('a server that refuses the read leaves every control exactly as it was', async () => {
    trpc.setup.provenance.query.mockRejectedValue(new Error('No procedure found'))
    const { result } = renderHook(() => useForcedSetting('updateChannel'))
    await waitFor(() => expect(result.current).toEqual({ forced: false }))
  })

  it('a server with no provenance procedure at all is the same non-event', async () => {
    // @ts-expect-error — an older server's client has no such procedure.
    trpc.setup.provenance = undefined
    const { result } = renderHook(() => useForcedSetting('updateChannel'))
    await waitFor(() => expect(result.current).toEqual({ forced: false }))
    trpc.setup.provenance = { query: vi.fn() }
  })

  it('the notice quotes the variable, because “something overrode you” is not actionable', () => {
    expect(forcedNotice('PODIUM_PUBLIC_URL')).toBe(
      "PODIUM_PUBLIC_URL is set in this deployment's environment and overrides this setting.",
    )
  })
})
