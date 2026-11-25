/**
 * POD-7169 — the phone mission screen while its mission is on its way. The
 * loading crossfade keeps its content mounted under the placeholder, and the
 * content was "Mission not found." until the deck settled: a screen reader and
 * any text probe read "not found" for a mission that was loading. Not found is
 * only the opening's settled answer.
 */

import type { MobxPool } from '@podium/client-graph/pool'
import { openEmptyDevice } from '@podium/client-graph/test-support/empty-device.test.fixture'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const opening = vi.hoisted(() => ({
  value: { screen: null as unknown, resolved: false },
  connected: true,
  pool: null as MobxPool | null,
  dispose: null as (() => void) | null,
  router: { canGoBack: () => false, back: () => {}, replace: () => {}, push: () => {} },
  navigation: { addListener: () => () => {}, dispatch: () => {} },
  seatMemory: { recall: () => null, remember: () => {} },
}))

vi.mock('expo-haptics', () => ({ selectionAsync: async () => {} }))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ missionId: 'iss_root' }),
  useRouter: () => opening.router,
  useNavigation: () => opening.navigation,
}))
vi.mock('expo-router/react-navigation', async () => {
  const { createContext } = await import('react')
  return {
    HeaderHeightContext: createContext<number | undefined>(undefined),
    usePreventRemove: () => {},
  }
})
vi.mock('@podium/client-core/react', () => ({
  useCommands: () => ({}),
  useHarnessDescriptors: () => ({ served: undefined }),
}))
vi.mock('../client/hooks', () => ({
  useMissionOpening: () => opening.value,
  useConnected: () => opening.connected,
  useTaskSeatMemory: () => opening.seatMemory,
}))
vi.mock('../client/mobile-pool', () => ({
  useMobilePool: () => opening.pool,
  useMobilePoolProjection: <T,>(_read: unknown, empty: T) => empty,
}))
vi.mock('../client/screen-read-focus', () => ({ useScreenReadFocus: () => {} }))
vi.mock('../client/use-issue-close', () => ({ useIssueCloseGuard: () => () => false }))
vi.mock('../components/Screen', () => ({
  Screen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HeaderButton: () => null,
}))
vi.mock('../components/TaskSheet', () => ({ TaskSheet: () => null }))
vi.mock('../components/ActionSheet', () => ({ ActionSheet: () => null }))
vi.mock('../components/ConfiguredIssueLaunchSheet', () => ({
  ConfiguredIssueLaunchSheet: () => null,
}))
vi.mock('../components/IssueCloseSheet', () => ({ IssueCloseSheet: () => null }))
vi.mock('../components/SessionConversation', () => ({ SessionConversation: () => null }))
vi.mock('../components/MissionBar', () => ({ MissionBar: () => null }))
vi.mock('../components/AgentMark', () => ({ HarnessChip: () => null }))

const { MissionScreen } = await import('./MissionScreen')
const { MissionDetailsScreen } = await import('./MissionDetailsScreen')

afterEach(() => {
  cleanup()
  opening.value = { screen: null, resolved: false }
  opening.connected = true
  opening.dispose?.()
  opening.dispose = null
  opening.pool = null
})

it.each([
  ['mission', MissionScreen],
  ['mission details', MissionDetailsScreen],
] as const)('%s shows offline availability while shared body readiness remains unresolved', async (_name, Route) => {
  const device = await openEmptyDevice()
  opening.pool = device.pool
  opening.dispose = () => device.dispose()
  device.offline()
  opening.connected = false
  opening.value = { screen: null, resolved: false }
  const view = render(<Route />)
  expect(view.getByText('Not available offline')).toBeTruthy()
  expect(view.container.querySelector('[aria-busy="true"]')).toBeNull()
  expect(view.container.textContent).not.toContain('Mission not found')
})

it('never says "not found" while the mission is on its way; says it once the opening settles without one', () => {
  const view = render(<MissionScreen />)
  // Loading: nothing answers "not found". (dev/tf shows no skeleton while the
  // mission is on its way, so upstream's "Loading task detail" check is gone.)
  expect(view.container.textContent).not.toContain('Mission not found')

  // The lookup settled and the selection names no mission: now it is the answer.
  // (A fresh mount: the screen is a memoized observer, and the mocked opening
  // is no observable, so a rerender with the same props would not read it.)
  view.unmount()
  opening.value = { screen: null, resolved: true }
  const settled = render(<MissionScreen />)
  expect(settled.container.textContent).toContain('Mission not found')
})

it('offline, a mission this phone does not hold is "not available offline", never "not found" (POD-7176)', () => {
  opening.value = { screen: null, resolved: true }
  opening.connected = false
  const view = render(<MissionScreen />)
  expect(view.container.textContent).toContain('Not available offline')
  expect(view.container.textContent).not.toContain('Mission not found')
})
