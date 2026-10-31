import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RowShortcutBadge } from './RowShortcutBadge'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it.each([
  ['MacIntel', '⌘9'],
  ['Win32', '⌃9'],
  ['Linux x86_64', '⌃9'],
])('shows the modifier for %s', (platform, shortcut) => {
  vi.stubGlobal('navigator', { platform, userAgent: '' })
  render(<RowShortcutBadge digit={9} />)
  expect(screen.getByTestId('row-shortcut-badge').textContent).toBe(shortcut)
})
