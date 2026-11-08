import type { SessionView } from '@podium/client-core/session-values'
/**
 * THE PHONE CAN STOP A RUNNING TURN [POD-4645].
 *
 * The session screen said "Working…" and offered nothing to end it: the
 * composer had attach, mic and send, and the only way out was Open terminal →
 * Esc through the xterm. The desktop composer has a Stop control that calls the
 * shared conversation controller's `interrupt`, which writes a `session.interrupt`
 * effect record naming the turn on screen (POD-6397) and the exact queued
 * message it selected. These tests hold the phone to the
 * same contract, through the REAL composer: Stop is drawn only while a turn
 * runs, a press sends that same command, and a refusal is said out loud rather
 * than swallowed.
 */

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { renderWithMobileStore } from '../client/test-support'
import { createMobileTestReplica } from '../client/test-replica'

const legacyQuestions = vi.hoisted(() => vi.fn())
const factQuestions = vi.hoisted(() => vi.fn())
const listFacts = vi.hoisted(() => vi.fn())
vi.mock('@podium/client-core/values', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/client-core/values')>()
  return {
    ...actual,
    latestPendingQuestion: (...args: Parameters<typeof actual.latestPendingQuestion>) => {
      legacyQuestions()
      return actual.latestPendingQuestion(...args)
    },
  }
})
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
  TranscriptList: (props: Parameters<typeof import('./TranscriptList').TranscriptList>[0]) => {
    listFacts(props.transcript?.ids.length ?? props.items?.length ?? 0, props.transcriptQuestion)
    return null
  },
}))

const { SessionConversation } = await import('./SessionConversation')

const base = {
  sessionId: 'sess-stop',
  agentKind: 'claude-code',
  cwd: '/repo',
  status: 'live',
  title: 'Agent',
} as unknown as SessionView

const working = {
  ...base,
  agentState: { phase: 'working', since: '2026-09-23T12:00:00.000Z' },
} as unknown as SessionView

const idle = {
  ...base,
  agentState: { phase: 'idle', since: '2026-09-23T12:00:00.000Z' },
} as unknown as SessionView

/** `submit` is the server's `sync.submit`: the Stop arrives as `effects.create`. */
function api(submit: (input: unknown) => Promise<unknown>) {
  return {
    sessions: {
      transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
      answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
    },
    sync: { submit: { mutate: submit } },
  }
}
const applied = async () => ({ outcome: 'applied', result: null })

describe('phone session Stop', () => {
  it('uses source facts and does no retained-history question work on phase updates at 1x/4x', async () => {
    const samples = []
    for (const scale of [1, 4] as const) {
      legacyQuestions.mockClear()
      factQuestions.mockClear()
      listFacts.mockClear()
      const items = [
        { id: 'prompt', role: 'user', text: 'Original prompt' },
        ...Array.from({ length: 128 * scale }, (_, index) => ({
          id: `a${index}`,
          role: 'assistant',
          text: 'Retained history',
        })),
      ]
      let change: (() => void) | undefined
      function Harness() {
        const [session, setSession] = useState(working)
        change = () =>
          setSession({
            ...working,
            agentState: { ...working.agentState, since: '2026-09-23T12:00:01.000Z' },
          } as SessionView)
        return <SessionConversation session={session} issue={undefined} />
      }
      const view = await renderWithMobileStore(<Harness />, {
        sessions: [working],
        api: {
          sessions: {
            transcriptRead: { query: async () => ({ items, hasMore: false }) },
            answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
          },
        },
      })
      await waitFor(() => expect(listFacts).toHaveBeenLastCalledWith(items.length, null))
      expect(legacyQuestions).not.toHaveBeenCalled()
      factQuestions.mockClear()
      legacyQuestions.mockClear()
      const phase = await measureWork(async () => {
        act(() => change?.())
      })
      expect(factQuestions).not.toHaveBeenCalled()
      expect(legacyQuestions).not.toHaveBeenCalled()
      samples.push({
        scale,
        phase,
        factQueries: factQuestions.mock.calls.length,
        legacyQueries: legacyQuestions.mock.calls.length,
      })
      view.unmount()
    }
    expect(samples[1]!.phase).toEqual(samples[0]!.phase)
    console.log('[actual phone transcript facts phase work1x4x]', JSON.stringify(samples))
  })

  it('shows Stop while a turn runs and writes the session.interrupt record', async () => {
    const submit = vi.fn(async (_input: unknown) => await applied())
    await renderWithMobileStore(<SessionConversation session={working} issue={undefined} />, {
      sessions: [working],
      api: api(submit),
    })

    const stop = await screen.findByLabelText('Stop this turn')
    fireEvent.click(stop)

    await waitFor(() => expect(submit).toHaveBeenCalledOnce())
    expect(submit.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        command: 'effects.create',
        input: expect.objectContaining({
          kind: 'session.interrupt',
          target: { kind: 'session', id: 'sess-stop' },
        }),
      }),
    )
  })

  it('draws no Stop on an idle session', async () => {
    await renderWithMobileStore(<SessionConversation session={idle} issue={undefined} />, {
      sessions: [idle],
      api: api(vi.fn(applied)),
    })

    await screen.findByLabelText('Send')
    expect(screen.queryByLabelText('Stop this turn')).toBeNull()
  })

  it('a Stop that failed while its turn still runs says so and offers Kill', async () => {
    const turn = '2026-09-23T12:00:00.000Z'
    const running = {
      ...base,
      agentState: { phase: 'working', since: turn, turnStartedAt: turn, nativeSubagentCount: 0 },
    } as unknown as SessionView
    const replica = createMobileTestReplica()
    replica.applySnapshot('sessions', [running] as never)
    replica.applySnapshot('messageRecords', [])
    replica.applySnapshot('effects', [
      {
        id: 'eff_stop',
        kind: 'session.interrupt',
        target: { kind: 'session', id: 'sess-stop' },
        input: { turn },
        cancelRequested: false,
        effect: {
          status: 'failed',
          attempts: 1,
          error: { code: 'deadline', message: 'The agent did not stop within 30 s.' },
        },
        createdBy: 'user:test',
        createdAt: turn,
        updatedAt: turn,
        revision: 2,
      },
    ] as never)
    replica.finishBootstrap()
    await renderWithMobileStore(<SessionConversation session={running} issue={undefined} />, {
      replica,
      api: api(vi.fn(applied)),
    })

    const banner = await screen.findByTestId('interrupt-stuck')
    expect(banner.textContent).toContain('The agent did not stop within 30 s.')
    expect(screen.getByTestId('interrupt-kill')).toBeTruthy()
    expect(screen.getByTestId('interrupt-dismiss')).toBeTruthy()
  })
})
