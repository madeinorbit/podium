/**
 * THE PHONE CAN STOP A RUNNING TURN [POD-4645].
 *
 * The session screen said "Working…" and offered nothing to end it: the
 * composer had attach, mic and send, and the only way out was Open terminal →
 * Esc through the xterm. The desktop composer has a Stop control that calls the
 * shared conversation controller's `interrupt`, which sends `sessions.interrupt`
 * with the exact queued message it selected. These tests hold the phone to the
 * same contract, through the REAL composer: Stop is drawn only while a turn
 * runs, a press sends that same command, and a refusal is said out loud rather
 * than swallowed.
 */

import type { SessionMeta } from '@podium/model'
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
vi.mock('./SessionLifecycle', () => ({ MobileSessionLifecycle: () => null }))
vi.mock('./TaskSheet', () => ({ TaskSheet: () => null }))
vi.mock('./ArtifactViewer', () => ({ ArtifactViewer: () => null }))
vi.mock('./TranscriptList', () => ({ TranscriptList: () => null }))

const { SessionConversation } = await import('./SessionConversation')

const base = {
  sessionId: 'sess-stop',
  agentKind: 'claude-code',
  cwd: '/repo',
  status: 'live',
  title: 'Agent',
} as unknown as SessionMeta

const working = {
  ...base,
  agentState: { phase: 'working', since: '2026-09-23T12:00:00.000Z' },
} as unknown as SessionMeta

const idle = {
  ...base,
  agentState: { phase: 'idle', since: '2026-09-23T12:00:00.000Z' },
} as unknown as SessionMeta

function api(interrupt: (input: unknown) => Promise<unknown>) {
  return {
    sessions: {
      transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
      answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
      interrupt: { mutate: interrupt },
    },
  }
}

describe('phone session Stop', () => {
  it('shows Stop while a turn runs and sends the session interrupt', async () => {
    const interrupt = vi.fn(async (_input: unknown) => ({ ok: true }))
    await renderWithMobileStore(<SessionConversation session={working} issue={undefined} />, {
      sessions: [working],
      api: api(interrupt),
    })

    const stop = await screen.findByLabelText('Stop this turn')
    fireEvent.click(stop)

    await waitFor(() => expect(interrupt).toHaveBeenCalledOnce())
    expect(interrupt.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ sessionId: 'sess-stop' }),
    )
  })

  it('draws no Stop on an idle session', async () => {
    await renderWithMobileStore(<SessionConversation session={idle} issue={undefined} />, {
      sessions: [idle],
      api: api(vi.fn(async () => ({ ok: true }))),
    })

    await screen.findByLabelText('Send')
    expect(screen.queryByLabelText('Stop this turn')).toBeNull()
  })

  it('says the agent was not stopped when the server refuses', async () => {
    const refused = vi.fn(async () => ({ ok: false, reason: 'no harness to signal' }))
    await renderWithMobileStore(<SessionConversation session={working} issue={undefined} />, {
      sessions: [working],
      api: api(refused),
    })

    fireEvent.click(await screen.findByLabelText('Stop this turn'))

    await waitFor(() =>
      expect(screen.getByTestId('composer-caption').textContent).toBe(
        'Not stopped: no harness to signal',
      ),
    )
  })
})
