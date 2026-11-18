/**
 * POD-7169 — the phone mission screen while its mission is on its way. The
 * loading crossfade keeps its content mounted under the placeholder, and the
 * content was "Mission not found." until the deck settled: a screen reader and
 * any text probe read "not found" for a mission that was loading. Not found is
 * only the opening's settled answer.
 */
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const opening = vi.hoisted(() => ({
  value: { screen: null as unknown, resolved: false },
}))

vi.mock('expo-haptics', () => ({ selectionAsync: async () => {} }))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ missionId: 'iss_root' }),
  useRouter: () => ({ canGoBack: () => false, back: () => {}, replace: () => {}, push: () => {} }),
}))
vi.mock('@podium/client-core/react', () => ({
  useCommands: () => ({}),
  useHarnessDescriptors: () => ({ served: undefined }),
}))
vi.mock('../client/hooks', () => ({ useMissionOpening: () => opening.value }))
vi.mock('../client/mobile-pool', () => ({ useMobilePool: () => null }))
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

afterEach(() => {
  cleanup()
  opening.value = { screen: null, resolved: false }
})

it('never says "not found" while the mission is on its way; says it once the opening settles without one', () => {
  const view = render(<MissionScreen />)
  // Loading: the placeholder, and nothing under it that answers "not found".
  expect(view.container.textContent).not.toContain('Mission not found')
  expect(screen.getAllByLabelText('Loading task detail').length).toBeGreaterThan(0)

  // The lookup settled and the selection names no mission: now it is the answer.
  // (A fresh mount: the screen is a memoized observer, and the mocked opening
  // is no observable, so a rerender with the same props would not read it.)
  view.unmount()
  opening.value = { screen: null, resolved: true }
  const settled = render(<MissionScreen />)
  expect(settled.container.textContent).toContain('Mission not found')
})
