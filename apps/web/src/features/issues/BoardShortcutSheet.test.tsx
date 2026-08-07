import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardShortcutSheet } from './BoardShortcutSheet'
import { BOARD_SHORTCUTS } from './board-shortcuts'

afterEach(cleanup)

describe('BoardShortcutSheet', () => {
  it('lists every binding the board has — the sheet IS the key map, not a copy of it', () => {
    render(<BoardShortcutSheet onClose={vi.fn()} />)
    for (const shortcut of BOARD_SHORTCUTS) {
      expect(screen.getByText(shortcut.label), shortcut.label).toBeTruthy()
    }
  })

  it('closes on Escape, on the backdrop, and on the ✕ — the three ways out', () => {
    const onClose = vi.fn()
    const { container } = render(<BoardShortcutSheet onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    const closers = screen.getAllByLabelText('Close shortcuts')
    expect(closers).toHaveLength(2) // backdrop + ✕
    for (const closer of closers) fireEvent.click(closer)
    expect(onClose).toHaveBeenCalledTimes(3)
    expect(container.querySelector('[role="dialog"]')).toBeTruthy()
  })

  it('is a modal dialog, so the board’s own key handler stands down while it is open', () => {
    render(<BoardShortcutSheet onClose={vi.fn()} />)
    // IssuesView bails on `document.querySelector('[role="dialog"], [role="menu"]')`,
    // which is what keeps one keypress from doing two things.
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Board keyboard shortcuts')
  })

  it('marks the bindings that need a focused card, so a dead key never looks broken', () => {
    render(<BoardShortcutSheet onClose={vi.fn()} />)
    const needFocus = BOARD_SHORTCUTS.filter((s) => s.needsFocus).length
    expect(screen.getAllByText('focused')).toHaveLength(needFocus)
  })

  it('writes the arrow and escape keys legibly rather than as event.key names', () => {
    render(<BoardShortcutSheet onClose={vi.fn()} />)
    expect(screen.getByText('←')).toBeTruthy()
    expect(screen.getByText('esc')).toBeTruthy()
    expect(screen.queryByText('ArrowLeft')).toBeNull()
  })
})
