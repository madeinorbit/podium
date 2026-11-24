import { act, cleanup, render, screen } from '@testing-library/react'
import { createRef, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useContentVisible } from '../lib/visible-content'
import { ChatDeckPager } from './ChatDeckPager'
import { ChatDeckPager as NativePager } from './ChatDeckPager.ios'
import type { ChatDeckPagerHandle } from './chat-deck-pager.types'

const native = vi.hoisted(() => ({
  change: undefined as undefined | ((event: { nativeEvent: { page: number } }) => void),
}))
vi.mock('expo', () => ({
  requireNativeView:
    () =>
    ({ children, onPageChange }: { children: ReactNode; onPageChange: typeof native.change }) => {
      native.change = onPageChange
      return <div>{children}</div>
    },
}))
afterEach(cleanup)
function Page({ name }: { name: string }) {
  return <span data-testid={name}>{String(useContentVisible())}</span>
}

it('keeps both fallback pages mounted but only the selected page active', () => {
  const ref = createRef<ChatDeckPagerHandle>()
  render(<ChatDeckPager ref={ref} chat={<Page name="chat" />} deck={<Page name="deck" />} />)
  expect(screen.getByTestId('chat').textContent).toBe('true')
  expect(screen.getByTestId('deck').textContent).toBe('false')
  act(() => ref.current?.setPage(1))
  expect(screen.getByTestId('chat').textContent).toBe('false')
  expect(screen.getByTestId('deck').textContent).toBe('true')
})

it('follows the native pager event even without a parent page-change handler', () => {
  render(<NativePager chat={<Page name="chat" />} deck={<Page name="deck" />} />)
  expect(screen.getByTestId('deck').textContent).toBe('false')
  act(() => native.change?.({ nativeEvent: { page: 1 } }))
  expect(screen.getByTestId('chat').textContent).toBe('false')
  expect(screen.getByTestId('deck').textContent).toBe('true')
  act(() => native.change?.({ nativeEvent: { page: 0 } }))
  expect(screen.getByTestId('chat').textContent).toBe('true')
})
