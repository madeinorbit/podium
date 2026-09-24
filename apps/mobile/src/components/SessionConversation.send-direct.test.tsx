/**
 * THE PHONE HANDS A LIVE-SESSION SEND TO THE SERVER AT ONCE (POD-4688).
 *
 * Two messages tapped into a busy agent must both leave the phone without
 * waiting for any turn event, in order — the desktop's contract. They go out
 * as direct `sendText` mutates (the desktop chat's `session` route), not
 * through the durable outbox: `resumeAndSend` must not be called for them.
 */
import type { SessionMeta } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { act, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConnected } from '../client/hooks'
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
vi.mock('./TranscriptList', () => ({
  TranscriptList: ({ pendingTurns }: { pendingTurns?: readonly PendingTurn[] }) => (
    <div>
      {(pendingTurns ?? []).map((turn) => (
        <div key={turn.id} data-testid="pending">
          {turn.text}
        </div>
      ))}
    </div>
  ),
}))

const { SessionConversation } = await import('./SessionConversation')

const busy = {
  sessionId: 'sess-busy',
  agentKind: 'claude-code',
  cwd: '/repo',
  status: 'live',
  title: 'Agent',
  agentState: { phase: 'working', since: '2026-09-24T10:00:00.000Z' },
} as unknown as SessionMeta

let transportUp: boolean | null = null

function ConnectedProbe() {
  transportUp = useConnected()
  return null
}

describe('live-session sends go direct', () => {
  it('two taps into a busy agent POST sendText twice, in order, with no turn event', async () => {
    const posts: Array<{ text: string; mutationId: string }> = []
    const sendText = vi.fn(async (input: { text: string; mutationId: string }) => {
      posts.push({ text: input.text, mutationId: input.mutationId })
      return { ok: true, queued: true, disposition: 'queued', position: posts.length }
    })
    const resumeAndSend = vi.fn(async () => ({ ok: true }))
    const { container } = await renderWithMobileStore(
      <>
        <ConnectedProbe />
        <SessionConversation session={busy} issue={undefined} />
      </>,
      {
        sessions: [busy],
        api: {
          sessions: {
            transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
            answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
            sendText: { mutate: sendText },
            resumeAndSend: { mutate: resumeAndSend },
          },
          messages: {
            ledger: { query: async () => [] },
            cancel: { mutate: async () => {} },
          },
        },
      },
    )
    // The direct path is the ONLINE path: the socket must be up before tapping,
    // or the sends correctly take the held offline route instead.
    await waitFor(() => expect(transportUp).toBe(true))
    await act(async () => {})

    const input = container.querySelector('textarea')
    expect(input).not.toBeNull()
    if (!input) return
    fireEvent.change(input, { target: { value: 'first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.change(input, { target: { value: 'second' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    // Both handed on with no transcript echo, no agent-state change, and no
    // wait for the running turn — in tap order, under distinct sends.
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(2))
    expect(posts.map((post) => post.text)).toEqual(['first', 'second'])
    expect(posts[0]?.mutationId).not.toBe(posts[1]?.mutationId)
    expect(resumeAndSend).not.toHaveBeenCalled()
  })
})
