/**
 * THE PHONE WAKES A PARKED SESSION AT ONCE (POD-4799).
 *
 * A send into an ended session waited ~23 s in the client before the wake POST
 * went out: the store action queued it through the durable outbox, whose store
 * commit and drain share the replica's own transaction domain (SQLite here, so
 * a bulk sync apply holds the wake behind it). While the socket is up the wake
 * is one direct `resumeAndSend` mutate in the tap's own async chain — the
 * parked twin of POD-4688's live-session send. The turn's stable delivery id
 * rides as the mutation id, so a retry after a lost response dedupes
 * server-side instead of waking twice.
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
        <div key={turn.id} data-testid={turn.failed ? 'pending-failed' : 'pending'}>
          {turn.text}
          {turn.failed ? ` failed: ${turn.failed}` : ''}
        </div>
      ))}
    </div>
  ),
}))

const { SessionConversation } = await import('./SessionConversation')

const parked = {
  sessionId: 'sess-parked',
  agentKind: 'claude-code',
  cwd: '/repo',
  status: 'hibernated',
  resumable: true,
  title: 'Agent',
  agentState: { phase: 'ended', since: '2026-09-24T10:00:00.000Z' },
} as unknown as SessionMeta

let transportUp: boolean | null = null

function ConnectedProbe() {
  transportUp = useConnected()
  return null
}

function fixture(apiSessions: object) {
  return {
    sessions: [parked],
    api: {
      sessions: {
        transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
        answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
        sendText: { mutate: vi.fn(async () => ({ ok: true, disposition: 'delivered' })) },
        ...apiSessions,
      },
      messages: {
        ledger: { query: async () => [] },
        cancel: { mutate: async () => {} },
      },
    },
  }
}

async function tapSend(container: HTMLElement, text: string): Promise<void> {
  const input = container.querySelector('textarea')
  expect(input).not.toBeNull()
  if (!input) return
  await act(async () => {
    fireEvent.change(input, { target: { value: text } })
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  })
}

describe('parked-session sends go direct while online', () => {
  it('one tap into an ended session POSTs resumeAndSend once, never sendText', async () => {
    const posts: Array<{ text: string; mutationId: string }> = []
    const resumeAndSend = vi.fn(async (input: { text: string; mutationId: string }) => {
      posts.push({ text: input.text, mutationId: input.mutationId })
      return { ok: true, queued: true, disposition: 'queued', position: posts.length }
    })
    const sendText = vi.fn(async () => ({ ok: true, disposition: 'delivered' }))
    const { container } = await renderWithMobileStore(
      <>
        <ConnectedProbe />
        <SessionConversation session={parked} issue={undefined} />
      </>,
      fixture({ sendText: { mutate: sendText }, resumeAndSend: { mutate: resumeAndSend } }),
    )
    // The direct path is the ONLINE path: the socket must be up before tapping,
    // or the send correctly takes the held offline route instead.
    await waitFor(() => expect(transportUp).toBe(true))
    await act(async () => {})

    await tapSend(container as unknown as HTMLElement, 'wake the agent')

    await waitFor(() => expect(resumeAndSend).toHaveBeenCalledTimes(1))
    expect(posts.map((post) => post.text)).toEqual(['wake the agent'])
    expect(posts[0]?.mutationId).toMatch(/^msg_/)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('a refused wake keeps a failed bubble and never retries behind a timer', async () => {
    // The outbox path answers a refused POST with another POST: the entry
    // stays queued and the drain retries it on backoff, so one tap wakes the
    // session twice (or more). The direct path fails the turn once, visibly,
    // and a retry reuses the same id — exactly once on the wire, whatever the
    // timers do afterwards.
    const resumeAndSend = vi.fn(async () => {
      throw new Error('socket down')
    })
    const { container } = await renderWithMobileStore(
      <>
        <ConnectedProbe />
        <SessionConversation session={parked} issue={undefined} />
      </>,
      fixture({ resumeAndSend: { mutate: resumeAndSend } }),
    )
    await waitFor(() => expect(transportUp).toBe(true))
    await act(async () => {})

    vi.useFakeTimers()
    try {
      await tapSend(container as unknown as HTMLElement, 'wake the agent')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(screen.queryByTestId('pending-failed')).not.toBeNull()
      expect(screen.queryByTestId('pending-failed')?.textContent).toContain('wake the agent')
      expect(resumeAndSend).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(resumeAndSend).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
