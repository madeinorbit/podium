import type { SessionView } from '@podium/client-core/session-values'
/**
 * A MESSAGE THE SERVER GAVE UP ON STAYS VISIBLE IN THE SESSION CHAT [POD-4704].
 *
 * The phone used to drop terminal ledger rows off the surface, so a send the
 * authority gave up on looked like a send that never happened. The bubble now
 * comes from the message's synced record, by id (POD-4764), with the shared
 * wording: an injected-but-unconfirmed message (delivery-failed) reads as
 * delivery failed, never as a vanished target, while a causeless one still
 * reads target gone — and its way on is "Send again", a new message.
 */
import { asSessionId, type MessageRecordWire } from '@podium/model'
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
        <div key={turn.id} data-testid={turn.notice ? 'not-delivered-chat-message' : 'pending'}>
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
} as unknown as SessionView

function failedRecord(over: Partial<MessageRecordWire> = {}): MessageRecordWire {
  return {
    id: 'msg_dead',
    sessionId: asSessionId('sess-1'),
    senderUserId: 'user:test',
    body: 'typed but never confirmed',
    createdAt: '2026-09-13T18:00:00.000Z',
    status: 'failed',
    ...over,
  }
}

async function renderWithRecords(messageRecords: MessageRecordWire[]) {
  await renderWithMobileStore(<SessionConversation session={live} issue={undefined} />, {
    sessions: [live],
    messageRecords,
    api: {
      sessions: {
        transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
        answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
        sendText: { mutate: async () => ({ ok: true }) },
        resumeAndSend: { mutate: async () => ({ ok: true }) },
      },
      messages: {
        cancel: { mutate: async () => {} },
        dismissNotice: { mutate: async () => {} },
      },
    },
  })
}

describe('messages the server gave up on stay visible', () => {
  it('shows an unconfirmed send as delivery failed, never target gone', async () => {
    await renderWithRecords([failedRecord({ reason: 'delivery-failed' })])
    await waitFor(() => expect(screen.getByTestId('not-delivered-chat-message')).toBeTruthy())
    const text = screen.getByTestId('not-delivered-chat-message').textContent ?? ''
    expect(text).toContain('typed but never confirmed')
    expect(text).toContain('delivery failed')
    expect(text).not.toContain('target gone')
  })

  it('keeps target gone only for a target that is really gone', async () => {
    await renderWithRecords([failedRecord({})])
    await waitFor(() => expect(screen.getByTestId('not-delivered-chat-message')).toBeTruthy())
    const text = screen.getByTestId('not-delivered-chat-message').textContent ?? ''
    expect(text).toContain('target gone')
  })
})
