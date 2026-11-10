import { DEFAULT_SETTINGS } from '@podium/runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkflowSection } from './workflow'

vi.mock('../settings-frame', () => ({
  useSettingsFrame: () => ({ openTakeover: vi.fn(), closeTakeover: vi.fn() }),
}))
afterEach(cleanup)

it('maps plain cleanup choices to the existing policy values and disables age while keeping', () => {
  const patch = vi.fn()
  const settings = { ...DEFAULT_SETTINGS, worktreeGc: { mode: 'off' as const, afterDays: 14 } }
  const view = render(<WorkflowSection settings={settings} patch={patch} />)
  expect((screen.getByRole('spinbutton', { name: 'Old means' }) as HTMLInputElement).disabled).toBe(
    true,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Suggest' }))
  expect(patch).toHaveBeenLastCalledWith({ worktreeGc: { mode: 'propose', afterDays: 14 } })
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  expect(patch).toHaveBeenLastCalledWith({ worktreeGc: { mode: 'auto', afterDays: 14 } })

  view.rerender(
    <WorkflowSection
      settings={{ ...settings, worktreeGc: { mode: 'auto', afterDays: 14 } }}
      patch={patch}
    />,
  )
  expect((screen.getByRole('spinbutton', { name: 'Old means' }) as HTMLInputElement).disabled).toBe(
    false,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
  expect(patch).toHaveBeenLastCalledWith({ worktreeGc: { mode: 'off', afterDays: 14 } })
})

it('keeps cleanup age local until commit and clamps the saved policy', () => {
  const patch = vi.fn()
  render(
    <WorkflowSection
      settings={{ ...DEFAULT_SETTINGS, worktreeGc: { mode: 'propose', afterDays: 14 } }}
      patch={patch}
    />,
  )
  const days = screen.getByRole('spinbutton', { name: 'Old means' })
  fireEvent.change(days, { target: { value: '900' } })
  expect(patch).not.toHaveBeenCalled()
  fireEvent.blur(days)
  expect(patch).toHaveBeenCalledWith({ worktreeGc: { mode: 'propose', afterDays: 730 } })
})
