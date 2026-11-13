import { cleanup, fireEvent, render, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const continuity = vi.hoisted(() => ({
  connected: true,
  phase: 'live',
  outboxSize: 0,
  deadLetters: 0,
  push: vi.fn(),
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: continuity.push }) }))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' } }))
vi.mock('../client/hooks', () => ({ useConnected: () => continuity.connected }))
vi.mock('../client/workspace-refresh', () => ({
  useWorkspaceSyncPhase: () => continuity.phase,
}))
vi.mock('../client/use-pool-notices', () => ({ usePoolContinuity: () => continuity }))
vi.mock('../client/ServerProfileGate', () => ({
  useServerProfile: () => ({ profile: { name: 'RIG' } }),
}))
vi.mock('@expo/ui/swift-ui', () => ({
  VStack: ({ children }: { children: ReactNode }) => (
    <div data-testid="native-notice-row">{children}</div>
  ),
  RNHostView: ({
    children,
    matchContents,
  }: {
    children: ReactNode
    matchContents: { vertical?: boolean; horizontal?: boolean }
  }) => (
    <div data-testid="notice-host" data-sizing={JSON.stringify(matchContents)}>
      {children}
    </div>
  ),
}))
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  listRowBackground: vi.fn(),
  listRowSeparator: vi.fn(),
  listRowInsets: vi.fn(),
}))

const { ListNotices } = await import('./list-notices.ios')
const { WorkspaceContinuityNotice } = await import('./WorkspaceContinuityNotice')

afterEach(() => {
  cleanup()
  Object.assign(continuity, { connected: true, phase: 'live', outboxSize: 0, deadLetters: 0 })
  vi.clearAllMocks()
})

it('adds a content-sized native row only while a notice is visible, including queued changes', () => {
  const tree = (
    <ListNotices>
      <WorkspaceContinuityNotice />
    </ListNotices>
  )
  const view = render(tree)
  expect(view.queryByTestId('native-notice-row')).toBeNull()

  Object.assign(continuity, { connected: false, phase: 'offline', outboxSize: 1 })
  view.rerender(
    <ListNotices>
      <WorkspaceContinuityNotice />
    </ListNotices>,
  )
  const row = view.getByTestId('native-notice-row')
  expect(within(row).getByText('Offline. Showing saved data for RIG.')).toBeTruthy()
  expect(within(row).getByText('1 change is queued and will send when connected.')).toBeTruthy()
  expect(within(row).getByText('Settings')).toBeTruthy()
  // Width stays constrained by the native row; height follows all wrapped lines.
  expect(within(row).getByTestId('notice-host').getAttribute('data-sizing')).toBe(
    JSON.stringify({ vertical: true }),
  )
  fireEvent.click(within(row).getByRole('button'))
  expect(continuity.push).toHaveBeenCalledWith('/settings')

  Object.assign(continuity, { connected: true, phase: 'live', outboxSize: 0 })
  view.rerender(tree)
  expect(view.queryByTestId('native-notice-row')).toBeNull()
})

it('keeps recovery review inside the native list when the connection is live', () => {
  continuity.deadLetters = 2
  const view = render(
    <ListNotices>
      <WorkspaceContinuityNotice />
    </ListNotices>,
  )
  const row = view.getByTestId('native-notice-row')
  expect(within(row).getByText('2 changes need review in Settings.')).toBeTruthy()
  expect(within(row).queryByText(/Offline/)).toBeNull()
})
