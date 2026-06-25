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
  // Force desktop capacity (N=8): max-width:768px does not match.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
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
  it('keeps only the N (=8 desktop) most-recently-active session ids', () => {
    const all = Array.from({ length: 10 }, (_, i) => `s${i + 1}`)
    // Activate s1..s10 one at a time across rerenders.
    for (let i = 1; i <= 10; i++) {
      act(() => {
        root.render(<P all={all} active={[`s${i}`]} />)
      })
    }
    const warm = new Set(warmAttr().split(',').filter(Boolean))
    // s10 (active) + the 7 next-most-recent: s9,s8,s7,s6,s5,s4,s3 = 8 ids.
    expect(warm.size).toBe(8)
    expect([...warm].sort()).toEqual(['s10', 's3', 's4', 's5', 's6', 's7', 's8', 's9'])
    expect(warm.has('s1')).toBe(false)
    expect(warm.has('s2')).toBe(false)
  })
})
