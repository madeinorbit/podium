import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RepoPickerModal } from './RepoPickerModal'

const trpc = vi.hoisted(() => ({}))

vi.mock('@/features/settings/stable-access', () => ({ useSettingsTrpc: () => trpc }))
vi.mock('./GitHubProjectIntake', () => ({ GitHubProjectIntake: () => null }))

afterEach(cleanup)

test('the embedded picker shares the pane and returns without a dialog', () => {
  const onClose = vi.fn()
  render(<RepoPickerModal embedded onClose={onClose} onPick={vi.fn()} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('heading', { name: 'Add a repository' })).toBeTruthy()
  const picker = screen.getByRole('region', { name: 'Repository picker' })
  expect(document.activeElement).toBe(picker)
  fireEvent.keyDown(picker, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledExactlyOnceWith()
})
