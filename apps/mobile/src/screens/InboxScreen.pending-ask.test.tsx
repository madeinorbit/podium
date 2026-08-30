/**
 * ANSWERING FROM THE INBOX WHILE THE TRANSCRIPT IS STILL SILENT (POD-1273).
 *
 * The needs-you card is the phone's answering surface, and it used to read the
 * question out of the transcript alone — which Claude Code writes only once the
 * call RESOLVES. So during the entire wait the card said the agent needed the
 * operator and offered nothing to press. The transcript stub here returns no
 * items on purpose: that IS the live window.
 */
import type { SessionMeta } from '@podium/model'
import { asSessionId } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/inbox',
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../hooks/useTabBarInset', () => ({ useTabBarInset: () => 72 }))
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Svg = ({ children }: { children?: ReactNode }) => <View>{children}</View>
  return { default: Svg, Svg, Circle: () => null }
})
vi.mock('expo-blur', async () => {
  const { View } = await import('react-native')
  return { BlurView: (props: object) => <View {...props} /> }
})
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
// Sheets drag with react-native-gesture-handler, whose native module has no
// host in this lane. Nothing here opens one.
vi.mock('../components/BottomSheet', () => ({
  BottomSheet: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null,
}))
vi.mock('../components/LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ children }: { children: ReactNode }) => <>{children}</>,
  WorkSkeleton: () => null,
}))
vi.mock('../components/PullToRefreshBoundary', () => ({
  PullToRefreshBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

const { renderWithMobileStore } = await import('../client/test-support')
const { InboxScreen } = await import('./InboxScreen')

/** A live agent parked on an AskUserQuestion, exactly as the hook channel
 *  reports it: the phase, and the whole interview under `need`. */
function blockedOnQuestion(need: object): SessionMeta {
  return {
    agentKind: 'claude-code',
    cwd: '/home/dev/podium',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActiveAt: '2026-08-01T10:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    title: 'Storage picker',
    agentState: {
      phase: 'needs_user',
      since: '2026-08-01T10:05:00.000Z',
      need,
    },
    sessionId: asSessionId('sess_blocked'),
  } as unknown as SessionMeta
}

const INTERVIEW = {
  kind: 'question',
  summary: 'Which database?',
  interview: {
    questions: [
      { question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
    ],
  },
}

describe('Inbox needs-you card, question not yet in the transcript', () => {
  it('offers the interview from agent state and sends the answer', async () => {
    const answer = vi.fn(async () => ({ ok: true }))
    await renderWithMobileStore(<InboxScreen />, {
      sessions: [blockedOnQuestion(INTERVIEW)],
      api: {
        sessions: {
          transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
          answerAskUserQuestion: { mutate: answer },
        },
      },
    })

    const option = await screen.findByLabelText('SQLite')
    fireEvent.click(option)

    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith({
        sessionId: 'sess_blocked',
        choices: [{ optionIndices: [2] }],
      }),
    )
  })

  // A daemon too old to carry the interview reports only that it needs someone.
  // The card must not invent options it was never given — it stays the plain
  // needs-you row it has always been.
  it('draws no options when state carries only the bare need', async () => {
    await renderWithMobileStore(<InboxScreen />, {
      sessions: [blockedOnQuestion({ kind: 'question', summary: 'Which database?' })],
    })

    await screen.findByText('Storage picker')
    expect(screen.queryByLabelText('SQLite')).toBeNull()
  })
})
