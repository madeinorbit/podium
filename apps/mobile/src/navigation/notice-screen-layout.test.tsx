import { cleanup, render } from '@testing-library/react'
import { createContext } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ focused: true }))
const HeaderHeightContext = createContext(120)
vi.mock('expo-router/react-navigation', () => ({
  get HeaderHeightContext() {
    return HeaderHeightContext
  },
  useIsFocused: () => state.focused,
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}))
vi.mock('../components/MessageNoticeBanner', () => ({
  MessageNoticeBanner: ({ topInset }: { topInset: number }) => (
    <div data-testid="notice" data-top={topInset} />
  ),
}))
const { NoticeScreen, noticeScreenLayout } = await import('./notice-screen-layout')
afterEach(() => {
  cleanup()
  state.focused = true
})

it('tracks the native transparent header as its height changes', () => {
  const tree = (height: number) => (
    <HeaderHeightContext value={height}>
      <NoticeScreen options={{ headerTransparent: true }}>
        <div>Chat</div>
      </NoticeScreen>
    </HeaderHeightContext>
  )
  const view = render(tree(160))
  expect(view.getByTestId('notice').getAttribute('data-top')).toBe('160')
  view.rerender(tree(76))
  expect(view.getByTestId('notice').getAttribute('data-top')).toBe('76')
})

it('does not pay an opaque header twice and respects headerless safe areas', () => {
  const view = render(
    <NoticeScreen options={{}}>
      <div>Tasks</div>
    </NoticeScreen>,
  )
  expect(view.getByTestId('notice').getAttribute('data-top')).toBe('0')
  view.rerender(
    <NoticeScreen options={{ headerShown: false }}>
      <div>Sheet</div>
    </NoticeScreen>,
  )
  expect(view.getByTestId('notice').getAttribute('data-top')).toBe('24')
})

it('leaves inactive screens and the tabs container without a duplicate notice', () => {
  state.focused = false
  const view = render(
    <NoticeScreen options={{}}>
      <div>Old screen</div>
    </NoticeScreen>,
  )
  expect(view.queryByTestId('notice')).toBeNull()
  view.rerender(
    noticeScreenLayout({ route: { name: '(tabs)' }, options: {}, children: <div>Tabs</div> }),
  )
  expect(view.queryByTestId('notice')).toBeNull()
})
