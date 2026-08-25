// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueStatusPicker } from './IssueStatusPicker'

afterEach(cleanup)

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
  })
})
