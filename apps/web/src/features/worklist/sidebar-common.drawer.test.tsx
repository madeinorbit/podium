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
})
