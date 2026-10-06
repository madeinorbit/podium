import type { SessionView } from '@podium/client-core/session-values'
/** The composer owns draft observation. Keys must leave the screen, transcript
 * and composer-state derivation asleep; same-row streamed tokens must leave
 * the composer asleep while the addressed transcript leaf updates. */

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
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
const composerWork = vi.hoisted(() => ({ renders: 0, state: 0 }))
vi.mock('./Composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Composer')>()
  return {
    ...actual,
    Composer: (props: Parameters<typeof actual.Composer>[0]) => {
      composerWork.renders += 1
      return <actual.Composer {...props} />
    },
  }
})
vi.mock('@podium/client-core/values', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/client-core/values')>()
  return {
    ...actual,
    composerState: (...args: Parameters<typeof actual.composerState>) => {
      composerWork.state += 1
      return actual.composerState(...args)
    },
  }
})

vi.mock('./SessionLifecycle', () => ({
  MobileSessionLifecycle: () => {
    screenRenders.count += 1
    return null
  },
}))
vi.mock('./TaskSheet', () => ({ TaskSheet: () => null }))
vi.mock('./ArtifactViewer', () => ({ ArtifactViewer: () => null }))
vi.mock('./TranscriptList', async () => {
  const { observer } = await import('mobx-react-lite')
  return {
    TranscriptList: observer(
      ({
        transcript,
      }: {
        transcript: import('@podium/client-core/conversation').TranscriptLog
      }) => {
        transcriptRenders.count += 1
        return <span data-testid="stream-text">{transcript.byId.get('stream')?.text}</span>
      },
    ),
  }
})

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
    const fixture = await renderWithMobileStore(
      <SessionConversation session={session} issue={undefined} />,
      {
        sessions: [session],
        api: {
          sessions: {
            transcriptRead: {
              query: async () => ({
                items: [{ id: 'stream', role: 'assistant', text: 'start', cursor: 'stream' }],
                hasMore: false,
              }),
            },
            answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
            interrupt: { mutate: async () => ({ ok: true }) },
          },
        },
      },
    )

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

    const composerBaseline = { ...composerWork }
    const keys = ['h', 'he', 'hel', 'hell', 'hello']
    for (const value of keys) {
      fireEvent.change(field, { target: { value } })
    }

    // The composer itself reflects the draft.
    await waitFor(() => expect(field.value).toBe('hello'))

    // Neither the transcript nor the screen re-rendered for any key.
    expect(transcriptRenders.count).toBe(transcriptBaseline)
    expect(screenRenders.count).toBe(screenBaseline)
    expect(composerWork.renders - composerBaseline.renders).toBe(keys.length)
    expect(composerWork.state).toBe(composerBaseline.state)
    const typing = {
      keys: keys.length,
      composer: composerWork.renders - composerBaseline.renders,
      screen: screenRenders.count - screenBaseline,
      transcript: transcriptRenders.count - transcriptBaseline,
      composerState: composerWork.state - composerBaseline.state,
    }

    const streamed = []
    for (let token = 1; token <= 5; token++) {
      const before = {
        composer: composerWork.renders,
        state: composerWork.state,
        screen: screenRenders.count,
        transcript: transcriptRenders.count,
      }
      await act(async () =>
        fixture.emit(
          'transcriptDelta',
          session.sessionId,
          [{ id: 'stream', role: 'assistant', text: `token ${token}`, cursor: 'stream' }],
          { reset: false },
        ),
      )
      await waitFor(() =>
        expect(screen.getByTestId('stream-text').textContent).toBe(`token ${token}`),
      )
      streamed.push({
        token,
        composer: composerWork.renders - before.composer,
        composerState: composerWork.state - before.state,
        screen: screenRenders.count - before.screen,
        transcript: transcriptRenders.count - before.transcript,
      })
    }
    expect(field.value).toBe('hello')
    expect(
      streamed.every(
        (sample) => sample.composer === 0 && sample.screen === 0 && sample.composerState === 0,
      ),
    ).toBe(true)
    console.log('[phone composer typing and stream]', JSON.stringify({ typing, streamed }))
  })
})
