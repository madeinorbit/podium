// @vitest-environment happy-dom
import { asSessionId } from '@podium/model'
import type { SessionId } from '@podium/model'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWarmSet } from './use-warm-set'

function P({ all, active }: { all: SessionId[]; active: SessionId[] }): JSX.Element {
  const w = useWarmSet(all, active)
  return <span data-w={[...w].sort().join(',')} />
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // Force the narrow-device residency budget: max-width:768px matches. This is
  // the hook's only non-redundant behavior over warm-set.test.ts.
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
  it('admits the active panel plus one recent panel on mobile (budget=2)', () => {
    const all = Array.from({ length: 10 }, (_, i) => asSessionId(`s${i + 1}`))
    // Activate s1..s10 one at a time across rerenders.
    for (let i = 1; i <= 10; i++) {
      act(() => {
        root.render(<P all={all} active={[asSessionId(`s${i}`)]} />)
      })
    }
    const warm = new Set(warmAttr().split(',').filter(Boolean))
    expect(warm.size).toBe(2)
    expect([...warm].sort()).toEqual(['s10', 's9'])
    expect(warm.has('s8')).toBe(false)
  })

  it('plateaus at the measured desktop budget after 1/3/8/20 distinct visits', () => {
    // Force DESKTOP capacity (max-width:768px does NOT match).
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    )
    const all = Array.from({ length: 20 }, (_, i) => asSessionId(`s${i + 1}`))
    const sizes = new Map<number, number>()
    for (let i = 1; i <= 20; i++) {
      act(() => {
        root.render(<P all={all} active={[asSessionId(`s${i}`)]} />)
      })
      if ([1, 3, 8, 20].includes(i)) {
        sizes.set(i, new Set(warmAttr().split(',').filter(Boolean)).size)
      }
    }
    const warm = new Set(warmAttr().split(',').filter(Boolean))
    expect([...sizes]).toEqual([
      [1, 1],
      [3, 3],
      [8, 3],
      [20, 3],
    ])
    expect([...warm].sort()).toEqual(['s18', 's19', 's20'])
  })
})
