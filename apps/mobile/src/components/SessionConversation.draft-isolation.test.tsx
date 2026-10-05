import type { SessionView } from '@podium/client-core/session-values'
/**
 * DRAFT EDITS STAY INSIDE THE COMPOSER (this issue).
 *
 * Typing in the phone composer used to re-render the whole conversation view:
 * SessionConversation subscribed to the full conversation controller, so every
 * key woke the screen and the unmemoized TranscriptList (with fresh inline
 * props) re-rendered too, plus a second wake via the stored-draft hook. The
 * screen now subscribes to the controller SURFACE only; a small composer leaf
 * owns the draft subscription, the stored-draft hook and the replaceDraft
 * effect; Stop reads the draft at press time. Typing N keys must render the
 * transcript 0 times and the screen 0 times, while the composer itself updates
 * and draft saving/Stop behaviour is unchanged (covered by existing tests).
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('expo-blur', async () => {
  const { View } = await import('react-native')
  return { BlurView: (props: object) => <View {...props} /> }
})
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock('./LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ children }: { children: ReactNode }) => <>{children}</>,
  TranscriptSkeleton: () => null,
}))
vi.mock('./PullToRefreshBoundary', () => ({
  PullToRefreshBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

const screenRenders = vi.hoisted(() => ({ count: 0 }))
const transcriptRenders = vi.hoisted(() => ({ count: 0 }))

vi.mock('./SessionLifecycle', () => ({
  MobileSessionLifecycle: () => {
    screenRenders.count += 1
    return null
  },
}))
vi.mock('./TaskSheet', () => ({ TaskSheet: () => null }))
vi.mock('./ArtifactViewer', () => ({ ArtifactViewer: () => null }))
vi.mock('./TranscriptList', () => ({
  TranscriptList: () => {
    transcriptRenders.count += 1
    return null
  },
}))

const { SessionConversation } = await import('./SessionConversation')

const session = {
  sessionId: 'sess-draft-isolation',
  agentKind: 'claude-code',
  cwd: '/repo',
  status: 'live',
  title: 'Agent',
  agentState: { phase: 'working', since: '2026-09-23T12:00:00.000Z' },
} as unknown as SessionView

describe('phone composer draft isolation', () => {
  it('typing N keys renders the transcript 0 times and the screen 0 times', async () => {
    screenRenders.count = 0
    transcriptRenders.count = 0
    await renderWithMobileStore(<SessionConversation session={session} issue={undefined} />, {
      sessions: [session],
      api: {
        sessions: {
          transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
          answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
          interrupt: { mutate: async () => ({ ok: true }) },
        },
      },
    })

    // Let mount settle: composer field present, initial transcript/screen paints done.
    const input = (await screen.findByPlaceholderText(
      'Message the agent…',
    )) as unknown as HTMLTextAreaElement
    // Composer placeholder comes from session state; fall back to any textarea.
    const field =
      (input as unknown as { value?: string } | null) !== null
        ? (input as HTMLTextAreaElement)
        : (document.querySelector('textarea') as HTMLTextAreaElement)
    expect(field).not.toBeNull()
    await waitFor(() => expect(transcriptRenders.count).toBeGreaterThan(0))
    await waitFor(() => expect(screenRenders.count).toBeGreaterThan(0))

    const transcriptBaseline = transcriptRenders.count
    const screenBaseline = screenRenders.count

    const keys = ['h', 'he', 'hel', 'hell', 'hello']
    for (const value of keys) {
      fireEvent.change(field, { target: { value } })
    }

    // The composer itself reflects the draft.
    await waitFor(() => expect(field.value).toBe('hello'))

    // Neither the transcript nor the screen re-rendered for any key.
    expect(transcriptRenders.count).toBe(transcriptBaseline)
    expect(screenRenders.count).toBe(screenBaseline)
  })
})
