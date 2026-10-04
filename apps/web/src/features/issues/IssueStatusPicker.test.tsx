// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IssueStatusPicker } from './IssueStatusPicker'

const roots = vi.hoisted(() => ({ mounts: 0, live: 0 }))
vi.mock('@/components/ui/dropdown-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/dropdown-menu')>()
  const { useEffect } = await import('react')
  return {
    ...actual,
    DropdownMenu(props: Parameters<typeof actual.DropdownMenu>[0]) {
      useEffect(() => {
        roots.mounts++
        roots.live++
        return () => {
          roots.live--
        }
      }, [])
      return <actual.DropdownMenu {...props} />
    },
  }
})

afterEach(cleanup)
beforeEach(() => {
  roots.mounts = 0
  roots.live = 0
})

/** The picker as every list mounts it: inside the row's own button. */
function Row({
  stage,
  closedReason,
  onPick,
  onRowClick,
}: {
  stage: 'backlog' | 'in_progress' | 'shipping' | 'done'
  closedReason?: string | null
  onPick: (value: string) => void
  onRowClick: () => void
}): JSX.Element {
  return (
    <button data-pressable type="button" onClick={onRowClick}>
      <IssueStatusPicker issue={{ stage, closedReason }} onPick={onPick} />
      <span>Rebuild the sidebar</span>
    </button>
  )
}

describe('IssueStatusPicker', () => {
  it('mounts zero menus for 337 rows, then only the intended menu across row updates', () => {
    const onPick = vi.fn()
    const onRowClick = vi.fn()
    const ids = Array.from({ length: 337 }, (_, index) => `issue-${index}`)
    const rows = (stage: 'backlog' | 'in_progress') =>
      ids.map((id) => <Row key={id} stage={stage} onPick={onPick} onRowClick={onRowClick} />)
    const view = render(rows('backlog'))
    expect(roots.mounts).toBe(0)
    expect(roots.live).toBe(0)
    const trigger = screen.getAllByTestId('issue-status-picker')[12]
    if (!trigger) throw new Error('Missing status fixture row')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.pointerEnter(trigger)
    expect(roots.mounts).toBe(1)
    expect(screen.queryByRole('menu')).toBeNull()
    view.rerender(rows('in_progress'))
    expect(roots.mounts).toBe(1)
    expect(roots.live).toBe(1)
  })

  it('keeps keyboard focus on the trigger when first focus mounts its menu', async () => {
    const onRowClick = vi.fn()
    render(<Row stage="backlog" onPick={vi.fn()} onRowClick={onRowClick} />)
    const cold = screen.getByLabelText('Status: Backlog')
    act(() => cold.focus())
    const trigger = screen.getByLabelText('Status: Backlog')
    expect(document.activeElement).toBe(trigger)
    expect(roots.mounts).toBe(1)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(await screen.findByRole('menuitem', { name: 'Backlog' })).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByLabelText('Status: Backlog').getAttribute('aria-expanded')).toBe('true')
    })
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('opens on a first pointerdown without hover or row activation', async () => {
    const onRowClick = vi.fn()
    render(<Row stage="backlog" onPick={vi.fn()} onRowClick={onRowClick} />)
    const cold = screen.getByLabelText('Status: Backlog')
    const owner = cold.parentElement
    if (!owner) throw new Error('Missing status event owner')
    fireEvent.pointerDown(cold, { button: 0, pointerType: 'touch' })
    expect(await screen.findByRole('menu')).toBeTruthy()
    // Down and up straddle the trigger replacement, so the browser's click
    // lands on their stable common ancestor rather than the old span.
    fireEvent.click(owner)
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(roots.mounts).toBe(1)
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it.each([
    'Enter',
    'ArrowDown',
    'ArrowUp',
    ' ',
  ])('handles a first %s key without prior focus', async (key) => {
    const onRowClick = vi.fn()
    render(<Row stage="backlog" onPick={vi.fn()} onRowClick={onRowClick} />)
    fireEvent.keyDown(screen.getByLabelText('Status: Backlog'), { key })
    if (key === ' ') fireEvent.keyUp(screen.getByLabelText('Status: Backlog'), { key })
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(roots.mounts).toBe(1)
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('moves a lane without opening the row it sits in', async () => {
    const onPick = vi.fn()
    const onRowClick = vi.fn()
    render(<Row stage="backlog" onPick={onPick} onRowClick={onRowClick} />)

    fireEvent.click(screen.getByLabelText('Status: Backlog'))
    fireEvent.click(await screen.findByText('In Progress'))

    expect(onPick).toHaveBeenCalledWith('stage:in_progress')
    // The whole point of the affordance: the glyph is the one part of the row
    // that does something other than open the task.
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('reports an ending as a close, for the host to take through the guard', async () => {
    const onPick = vi.fn()
    render(<Row stage="in_progress" onPick={onPick} onRowClick={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Status: In Progress'))
    fireEvent.click(await screen.findByText('Cancelled'))

    expect(onPick).toHaveBeenCalledWith('close:cancelled')
  })

  it('states a closed row by its reason rather than by its stage', () => {
    render(<Row stage="done" closedReason="duplicate" onPick={vi.fn()} onRowClick={vi.fn()} />)
    expect(screen.getByLabelText('Status: Duplicate')).toBeTruthy()
  })

  /**
   * POD-1646 — the glyph in a menu row is decoration, and saying otherwise cost
   * the flight deck a check.
   *
   * `StatusGlyph` is a NAMED graphic (`role="img"`, `aria-label="Backlog"`)
   * because in a list row it is the only thing that states the status. In this
   * menu the word is right beside it, so the name landed twice: every item
   * announced "Backlog Backlog" and answered to neither half, which is why the
   * deck's own test could not find the item it clicks.
   */
  it('names a menu row by its word alone, not twice over', async () => {
    render(<Row stage="backlog" onPick={vi.fn()} onRowClick={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Status: Backlog'))
    expect(await screen.findByRole('menuitem', { name: 'In Progress' })).toBeTruthy()
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Backlog',
      'Planning',
      'In Progress',
      'Review',
      'Done',
      'Cancelled',
      'Duplicate',
    ])
  })

  it('leaves shipping custody alone — a readout, not a door', () => {
    render(<Row stage="shipping" onPick={vi.fn()} onRowClick={vi.fn()} />)
    expect(screen.queryByTestId('issue-status-picker')).toBeNull()
    expect(screen.getByLabelText('Shipping')).toBeTruthy()
    expect(roots.mounts).toBe(0)
  })
})
