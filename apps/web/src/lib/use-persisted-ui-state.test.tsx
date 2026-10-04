// @vitest-environment happy-dom
import type { JSX } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A ui-state stand-in that notifies subscribers, so a key can ARRIVE after a
 *  component has already mounted — the replicated-layout race this hook exists
 *  for (POD-540). */
const store = vi.hoisted(() => {
  const data = new Map<string, string>()
  const listeners = new Set<() => void>()
  const uiState = {
    get: (k: string): string | null => data.get(k) ?? null,
    set: (k: string, v: string | null): void => {
      if (v === null) data.delete(k)
      else data.set(k, v)
      for (const cb of [...listeners]) cb()
    },
    subscribe: (cb: () => void): (() => void) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
  }
  return { data, listeners, uiState, available: { value: true }, legacyReads: vi.fn() }
})

vi.mock('@podium/client-core/react', () => ({
  useRuntimeSelector: (select: (s: unknown) => unknown) => {
    store.legacyReads()
    return select({ uiState: store.available.value ? store.uiState : undefined })
  },
  useStoreHandle: () => ({
    getSnapshot: () => ({ uiState: store.available.value ? store.uiState : undefined }),
  }),
}))

vi.mock('@/app/store-worklist-pool', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useWorklistPoolProjection: (read: (pool: unknown) => unknown) =>
      useSyncExternalStore(store.available.value ? store.uiState.subscribe : () => () => {}, () =>
        read({
          row: (_entity: string, key: string) =>
            store.available.value ? { value: store.uiState.get(key) } : undefined,
        }),
      ),
  }
})

const { usePersistedUiState, usePersistedUiValue } = await import('./use-persisted-ui-state')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'podium:sidebar:collapsed'
const parseCollapsed = (raw: string | null): boolean => raw === 'true'
const serializeCollapsed = (v: boolean): string => String(v)

function Collapsed(): JSX.Element {
  const [collapsed, setCollapsed] = usePersistedUiState(KEY, parseCollapsed, serializeCollapsed)
  return (
    <button type="button" onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? 'collapsed' : 'expanded'}
    </button>
  )
}

describe('usePersistedUiState', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    store.data.clear()
    store.legacyReads.mockClear()
    store.available.value = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (node: JSX.Element): void => {
    act(() => root.render(node))
  }
  const text = (): string => container.textContent ?? ''

  it('uses the preference subscription without a legacy snapshot selector', () => {
    render(<Collapsed />)
    expect(store.listeners.size).toBe(1)
    act(() => store.uiState.set(KEY, 'true'))
    expect(text()).toBe('collapsed')
    expect(store.legacyReads).not.toHaveBeenCalled()
  })

  it('adopts a replicated value that arrives AFTER mount', () => {
    // The row is not in the replica yet — exactly the state a seeded
    // `useState` initializer would freeze forever.
    render(<Collapsed />)
    expect(text()).toBe('expanded')

    act(() => store.uiState.set(KEY, 'true'))
    expect(text()).toBe('collapsed')
  })

  it('renders a value that was already present at mount', () => {
    store.data.set(KEY, 'true')
    render(<Collapsed />)
    expect(text()).toBe('collapsed')
  })

  it('writes through the store, and the store is what re-renders', () => {
    render(<Collapsed />)
    act(() => container.querySelector('button')?.click())
    expect(store.data.get(KEY)).toBe('true')
    expect(text()).toBe('collapsed')
  })

  it('a later arrival wins over a local toggle rather than being ignored', () => {
    render(<Collapsed />)
    act(() => container.querySelector('button')?.click())
    expect(text()).toBe('collapsed')
    // Another device (or the replica's own hydrate) moves the row.
    act(() => store.uiState.set(KEY, 'false'))
    expect(text()).toBe('expanded')
  })

  it('a null serialization deletes the key', () => {
    store.data.set(KEY, 'true')
    render(<Collapsed />)
    const Clearing = (): JSX.Element => {
      const [, set] = usePersistedUiState(KEY, parseCollapsed, () => null)
      return (
        <button type="button" onClick={() => set(false)}>
          clear
        </button>
      )
    }
    render(<Clearing />)
    act(() => container.querySelector('button')?.click())
    expect(store.data.has(KEY)).toBe(false)
  })

  it('falls back to the parsed default when no UI collection is exposed', () => {
    store.available.value = false
    let seen: string | null | undefined
    const Probe = (): JSX.Element => {
      seen = usePersistedUiValue(KEY, (raw) => raw)
      return <span>ok</span>
    }
    render(<Probe />)
    expect(seen).toBeNull()
  })
})
