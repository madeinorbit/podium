import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId, asSessionId } from '@podium/model'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'

const header = vi.hoisted(() => ({
  options: {} as { unstable_nativeProps?: { headerConfig: { subtitle?: string } } },
  transcriptInset: 0,
}))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ sessionId: 'native-header' }),
  useRouter: () => ({ replace() {}, push() {}, canGoBack: () => false }),
}))
vi.mock('expo-router/stack', () => ({
  Stack: {
    Screen: ({ options }: { options: typeof header.options }) => {
      header.options = options
      return null
    },
  },
}))
vi.mock('expo-router/react-navigation', async () => ({
  HeaderHeightContext: (await import('react')).createContext(103),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}))
vi.mock('../navigation/native-stack', async (original) => ({
  ...(await original<object>()),
  nativeSubtitleAvailable: true,
  transparentDetailHeader: true,
}))
vi.mock('../components/Screen', async () => import('../components/Screen.native'))
vi.mock('../components/SessionConversation', () => ({
  SessionConversation: ({ topInset }: { topInset: number }) => {
    header.transcriptInset = topInset
    return <div data-testid="header-transcript" />
  },
}))
vi.mock('../components/ActionSheet', () => ({ ActionSheet: () => null }))
const { SessionScreen } = await import('./SessionScreen')
afterEach(cleanup)

it('puts session provenance in the native subtitle and leaves the transcript under the scroll edge', async () => {
  const issueId = asIssueId('header-task')
  await renderWithMobileStore(<SessionScreen />, {
    sessions: [
      {
        sessionId: asSessionId('native-header'),
        issueId,
        title: 'Agent',
        agentKind: 'claude-code',
        cwd: '/repo',
        status: 'live',
        archived: false,
        createdAt: '2026-11-13T10:00:00Z',
      } as SessionView,
    ],
    issues: [
      {
        id: issueId,
        repoPath: '/repo',
        prefix: 'PDM',
        seq: 148,
        title: 'Competitive comparison',
        stage: 'in_progress',
        priority: 2,
        archived: false,
        labels: [],
        deps: [],
        dependents: [],
        childCount: 0,
        childDoneCount: 0,
        needsHuman: false,
      } as unknown as IssueViewModel,
    ],
  })
  expect(await screen.findByTestId('header-transcript')).toBeTruthy()
  expect(header.options.unstable_nativeProps?.headerConfig.subtitle).toMatch(/PDM-148.*Claude Code/)
  expect(screen.queryByText(/PDM-148/)).toBeNull()
  expect(header.transcriptInset).toBe(103)
})
