import { DEFAULT_SETTINGS } from '@podium/runtime'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { HibernationSection } from './hibernation'
import { backstopHours, backstopMinutes } from './hibernation-values'

afterEach(cleanup)

test('the backstop displays hours and commits whole minutes on blur', async () => {
  const patch = vi.fn()
  const settings = {
    ...DEFAULT_SETTINGS,
    hibernation: { ...DEFAULT_SETTINGS.hibernation, enabled: true, backstopMinutes: 2880 },
  }
  render(<HibernationSection settings={settings} patch={patch} />)
  const field = screen.getByRole('spinbutton', { name: 'Always pause after' }) as HTMLInputElement
  expect(field.value).toBe('48')
  fireEvent.change(field, { target: { value: '72' } })
  expect(patch).not.toHaveBeenCalled()
  fireEvent.blur(field)
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith({
      hibernation: { ...settings.hibernation, backstopMinutes: 4320 },
    }),
  )
})

test('turning pausing off visibly disables all dependent limits, preserving the cap note', () => {
  render(
    <HibernationSection
      settings={{
        ...DEFAULT_SETTINGS,
        hibernation: { ...DEFAULT_SETTINGS.hibernation, enabled: false },
      }}
      patch={vi.fn()}
      idleCapUnmet={3}
    />,
  )
  const limits = screen.getByRole('group', { name: 'Idle-session limits' }) as HTMLFieldSetElement
  expect(limits.disabled).toBe(true)
  expect(limits.className).toContain('disabled:opacity-50')
  for (const label of [
    'A session is idle after',
    'Keep at most',
    'Pause sooner when memory is above',
    'Pause sooner when load is above',
    'Close idle shells after',
    'Always pause after',
  ]) {
    expect(limits.contains(screen.getByRole('spinbutton', { name: label }))).toBe(true)
  }
  expect(screen.getByText('Cap unmet: 3 protected/ineligible')).toBeTruthy()
})

test('hours preserve a saved minute value, null and the existing bounds', () => {
  expect(backstopHours(2880)).toBe(48)
  expect(backstopMinutes(backstopHours(61))).toBe(61)
  expect(backstopHours(null)).toBeNull()
  expect(backstopMinutes(null)).toBeNull()
  expect(backstopMinutes(0)).toBe(60)
  expect(backstopMinutes(1000)).toBe(43200)
})
