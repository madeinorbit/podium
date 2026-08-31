import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * What this file guards is the OPTIMISTIC-DEFERRED-RECONCILED contract: the
 * flip is visible before any store write happens, the write lands on the next
 * macrotask, and no store notification inside that window can flip the fold
 * back. The fake below is deliberately shaped like `RoutedUiState` (get/set/
 * subscribe, synchronous notify on set) — the same seam the real hook reads.
 */
const ui = vi.hoisted(() => {
  const values = new Map<string, string>()
  const listeners = new Set<() => void>()
  return {
    values,
    listeners,
    setCalls: [] as [string, string | null][],
    emit: () => {
      for (const listener of [...listeners]) listener()
    },
    state: {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string | null): void => {
        ui.setCalls.push([key, value])
        if (value === null) values.delete(key)
        else values.set(key, value)
        ui.emit()
      },
      subscribe: (cb: () => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
  }
})

vi.mock('../client/hooks', () => ({ useUiState: () => ui.state }))

const { useCollapsedSet } = await import('./useCollapsedSet')

const storageKeyFor = (key: string) => `fold:${key}`
const KEYS = ['pinned', 'needs-you', 'repo'] as const

afterEach(() => {
  vi.useRealTimers()
  ui.values.clear()
  ui.listeners.clear()
  ui.setCalls.length = 0
})

describe('useCollapsedSet', () => {
  it('reads the persisted folds for the given keys on mount', () => {
    ui.values.set('fold:repo', 'true')
    ui.values.set('fold:unrelated', 'true')
    const { result } = renderHook(() => useCollapsedSet(KEYS, storageKeyFor))
    expect([...result.current.collapsed]).toEqual(['repo'])
  })

  it('flips locally BEFORE any store write, then persists on the next macrotask', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCollapsedSet(KEYS, storageKeyFor))

    act(() => result.current.toggle('repo'))
    // Optimistic: collapsed immediately, store untouched.
    expect(result.current.collapsed.has('repo')).toBe(true)
    expect(ui.setCalls).toEqual([])

    act(() => vi.runAllTimers())
    expect(ui.setCalls).toEqual([['fold:repo', 'true']])
    expect(result.current.collapsed.has('repo')).toBe(true)
  })

  it('holds the optimistic flip against a store notification inside the window', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCollapsedSet(KEYS, storageKeyFor))

    act(() => result.current.toggle('repo'))
    // A feed tick lands before the deferred persist: the store still says
    // "expanded", but the operator's flip must not bounce back.
    act(() => ui.emit())
    expect(result.current.collapsed.has('repo')).toBe(true)

    act(() => vi.runAllTimers())
    expect(result.current.collapsed.has('repo')).toBe(true)
    // After the persist the overlay is released and the store agrees.
    expect(ui.values.get('fold:repo')).toBe('true')
  })

  it('converges a rapid double-toggle to the LAST tap', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCollapsedSet(KEYS, storageKeyFor))

    act(() => {
      result.current.toggle('repo')
      result.current.toggle('repo')
    })
    expect(result.current.collapsed.has('repo')).toBe(false)

    act(() => vi.runAllTimers())
    expect(result.current.collapsed.has('repo')).toBe(false)
    expect(ui.values.get('fold:repo')).toBe('false')
  })

  it('still takes an EXTERNAL write (the desk folding a band) when nothing is in flight', () => {
    const { result } = renderHook(() => useCollapsedSet(KEYS, storageKeyFor))
    expect(result.current.collapsed.has('needs-you')).toBe(false)

    act(() => {
      ui.values.set('fold:needs-you', 'true')
      ui.emit()
    })
    expect(result.current.collapsed.has('needs-you')).toBe(true)
  })

  it('persists a toggle even when the screen unmounts before the deferred write', () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useCollapsedSet(KEYS, storageKeyFor))

    act(() => result.current.toggle('repo'))
    unmount()
    act(() => vi.runAllTimers())
    expect(ui.values.get('fold:repo')).toBe('true')
  })
})
