// @vitest-environment happy-dom
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWarmSet } from './use-warm-set'

function P({ all, active }: { all: string[]; active: string[] }): JSX.Element {
  const w = useWarmSet(all, active)
  return <span data-w={[...w].sort().join(',')} />
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // Force MOBILE capacity (N=3): max-width:768px matches. This is the hook's only
  // non-redundant behavior over warm-set.test.ts — the responsive matchMedia→N wiring.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true })),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function warmAttr(): string {
  return container.querySelector('span')?.getAttribute('data-w') ?? ''
}

describe('useWarmSet', () => {
  it('caps the warm set at the mobile capacity (N=3) by recency', () => {
    const all = Array.from({ length: 10 }, (_, i) => `s${i + 1}`)
    // Activate s1..s10 one at a time across rerenders.
    for (let i = 1; i <= 10; i++) {
      act(() => {
        root.render(<P all={all} active={[`s${i}`]} />)
      })
    }
    const warm = new Set(warmAttr().split(',').filter(Boolean))
    // s10 (active) + the 2 next-most-recent: s9,s8 = 3 ids at mobile capacity.
    expect(warm.size).toBe(3)
    expect([...warm].sort()).toEqual(['s10', 's8', 's9'])
    expect(warm.has('s7')).toBe(false)
  })

  it('(c) at desktop capacity (N=8) the 9th distinct session evicts the LRU-oldest', () => {
    // Force DESKTOP capacity (max-width:768px does NOT match) — the warm cap is 8.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    )
    // The universe is GLOBAL (every live session id, as Workspace now feeds it) so
    // recency spans issue switches — the point of POD-782. Activating a 9th distinct
    // session must evict the least-recently-viewed one, holding the mounted count at 8.
    const all = Array.from({ length: 9 }, (_, i) => `s${i + 1}`)
    for (let i = 1; i <= 9; i++) {
      act(() => {
        root.render(<P all={all} active={[`s${i}`]} />)
      })
    }
    const warm = new Set(warmAttr().split(',').filter(Boolean))
    expect(warm.size).toBe(8)
    // s9 (active) + s8..s2 by recency; s1 (oldest) is evicted.
    expect(warm.has('s1')).toBe(false)
    expect([...warm].sort()).toEqual(['s2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'])
  })
})
