import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const continuity = vi.hoisted(() => ({
  connected: true,
  phase: 'live',
  outboxSize: 0,
  deadLetters: 0,
  push: vi.fn(),
}))
const native = vi.hoisted(() => ({
  measure: undefined as ((frame: { width: number }) => void) | undefined,
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
  VStack: ({
    children,
    modifiers,
  }: {
    children: ReactNode
    modifiers: ({ name: string; value: unknown } | undefined)[]
  }) => {
    native.measure = modifiers.find((modifier) => modifier?.name === 'onGeometryChange')
      ?.value as typeof native.measure
    return <div data-testid="native-notice-row">{children}</div>
  },
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
  frame: (value: unknown) => ({ name: 'frame', value }),
  onGeometryChange: (value: unknown) => ({ name: 'onGeometryChange', value }),
  listRowBackground: vi.fn(),
  listRowSeparator: vi.fn(),
  listRowInsets: vi.fn(),
}))

const { ListNotices } = await import('./list-notices.ios')
const { WorkspaceContinuityNotice } = await import('./WorkspaceContinuityNotice')

function measureRow(width: number) {
  expect(native.measure).toBeTypeOf('function')
  act(() => native.measure?.({ width }))
}

afterEach(() => {
  cleanup()
  native.measure = undefined
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
  // No unconstrained content is mounted before SwiftUI reports the row width.
  expect(within(row).queryByText('Settings')).toBeNull()
  measureRow(358)
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
  measureRow(358)
  expect(within(row).getByText('2 changes need review in Settings.')).toBeTruthy()
  expect(within(row).queryByText(/Offline/)).toBeNull()
})

it.each([
  288, 358,
])('constrains Yoga to the measured %spt row and follows native resizing', (width) => {
  Object.assign(continuity, { connected: false, phase: 'offline', outboxSize: 1 })
  const view = render(
    <ListNotices>
      <WorkspaceContinuityNotice />
    </ListNotices>,
  )
  const root = view.getByTestId('notice-host').firstElementChild as HTMLElement
  measureRow(width)
  expect(root.style.width).toBe(`${width}px`)
  const card = view.getByTestId('workspace-continuity-notice')
  const container = card.parentElement as HTMLElement
  // The section supplies the outer inset, so the hosted card reaches its edges.
  expect(container.parentElement).toBe(root)
  expect(Number.parseFloat(getComputedStyle(container).paddingLeft) || 0).toBe(0)
  expect(Number.parseFloat(getComputedStyle(container).paddingRight) || 0).toBe(0)
  expect(within(card).getByText('Settings')).toBeTruthy()

  measureRow(width + 100)
  expect(root.style.width).toBe(`${width + 100}px`)
  expect(view.getByTestId('workspace-continuity-notice')).toBe(card)
  expect(root.style.height).toBe('')
})

it('retains the standalone notice inset outside a native list', () => {
  Object.assign(continuity, { connected: false, phase: 'offline' })
  const view = render(<WorkspaceContinuityNotice />)
  const container = view.getByTestId('workspace-continuity-notice').parentElement as HTMLElement
  const standalone = container.parentElement as HTMLElement
  expect(standalone.style.paddingLeft).toBe('12px')
  expect(standalone.style.paddingRight).toBe('12px')
  expect(view.queryByTestId('notice-host')).toBeNull()
})
