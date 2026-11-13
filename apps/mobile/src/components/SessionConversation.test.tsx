import type { SessionView } from '@podium/client-core/session-values'
import { PendingInteractionWire } from '@podium/protocol'
import { claudeRecordToItems } from '../../../../packages/harness/src/adapters/claude-code/transcript'
/**
 * ACCEPTING AN OFFER IS A SEND, AND MUST LOOK LIKE ONE [POD-1354].
 *
 * The action button used to call straight through to the wire with no
 * optimistic half: the card stayed put, no bubble appeared, and the tail still
 * read idle until the server echoed the turn — minutes, on the parked session an
 * offer usually comes from. These tests pin all three optimistic parts and,
 * just as importantly, pin that a REFUSED send puts every one of them back.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { act, type ReactNode, useState } from 'react'
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
// Same reason as TaskSheet: the offer's artifact strip mounts the artifact
// viewer, which imports the boot gate this leaf lane cannot load.
vi.mock('./ArtifactViewer', () => ({ ArtifactViewer: () => null }))
vi.mock('./Composer', () => ({ Composer: () => <div data-testid="composer" /> }))

/**
 * The transcript, reduced to the facts these tests are about: the footer
 * (where the offer card lives), the optimistic rows, the tail's tone, and the
 * empty state — rendered whenever it is passed, which is what the real
 * FlatList does with an empty row array.
 */
vi.mock('./TranscriptList', () => ({
  TranscriptList: ({
    emptyComponent,
    transcript,
    footer,
    pendingTurns,
    tail,
  }: {
    emptyComponent?: ReactNode
    transcript?: { ids: readonly string[] }
    footer?: ReactNode
    pendingTurns?: readonly PendingTurn[]
    tail?: { label: string; tone: string; since?: string }
  }) => (
    <div>
      <div data-testid="loaded-count">{transcript?.ids.length ?? 0}</div>
      <div
        data-testid="tail"
        data-since={tail?.since}
      >{`${tail?.tone ?? 'none'}:${tail?.label ?? ''}`}</div>
      {(pendingTurns ?? []).map((turn) => (
        <div key={turn.id} data-testid="pending">
          {turn.failed ? `failed:${turn.text}` : turn.text}
        </div>
      ))}
      {emptyComponent}
      {footer}
    </div>
  ),
}))

const { SessionConversation } = await import('./SessionConversation')

const OFFER_AT = '2026-08-18T12:00:00.000Z'

it.each([
  '',
  'Error: answer could not be delivered',
  '[Tool call interrupted: its outcome is unknown.]',
])('shows the current native question after resumed history with %j', async (result) => {
  const current = {
    questions: [{ question: 'New native question?', options: [{ label: 'New choice' }] }],
  }
  const asking = {
    sessionId: 'resumed',
    cwd: '/repo',
    status: 'live',
    agentKind: 'claude-code',
    agentState: { phase: 'needs_user', need: { kind: 'question', interview: current } },
  } as unknown as SessionView
  const items = [
    ...claudeRecordToItems({
      type: 'assistant',
      uuid: 'old-call',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'old-use',
            name: 'AskUserQuestion',
            input: {
              questions: [{ question: 'Old question?', options: [{ label: 'Old choice' }] }],
            },
          },
        ],
      },
    }),
    ...claudeRecordToItems({
      type: 'user',
      uuid: 'old-result',
      message: { content: [{ type: 'tool_result', tool_use_id: 'old-use', content: result }] },
    }),
  ]
  const answer = vi.fn(async (_input: unknown) => ({ ok: true }))
  const view = await renderWithMobileStore(
    <SessionConversation session={asking} issue={undefined} />,
    {
      sessions: [asking],
      api: {
        sessions: {
          transcriptRead: { query: async () => ({ items, hasMore: false }) },
          answerAskUserQuestion: { mutate: answer },
        },
      },
    },
  )
  act(() =>
    view.replica.applySnapshot('pendingInteractions', [
      PendingInteractionWire.parse({
        id: 'new-interaction',
        sessionId: 'resumed',
        askedAt: '2026-11-13T12:00:00Z',
        source: 'hook',
        answerable: 'keystroke-emulated',
        fingerprint: 'new',
        kind: 'question',
        status: 'asked',
        payload: {
          v: 1,
          questions: [{ ...current.questions[0], multiSelect: false, previewLayout: false }],
        },
      }),
    ]),
  )
  await screen.findByText('New native question?')
  fireEvent.click(screen.getByLabelText('New choice'))
  await waitFor(() =>
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionId: 'new-interaction',
        choices: [{ optionIndices: [1] }],
      }),
    ),
  )
})

it.each([
  'option',
  'custom',
])('answers a Codex async %s question through the shared chat route', async (kind) => {
  const asking = {
    sessionId: `codex-${kind}`,
    cwd: '/repo',
    status: 'live',
    agentKind: 'codex',
    agentState: { phase: 'idle' },
  } as unknown as SessionView
  const sendText = vi.fn(async (_input: unknown) => ({ ok: true }))
  const nativeAnswer = vi.fn(async () => ({ ok: false, reason: 'unknown-interaction' }))
  await renderWithMobileStore(<SessionConversation session={asking} issue={undefined} />, {
    sessions: [asking],
    api: {
      sessions: {
        transcriptRead: {
          query: async () => ({
            items: [
              {
                id: 'async',
                role: 'tool',
                text: '',
                toolName: 'request_user_input_async',
                toolUseId: 'call_async',
                toolInputJson: JSON.stringify({
                  questions: [{ question: 'Where?', options: [{ label: 'main' }] }],
                }),
              },
              {
                id: 'registered',
                role: 'tool',
                text: '',
                toolUseId: 'call_async',
                toolResult: '{"accepted":true}',
              },
            ],
            hasMore: false,
          }),
        },
        answerAskUserQuestion: { mutate: nativeAnswer },
        sendText: { mutate: sendText },
        resumeAndSend: { mutate: sendText },
      },
    },
  })
  await screen.findByTestId('ask-question-tile')
  if (kind === 'option') fireEvent.click(screen.getByLabelText('main'))
  else {
    fireEvent.click(screen.getByLabelText('Write a different answer'))
    fireEvent.change(screen.getByLabelText('Type your own answer'), {
      target: { value: 'an isolated branch' },
    })
    fireEvent.click(screen.getByLabelText('Send answer'))
  }
  await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1))
  expect(nativeAnswer).not.toHaveBeenCalled()
  const payload = sendText.mock.calls[0]?.[0] as unknown as { text: string }
  expect(payload.text).toContain('<send_user_message_question_reply>')
  const replies = JSON.parse(payload.text.split('\n')[1] ?? '')
  expect(replies[0]).toMatchObject({
    answer: kind === 'option' ? 'main' : 'an isolated branch',
    questionItemId: '["request_user_input_async","call_async",0]',
  })
})

it.each([
  '',
  'Error: answer could not be delivered',
  "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown.]",
])('does not pin retired question history with %j', async (result) => {
  const asking = {
    sessionId: `unresolved-${result.length}`,
    cwd: '/repo',
    status: 'live',
    agentKind: 'claude-code',
    agentState: { phase: 'idle' },
  } as unknown as SessionView
  await renderWithMobileStore(<SessionConversation session={asking} issue={undefined} />, {
    sessions: [asking],
    api: {
      sessions: {
        transcriptRead: {
          query: async () => ({
            items: [
              {
                id: 'ask',
                role: 'tool',
                text: '',
                toolName: 'AskUserQuestion',
                toolUseId: 'use',
                toolInputJson: JSON.stringify({
                  questions: [{ question: 'Where?', options: [{ label: 'main' }] }],
                }),
              },
              { id: 'result', role: 'tool', text: '', toolUseId: 'use', toolResult: result },
              { id: 'later', role: 'assistant', text: 'A later turn.' },
            ],
            hasMore: false,
          }),
        },
      },
    },
  })
  await waitFor(() => expect(screen.getByTestId('loaded-count').textContent).toBe('3'))
  expect(screen.queryByTestId('ask-question-tile')).toBeNull()
  expect(screen.queryByLabelText('main')).toBeNull()
})

it.each([
  'option',
  'custom',
])('unpins a delivered %s answer even after its acknowledgement reported failure', async (kind) => {
  const sessionId = `answered-${kind}`
  const asking = {
    sessionId,
    cwd: '/repo',
    status: 'live',
    agentKind: 'claude-code',
    agentState: { phase: 'idle' },
  } as unknown as SessionView
  const items: import('@podium/model').TranscriptItem[] = [
    {
      id: 'ask',
      role: 'tool',
      text: '',
      toolName: 'AskUserQuestion',
      toolUseId: 'use',
      toolInputJson: JSON.stringify({
        questions: [{ question: 'Pick a colour', options: [{ label: 'Red' }, { label: 'Blue' }] }],
      }),
    },
  ]
  const view = await renderWithMobileStore(
    <SessionConversation session={asking} issue={undefined} />,
    {
      sessions: [asking],
      api: {
        sessions: {
          transcriptRead: { query: async () => ({ items: [...items], hasMore: false }) },
          answerAskUserQuestion: {
            mutate: async () => ({ ok: false, reason: 'confirmation timed out' }),
          },
        },
      },
    },
  )
  await screen.findByTestId('ask-question-tile')
  if (kind === 'option') fireEvent.click(screen.getByLabelText('Red'))
  else {
    fireEvent.click(screen.getByLabelText('Write a different answer'))
    fireEvent.change(screen.getByLabelText('Type your own answer'), { target: { value: 'Purple' } })
    fireEvent.click(screen.getByLabelText('Send answer'))
  }
  await screen.findByText('Not delivered. Try again.')
  const arrived: import('@podium/model').TranscriptItem[] = [
    {
      id: 'result',
      role: 'tool',
      text: '',
      toolUseId: 'use',
      toolResult: kind === 'option' ? 'You selected "Red"' : 'You answered Purple',
    },
    { id: 'reply', role: 'assistant', text: 'You picked a colour.' },
  ]
  items.push(...arrived)
  act(() => view.emit('transcriptDelta', sessionId, arrived, { reset: false }))
  await waitFor(() => expect(screen.queryByTestId('ask-question-tile')).toBeNull())
  expect(screen.queryByText('Not delivered. Try again.')).toBeNull()
})

it('opens an exited transcript without a writable composer', async () => {
  const ended = {
    sessionId: 'ended',
    cwd: '/repo',
    status: 'exited',
    agentKind: 'claude-code',
    transcriptAvailable: true,
    resumable: true,
  } as unknown as SessionView
  await renderWithMobileStore(<SessionConversation session={ended} issue={undefined} />, {
    sessions: [ended],
    api: {
      sessions: {
        transcriptRead: {
          query: async () => ({
            items: [{ id: 'answer', role: 'assistant', text: 'Recorded answer' }],
            hasMore: false,
          }),
        },
      },
    },
  })
  expect(screen.getByTestId('tail')).toBeTruthy()
  expect(screen.queryByTestId('composer')).toBeNull()
})

it('settles an interrupted turn with quiet styling and no running clock', async () => {
  const stopped = {
    sessionId: 'stopped',
    cwd: '/repo',
    status: 'live',
    agentKind: 'claude-code',
    agentState: { phase: 'idle', since: '2026-11-13T10:00:00Z', idle: { kind: 'interrupted' } },
  } as unknown as SessionView
  await renderWithMobileStore(<SessionConversation session={stopped} issue={undefined} />, {
    sessions: [stopped],
    api: { sessions: { transcriptRead: { query: async () => ({ items: [], hasMore: false }) } } },
  })
  await waitFor(() => expect(screen.getByTestId('tail').textContent).toBe('idle:interrupted'))
  expect(screen.getByTestId('tail').getAttribute('data-since')).toBeNull()
})

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
} as unknown as SessionView

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
    expect(screen.getByTestId('tail').textContent).toBe('idle:Sending')
    expect(screen.getByTestId('tail').getAttribute('data-since')).toBeNull()
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

/**
 * THE EMPTY FEED HAS TWO MOODS [2026-08-28 device feedback]. A session already
 * computing has a transcript on the way, and the empty state must promise the
 * stream — telling the operator to send a message under a working agent reads
 * as the app not knowing what its own agent is doing. Only a genuinely idle
 * empty session hands the next move to the operator.
 */
describe('empty transcript mood', () => {
  const bare = {
    sessionId: 'sess-2',
    agentKind: 'claude-code',
    cwd: '/repo',
    status: 'live',
    title: 'Agent',
  } as unknown as SessionView

  it('hands an idle empty session to the operator, mark at rest', async () => {
    await renderWithMobileStore(<SessionConversation session={bare} issue={undefined} />, {
      sessions: [bare],
    })

    await waitFor(() => expect(screen.getByTestId('transcript-empty')).toBeTruthy())
    expect(screen.getByText('Nothing here yet')).toBeTruthy()
    expect(screen.queryByTestId('working-mark')).toBeNull()
    // The mark at rest is the SVG dot grid, not the ⣿ text glyph — the braille
    // block rendered as a missing-glyph box on device.
    expect(screen.getByTestId('resting-mark')).toBeTruthy()
  })

  it('promises the stream while the agent is computing', async () => {
    const working = {
      ...bare,
      agentState: { phase: 'working', since: '2026-08-18T12:00:00.000Z' },
    } as unknown as SessionView
    await renderWithMobileStore(<SessionConversation session={working} issue={undefined} />, {
      sessions: [working],
    })

    await waitFor(() => expect(screen.getByTestId('transcript-empty')).toBeTruthy())
    expect(screen.getByText('The agent is on it')).toBeTruthy()
    expect(screen.getByTestId('working-mark')).toBeTruthy()
    expect(screen.queryByText('Nothing here yet')).toBeNull()
  })

  it('reads a booting agent as a transcript on its way, before agentState says anything', async () => {
    const starting = { ...bare, status: 'starting' } as unknown as SessionView
    await renderWithMobileStore(<SessionConversation session={starting} issue={undefined} />, {
      sessions: [starting],
    })

    await waitFor(() => expect(screen.getByTestId('transcript-empty')).toBeTruthy())
    expect(screen.getByText('The agent is on it')).toBeTruthy()
  })
})

describe('spawn prompt optimism', () => {
  it('keeps the first prompt through confirmation and retires it on transcript echo', async () => {
    let resolveRead: ((page: { items: unknown[]; hasMore: boolean }) => void) | undefined
    const transcriptRead = vi.fn(
      () =>
        new Promise<{ items: unknown[]; hasMore: boolean }>((resolve) => {
          resolveRead = resolve
        }),
    )
    const settled = vi.fn()
    const plainSession = { ...session, offer: undefined }

    function SpawnHost() {
      const [spawnPending, setSpawnPending] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setSpawnPending(false)}>
            Confirm session
          </button>
          <SessionConversation
            session={plainSession}
            issue={undefined}
            initialPendingText={spawnPending ? 'Plan the release' : undefined}
            deferInitialTranscript={spawnPending}
            onInitialPendingSettled={settled}
          />
        </>
      )
    }

    await renderWithMobileStore(<SpawnHost />, {
      sessions: [plainSession],
      api: {
        sessions: {
          transcriptRead: { query: transcriptRead },
          answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
        },
      },
    })

    expect(screen.getByTestId('pending').textContent).toBe('Plan the release')
    expect(transcriptRead).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Confirm session'))
    expect(screen.getByTestId('pending').textContent).toBe('Plan the release')
    await waitFor(() => expect(transcriptRead).toHaveBeenCalledOnce())

    await act(async () => {
      resolveRead?.({
        items: [{ id: 'echo-1', role: 'user', text: 'Plan the release' }],
        hasMore: false,
      })
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.queryByTestId('pending')).toBeNull())
    expect(settled).toHaveBeenCalledOnce()
  })
})
