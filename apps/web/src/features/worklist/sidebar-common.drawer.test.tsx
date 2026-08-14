// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResizableColumn } from './sidebar-common'

vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (store: unknown) => unknown) =>
    select({ uiState: { get: () => null, set: vi.fn() } }),
}))

vi.mock('motion/react', () => ({
  useReducedMotion: () => true,
}))

afterEach(cleanup)

function renderDrawer(handleSide: 'left' | 'right'): HTMLElement {
  render(
    <ResizableColumn
      storageKey="drawer-width"
      min={280}
      max={860}
      defaultWidth={316}
      handleLabel="Resize drawer"
      handleSide={handleSide}
      collapsed={false}
    >
      <div>Drawer content</div>
    </ResizableColumn>,
  )

  const content = screen.getByText('Drawer content')
  const anchoredSurface = content.parentElement
  if (!anchoredSurface) throw new Error('drawer content has no anchored surface')
  return anchoredSurface
}

describe('ResizableColumn drawer anchoring', () => {
  it('pins a right dock to the rail edge opposite its left resize handle', () => {
    const surface = renderDrawer('left')

    expect(surface.classList.contains('right-0')).toBe(true)
    expect(surface.classList.contains('left-0')).toBe(false)
  })

  it('pins a left drawer to the edge opposite its right resize handle', () => {
    const surface = renderDrawer('right')

    expect(surface.classList.contains('left-0')).toBe(true)
    expect(surface.classList.contains('right-0')).toBe(false)
  })

  it('fits the fixed drawer surface to the width the shell actually grants', () => {
    const rects = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element): DOMRect {
        const width = this.hasAttribute('data-resizable-column') ? 240 : 0
        return {
          x: 0,
          y: 0,
          top: 0,
          right: width,
          bottom: 600,
          left: 0,
          width,
          height: 600,
          toJSON: () => ({}),
        }
      })

    try {
      const surface = renderDrawer('left')

      // The saved/default width is 316px, but a responsive shell may resolve
      // the root smaller. The right-anchored surface must shrink with that
      // settled root or its leading content is clipped off-screen.
      expect(surface.style.width).toBe('240px')
    } finally {
      rects.mockRestore()
    }
  })
})
