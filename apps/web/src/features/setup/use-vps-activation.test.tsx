// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { serializeVpsActivation, vpsIntroState } from './vps-activation'

const data = vi.hoisted(() => ({ ready: false, raw: null as string | null }))
vi.mock('@/lib/use-persisted-ui-state', () => ({ usePersistedUiValue: () => data.raw }))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPoolProjection: () => data.ready }))

import { useConfirmedVpsActivation } from './use-vps-activation'

const transport = () =>
  ({
    layout: {
      get: {
        query: vi.fn(() => {
          throw new Error('layout.get is forbidden')
        }),
      },
      set: { mutate: vi.fn() },
      clear: { mutate: vi.fn() },
    },
  }) as unknown as Trpc
describe('pool-backed VPS activation', () => {
  it('gates absence until the pool has resolved the signed-in user layout row', () => {
    data.ready = false
    data.raw = null
    const trpc = transport(),
      view = renderHook(() => useConfirmedVpsActivation(trpc))
    expect(view.result.current).toMatchObject({ ready: false, state: null })
    data.ready = true
    view.rerender()
    expect(view.result.current).toMatchObject({ ready: true, state: null })
    expect(trpc.layout.get.query).not.toHaveBeenCalled()
    expect(trpc.layout.set.mutate).not.toHaveBeenCalled()
  })
  it('reads checkpoint changes straight from the pool without keeping an override', () => {
    const source = vpsIntroState('welcome'),
      destination = vpsIntroState('local-project')
    data.ready = true
    data.raw = serializeVpsActivation(source)
    const trpc = transport(),
      view = renderHook(() => useConfirmedVpsActivation(trpc))
    expect(view.result.current.state).toEqual(source)
    data.ready = false
    data.raw = null
    view.rerender()
    expect(view.result.current.state).toBeNull()
    data.ready = true
    data.raw = serializeVpsActivation(destination)
    view.rerender()
    expect(view.result.current.state).toEqual(destination)
    expect(trpc.layout.get.query).not.toHaveBeenCalled()
  })
})
