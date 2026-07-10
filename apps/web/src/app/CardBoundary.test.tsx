import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CardBoundary } from './CardBoundary'

function Boom(): never {
  throw new Error('render exploded')
}

describe('CardBoundary', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('degrades one throwing card to a compact fallback instead of bubbling (blanking the app)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}) // silence React's boundary log
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    act(() => {
      root.render(
        <CardBoundary label="session card">
          <Boom />
        </CardBoundary>,
      )
    })
    expect(container.textContent).toContain('displayed')
  })

  it('renders children normally when they do not throw', () => {
    act(() => {
      root.render(
        <CardBoundary>
          <div>healthy card</div>
        </CardBoundary>,
      )
    })
    expect(container.textContent).toContain('healthy card')
  })
})
