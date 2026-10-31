import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const shipping = vi.hoisted(() => ({ unfinishedCount: 0, decisionCount: 0 }))
vi.mock('./shell-data', () => ({
  useShellShipping: () => shipping,
}))

import { RightRail } from './RightRail'

const featureEnabled = vi.hoisted(() => ({ value: true }))
vi.mock('@/lib/use-feature', () => ({
  useFeature: () => featureEnabled.value,
}))

afterEach(() => {
  cleanup()
  featureEnabled.value = true
  shipping.unfinishedCount = 0
  shipping.decisionCount = 0
})

describe('RightRail', () => {
  it('switches one panel at a time and exposes Superagent in the rail', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel={null} onPanelChange={onPanelChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Files' }))

    expect(onPanelChange).toHaveBeenLastCalledWith('files')

    fireEvent.click(screen.getByRole('button', { name: 'Superagent' }))
    expect(onPanelChange).toHaveBeenLastCalledWith('superagent')
  })

  it('does not attach task attention to the Superagent cell', () => {
    render(<RightRail rightPanel={null} onPanelChange={vi.fn()} />)
    expect(screen.queryByRole('img', { name: /waiting on you/ })).toBeNull()
  })

  it('hides experimental panels behind their feature flags', () => {
    featureEnabled.value = false
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel={null} onPanelChange={onPanelChange} />)

    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Messages' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Queues' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Shipping/ })).toBeNull()
  })

  it('toggles the active panel closed', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel="shell" onPanelChange={onPanelChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Shell' }))
    expect(onPanelChange).toHaveBeenCalledWith(null)
  })

  it('omits the retired Queues panel with experimental features enabled', () => {
    render(<RightRail rightPanel={null} onPanelChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Queues' })).toBeNull()
  })

  it('opens Shipping with a zero-state accessible label', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel={null} onPanelChange={onPanelChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Shipping, no unfinished deliveries' }))
    expect(onPanelChange).toHaveBeenCalledWith('shipping')
  })

  it('caps the scoped inventory badge and names decision attention without announcing it', () => {
    shipping.unfinishedCount = 100
    shipping.decisionCount = 1

    render(<RightRail rightPanel={null} onPanelChange={vi.fn()} />)

    const shippingButton = screen.getByRole('button', {
      name: 'Shipping, 100 unfinished deliveries, 1 needs your decision',
    })
    expect(shippingButton.textContent).toBe('99+')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // POD-743: the Task cell is an ordinary rail cell. The selected issue's
  // coloured ID square — and the working/waiting badge it carried — tinted the
  // rail with one task's state, and the panel may be showing another task.
  it('opens the task panel from a plain Task cell, with no issue identity on it', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel={null} onPanelChange={onPanelChange} />)

    expect(screen.queryByTestId('issue-id-square')).toBeNull()
    const cell = screen.getByRole('button', { name: 'Task' })
    fireEvent.click(cell)
    expect(onPanelChange).toHaveBeenLastCalledWith('issue')
  })

  it('toggles the task panel closed when it is already open', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel="issue" onPanelChange={onPanelChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Task' }))
    expect(onPanelChange).toHaveBeenLastCalledWith(null)
  })

  // POD-516 item 9: the right dock and its rail are a DARK DEFAULT surface.
  it('wears no issue tint', () => {
    render(<RightRail rightPanel={null} onPanelChange={vi.fn()} />)
    const rail = screen.getByTestId('right-rail')
    expect(rail.className).not.toContain('issue-fade')
    expect(rail.className).not.toContain('issue-base-')
  })
})
