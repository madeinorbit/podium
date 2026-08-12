// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandPaletteBoundary } from './CommandPaletteBoundary'

const fixture = vi.hoisted(() => ({ paletteOpen: false }))

vi.mock('./store', () => ({
  useStoreSelector: (selector: (state: typeof fixture) => unknown) => selector(fixture),
}))

vi.mock('./CommandPalette', () => ({
  CommandPalette: () => <div data-testid="command-palette-module" />,
}))

afterEach(cleanup)

describe('CommandPaletteBoundary', () => {
  it('loads on first open and stays mounted for child flows after the dialog closes', async () => {
    fixture.paletteOpen = false
    const view = render(<CommandPaletteBoundary />)
    expect(screen.queryByTestId('command-palette-module')).toBeNull()

    fixture.paletteOpen = true
    view.rerender(<CommandPaletteBoundary />)
    expect(await screen.findByTestId('command-palette-module')).toBeTruthy()

    fixture.paletteOpen = false
    view.rerender(<CommandPaletteBoundary />)
    expect(screen.getByTestId('command-palette-module')).toBeTruthy()
  })
})
