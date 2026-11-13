import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('expo-router/stack', () => ({
  Stack: {
    Toolbar: Object.assign(({ children }: { children: ReactNode }) => <header>{children}</header>, {
      Button: ({ accessibilityLabel }: { accessibilityLabel: string }) => (
        <button type="button">{accessibilityLabel}</button>
      ),
    }),
  },
}))
const { ComposeSheetHeader } = await import('./ComposeSheetHeader.native')
afterEach(cleanup)

it('leaves Cancel in the native header and keeps Send away from the New work button position', () => {
  render(
    <ComposeSheetHeader
      hasPrompt={false}
      busy={false}
      canStart
      canSave={false}
      onCancel={vi.fn()}
      onStart={vi.fn()}
      onSave={vi.fn()}
    />,
  )
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  expect(screen.getAllByRole('button')).toHaveLength(1)
})
