/**
 * ACCEPTING AN OFFER IS A SEND, AND MUST LOOK LIKE ONE [POD-1354].
 *
 * The action button used to call straight through to the wire with no
 * optimistic half: the card stayed put, no bubble appeared, and the tail still
 * read idle until the server echoed the turn — minutes, on the parked session an
 * offer usually comes from. These tests pin all three optimistic parts and,
 * just as importantly, pin that a REFUSED send puts every one of them back.
 */

import type { SessionMeta } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import type { PendingTurn } from './TranscriptList'

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
vi.mock('./SessionLifecycle', () => ({ MobileSessionLifecycle: () => null }))
vi.mock('./TaskSheet', () => ({ TaskSheet: () => null }))
vi.mock('./Composer', () => ({ Composer: () => null }))

/**
 * The transcript, reduced to the three facts these tests are about: the footer
 * (where the offer card lives), the optimistic rows, and the tail's tone.
 */
vi.mock('./TranscriptList', () => ({
  TranscriptList: ({
    footer,
    pendingTurns,
    tail,
  }: {
    footer?: ReactNode
    pendingTurns?: readonly PendingTurn[]
    tail?: { label: string; tone: string }
  }) => (
    <div>
      <div data-testid="tail">{`${tail?.tone ?? 'none'}:${tail?.label ?? ''}`}</div>
      {(pendingTurns ?? []).map((turn) => (
        <div key={turn.id} data-testid="pending">
          {turn.failed ? `failed:${turn.text}` : turn.text}
        </div>
      ))}
      {footer}
    </div>
  ),
}))

const { SessionConversation } = await import('./SessionConversation')

const OFFER_AT = '2026-08-18T12:00:00.000Z'

const session = {
  sessionId: 'sess-1',
  agentKind: 'claude-code',
  cwd: '/repo',
  status: 'live',
  title: 'Agent',
  offer: {
    createdAt: OFFER_AT,
    message: 'Login screen ready to merge',
    actions: [{ label: 'Merge', prompt: 'merge it' }],
  },
} as unknown as SessionMeta

describe('offer accept is optimistic', () => {
  it('drops the card, paints the prompt, and says working before the server answers', async () => {
    const sendText = vi.fn(async () => ({ ok: true }))
    await renderWithMobileStore(<SessionConversation session={session} issue={undefined} />, {
      sessions: [session],
      api: {
        sessions: {
          transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
          answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
          sendText: { mutate: sendText },
          resumeAndSend: { mutate: sendText },
        },
      },
    })

    expect(screen.getByTestId('session-action-card')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Merge'))

    // No await on the mutation: this is the state the operator sees on the press.
    await waitFor(() => expect(screen.queryByTestId('session-action-card')).toBeNull())
    expect(screen.getByTestId('pending').textContent).toBe('merge it')
    expect(screen.getByTestId('tail').textContent).toContain('working')
    await waitFor(() =>
      expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'merge it' })),
    )
  })

  it('puts the offer back and marks the row not-sent when the send is refused', async () => {
    const refused = vi.fn(async () => ({ ok: false, reason: 'no route to the agent' }))
    await renderWithMobileStore(<SessionConversation session={session} issue={undefined} />, {
      sessions: [session],
      api: {
        sessions: {
          transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
          answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
          sendText: { mutate: refused },
          resumeAndSend: { mutate: refused },
        },
      },
    })

    fireEvent.click(screen.getByLabelText('Merge'))

    // A hidden offer over a swallowed send is the worst outcome of the three:
    // the decision looks taken and nothing was asked.
    await waitFor(() => expect(screen.getByTestId('session-action-card')).toBeTruthy())
    // The reason rides on the ROW, which also carries the retry — one error in
    // one place rather than a red card over a red bubble.
    expect(screen.getByTestId('pending').textContent).toBe('failed:merge it')
  })
})
