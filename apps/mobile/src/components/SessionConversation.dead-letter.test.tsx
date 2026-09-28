/**
 * A DEAD-LETTERED OPERATOR SEND STAYS VISIBLE IN THE SESSION CHAT [POD-4704].
 *
 * The phone used to drop terminal ledger rows off the surface: the controller
 * keeps only `queued` rows, so a send the authority gave up on looked like a
 * send that never happened. The conversation now restores dead-lettered
 * operator rows as failed bubbles — the web chat's path, same shared wording:
 * an injected-but-unconfirmed row (delivery-failed) reads as delivery failed,
 * never as a vanished target, while a causeless row still reads target gone.
 */
import type { SessionMeta } from '@podium/model'
import { cleanup, screen, waitFor } from '@testing-library/react'
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
vi.mock('./ArtifactViewer', () => ({ ArtifactViewer: () => null }))
vi.mock('./Composer', () => ({ Composer: () => null }))
// Render the failure REASON, not just the text: the assertion is the wording,
// so the mock must show what the row says happened.
vi.mock('./TranscriptList', () => ({
  TranscriptList: ({ pendingTurns }: { pendingTurns?: readonly PendingTurn[] }) => (
    <div>
      {(pendingTurns ?? []).map((turn) => (
        <div
          key={turn.id}
          data-testid={turn.id.startsWith('dead-letter:') ? 'dead-lettered-chat-message' : 'pending'}
        >
          {turn.failed ? `${turn.text} · ${turn.failed}` : turn.text}
        </div>
      ))}
    </div>
  ),
}))

const { SessionConversation } = await import('./SessionConversation')

const live = {
  sessionId: 'sess-1',
  agentKind: 'claude-code',
  cwd: '/repo',
  status: 'live',
  title: 'Agent',
} as unknown as SessionMeta

function deadLetterRow(over: Record<string, unknown> = {}) {
  return {
    from: 'operator',
    to: 'session:sess-1',
    status: 'dead_letter',
    id: 'msg_dead',
    body: 'typed but never confirmed',
    createdAt: '2026-09-13T18:00:00.000Z',
    ...over,
  }
}

async function renderWithLedger(rows: unknown[]) {
  await renderWithMobileStore(<SessionConversation session={live} issue={undefined} />, {
    sessions: [live],
    api: {
      sessions: {
        transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
        answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
        sendText: { mutate: async () => ({ ok: true }) },
        resumeAndSend: { mutate: async () => ({ ok: true }) },
      },
      messages: {
        ledger: { query: async () => rows },
        cancel: { mutate: async () => {} },
      },
    },
  })
}

describe('dead-lettered operator sends stay visible', () => {
  it('shows an unconfirmed send as delivery failed, never target gone', async () => {
    await renderWithLedger([deadLetterRow({ deliveryDeferredReason: 'delivery-failed' })])
    await waitFor(() => expect(screen.getByTestId('dead-lettered-chat-message')).toBeTruthy())
    const text = screen.getByTestId('dead-lettered-chat-message').textContent ?? ''
    expect(text).toContain('typed but never confirmed')
    expect(text).toContain('delivery failed')
    expect(text).not.toContain('target gone')
  })

  it('keeps target gone only for a target that is really gone', async () => {
    await renderWithLedger([deadLetterRow({})])
    await waitFor(() => expect(screen.getByTestId('dead-lettered-chat-message')).toBeTruthy())
    const text = screen.getByTestId('dead-lettered-chat-message').textContent ?? ''
    expect(text).toContain('target gone')
  })
})
