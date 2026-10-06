/**
 * Phone Superagent chrome: the large Screen header Work/Tasks wear, no
 * leftover OVERARCHING bar, and sendTurn carries the prompt-box backend.
 */
import type { SuperagentTurnFailure } from '@podium/client-core/api'
import type { TranscriptItem } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { type MobileStoreFixture, renderWithMobileStore } from '../client/test-support'
import type { ComposerAttachmentsApi } from '../components/useComposerAttachments'
import type { PickedFile } from '../lib/composer-media'

const nextFrame = globalThis.requestAnimationFrame.bind(globalThis)

// Conversation publishes streamed activity atomically on the next frame.
async function frameAct(work: () => unknown) {
  await act(async () => {
    await work()
    await new Promise<void>((resolve) => nextFrame(() => resolve()))
  })
}

const transcriptProps = vi.hoisted(
  () =>
    [] as {
      transcript?: import('@podium/client-core/conversation').TranscriptLog
      items: { text: string }[]
      liveItem?: { text: string }
      pendingTurns?: { text: string; failed?: string }[]
      transcriptQuestion: TranscriptItem | null
    }[],
)
const composerProps = vi.hoisted(
  () =>
    [] as {
      attachments?: ComposerAttachmentsApi
      onSend: (text: string) => void
    }[],
)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  transcriptProps.length = 0
  composerProps.length = 0
})

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('../hooks/useTabBarInset', () => ({ useTabBarInset: () => 72 }))
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
vi.mock('../components/BottomSheet', () => ({
  BottomSheet: ({
    visible,
    children,
    head,
  }: {
    visible: boolean
    children: ReactNode
    head?: ReactNode
  }) =>
    visible ? (
      <div>
        {head}
        {children}
      </div>
    ) : null,
}))
vi.mock('../components/TranscriptList', async () => {
  const { observer } = await import('mobx-react-lite')
  return {
    TranscriptList: observer(
      ({
        transcript,
        items = [],
        liveItem,
        tail,
        pendingTurns = [],
        transcriptQuestion,
      }: {
        transcript?: import('@podium/client-core/conversation').TranscriptLog
        items?: { text: string }[]
        liveItem?: { text: string }
        tail?: { label: string; tone: string }
        pendingTurns?: { text: string; failed?: string }[]
        transcriptQuestion: TranscriptItem | null
      }) => {
        if (transcript) {
          // Track order only; production message versions belong to row observers.
          transcript.ids.length
          items = transcript.items
        }
        transcriptProps.push({
          transcript,
          items,
          ...(liveItem ? { liveItem } : {}),
          pendingTurns,
          transcriptQuestion,
        })
        return (
          <div>
            transcript
            <span data-testid="superagent-live-text">
              {liveItem?.text ?? items.at(-1)?.text ?? ''}
            </span>
            {pendingTurns
              .filter((turn) => turn.failed)
              .map((turn) => (
                <span key={turn.text} data-testid="superagent-failed-row">
                  Not sent: {turn.text}
                </span>
              ))}
            {tail?.tone === 'working' ? (
              <span data-testid="superagent-working-indicator">{tail.label}</span>
            ) : null}
          </div>
        )
      },
    ),
  }
})
vi.mock('../components/Composer', () => ({
  Composer: ({
    leading,
    onSend,
    attachments,
  }: {
    leading?: ReactNode
    onSend: (text: string) => void
    attachments?: ComposerAttachmentsApi
  }) => {
    composerProps.push({ onSend, ...(attachments ? { attachments } : {}) })
    return (
      <div>
        {leading}
        <button type="button" onClick={() => onSend('hello')}>
          send
        </button>
      </div>
    )
  },
}))
vi.mock('../components/LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ children }: { children: ReactNode }) => <>{children}</>,
  TranscriptSkeleton: () => null,
}))
vi.mock('../components/PullToRefreshBoundary', () => ({
  PullToRefreshBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('../components/WorkingMark', () => ({
  WorkingMark: () => <span data-testid="superagent-working-indicator" />,
}))

const { SuperagentScreen } = await import('./SuperagentScreen')

const savedFailure: SuperagentTurnFailure = {
  inputId: 'input:failed',
  userText: 'first failed prompt',
  error: 'Original send failed',
  at: '2026-09-29T01:31:27.000Z',
}

function failureFixture(
  latestTurnFailure: () => Promise<SuperagentTurnFailure | null>,
  readItems: () => TranscriptItem[] | Promise<TranscriptItem[]> = () => [],
  sendTurn = async () => ({ threadId: 'global', podiumSessionId: 'session:superagent' }),
): MobileStoreFixture {
  return {
    api: {
      superagent: {
        listThreads: {
          query: async () => [
            {
              id: 'global',
              kind: 'global',
              podiumSessionId: 'session:superagent',
              turnRunning: false,
            },
          ],
        },
        latestTurnFailure: { query: latestTurnFailure },
        sendTurn: { mutate: sendTurn },
        clear: { mutate: async () => {} },
        interruptTurn: { mutate: async () => {} },
      },
      sessions: {
        transcriptRead: { query: async () => ({ items: await readItems(), hasMore: false }) },
      },
    },
  }
}

describe('SuperagentScreen chrome', () => {
  it('uses raw facts for failure restoration and optimistic sends without rereading history at 1x/4x', async () => {
    const samples = []
    for (const scale of [1, 4] as const) {
      console.log('[Superagent fact fixture scale]', scale)
      let roleReads = 0,
        timeReads = 0
      const items: TranscriptItem[] = Array.from({ length: 128 * scale }, (_, index) => ({
        id: `retained:${index}`,
        text: 'Retained assistant history',
        get role() {
          roleReads++
          return 'assistant' as const
        },
        get ts() {
          timeReads++
          return '2026-09-29T01:30:00.000Z'
        },
      }))
      let resolveFailure: ((failure: SuperagentTurnFailure) => void) | undefined
      const latestTurnFailure = vi.fn(
        () =>
          new Promise<SuperagentTurnFailure>((resolve) => {
            resolveFailure = resolve
          }),
      )
      const sendTurn = vi.fn(async () => ({
        threadId: 'global',
        podiumSessionId: 'session:superagent',
      }))
      const view = await renderWithMobileStore(<SuperagentScreen />, {
        ...failureFixture(latestTurnFailure, () => items, sendTurn),
        principal: `user:superagent-facts-${scale}`,
      })
      await waitFor(() => expect(latestTurnFailure).toHaveBeenCalledOnce())
      await waitFor(() => expect(transcriptProps.at(-1)?.transcript?.initialLoaded).toBe(true))
      expect(transcriptProps.at(-1)?.items).toHaveLength(items.length)
      expect(transcriptProps.at(-1)?.transcriptQuestion).toBeNull()
      const measure = async (action: () => Promise<void>) => {
        roleReads = 0
        timeReads = 0
        const result = await measureWork(action)
        return { work: result.work, roleReads, timeReads }
      }
      const restore = await measure(async () => {
        await frameAct(async () => resolveFailure?.(savedFailure))
      })
      expect(screen.getByText(savedFailure.error)).toBeTruthy()
      const send = await measure(async () => {
        await frameAct(async () => {
          composerProps.at(-1)?.onSend('a new prompt')
          await Promise.resolve()
        })
      })
      expect(sendTurn).toHaveBeenCalledOnce()
      const status = await measure(async () => {
        await frameAct(() =>
          view.emit('headlessActivity', 'session:superagent', {
            kind: 'status',
            status: 'tool',
            label: 'Bash',
          }),
        )
      })
      for (const action of [restore, send, status]) {
        expect(action.roleReads).toBe(0)
        expect(action.timeReads).toBe(0)
      }
      samples.push({ scale, actions: { restore, send, status } })
      view.unmount()
      cleanup()
      await frameAct(async () => {
        await Promise.resolve()
      })
      transcriptProps.length = 0
      composerProps.length = 0
    }
    // A warmed second owner may do less setup work. Every counted consumer
    // must stay within the 1x bound, and raw transcript reads stay zero above.
    for (const phase of ['restore', 'send', 'status'] as const) {
      const before = samples[0]!.actions[phase].work
      const after = samples[1]!.actions[phase].work
      expect(after.derivations).toBeLessThanOrEqual(before.derivations)
      expect(after.elements).toBeLessThanOrEqual(before.elements)
      for (const [name, count] of Object.entries(after.derivationsBy))
        expect(count).toBeLessThanOrEqual(before.derivationsBy[name] ?? 0)
      for (const [name, count] of Object.entries(after.elementsBy))
        expect(count).toBeLessThanOrEqual(before.elementsBy[name] ?? 0)
    }
    console.log('[actual Superagent raw facts work1x4x]', JSON.stringify(samples))
  })

  it('passes the source-owned raw question and clears it on an authoritative reset', async () => {
    const question: TranscriptItem = {
      id: 'question',
      role: 'tool',
      text: '',
      toolName: 'AskUserQuestion',
      toolInputJson: '{"questions":[]}',
    }
    let items = [question]
    const view = await renderWithMobileStore(
      <SuperagentScreen />,
      failureFixture(
        async () => null,
        () => items,
      ),
    )
    await waitFor(() => expect(transcriptProps.at(-1)?.transcriptQuestion?.id).toBe('question'))
    await frameAct(() =>
      view.emit(
        'transcriptDelta',
        'session:superagent',
        [{ ...question, toolResult: 'Answered' }],
        { reset: false },
      ),
    )
    expect(transcriptProps.at(-1)?.transcriptQuestion).toBeNull()
    items = []
    await frameAct(async () =>
      view.emit('transcriptDelta', 'session:superagent', [], { reset: true }),
    )
    expect(transcriptProps.at(-1)?.items).toEqual([])
    expect(transcriptProps.at(-1)?.transcriptQuestion).toBeNull()
  })

  it('wears the large Superagent header and no OVERARCHING bar', async () => {
    await renderWithMobileStore(<SuperagentScreen />)
    expect(screen.getByText('Superagent')).toBeTruthy()
    expect(screen.queryByText('OVERARCHING')).toBeNull()
    expect(screen.getByLabelText('Clear context — start the chat fresh')).toBeTruthy()
    expect(screen.getByLabelText('Model')).toBeTruthy()
  })

  it('does not create an attachment session when the screen opens', async () => {
    const ensureSession = vi.fn(async () => ({ podiumSessionId: 'session:unused' }))
    await renderWithMobileStore(<SuperagentScreen />, {
      api: {
        superagent: {
          listThreads: { query: async () => [{ id: 'global', kind: 'global' }] },
          ensureSession: { mutate: ensureSession },
          sendTurn: { mutate: async () => ({ threadId: 'global' }) },
          latestTurnFailure: { query: async () => null },
          clear: { mutate: async () => {} },
          interruptTurn: { mutate: async () => {} },
        },
      },
    })
    await frameAct(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(ensureSession).not.toHaveBeenCalled()
  })

  it('creates one session for concurrent first attachments and uploads each once', async () => {
    const ensureSession = vi.fn(async () => ({ podiumSessionId: 'session:attachments' }))
    const uploadImage = vi.fn(async ({ filename }: { filename: string; sessionId: string }) => ({
      path: `/uploads/${filename}`,
    }))
    await renderWithMobileStore(<SuperagentScreen />, {
      api: {
        superagent: {
          listThreads: { query: async () => [{ id: 'global', kind: 'global' }] },
          ensureSession: { mutate: ensureSession },
          sendTurn: { mutate: async () => ({ threadId: 'global' }) },
          latestTurnFailure: { query: async () => null },
          clear: { mutate: async () => {} },
          interruptTurn: { mutate: async () => {} },
        },
        sessions: {
          uploadImage: { mutate: uploadImage },
          transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
          answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
        },
      },
    })
    const attachments = composerProps.at(-1)?.attachments
    if (!attachments) throw new Error('Superagent attachment controls were not rendered')
    const picked = (name: string): PickedFile => ({
      name,
      mimeType: 'image/png',
      previewUri: `file:///${name}`,
      dataBase64: `bytes:${name}`,
    })

    await frameAct(() => attachments.accept([]))
    expect(ensureSession).not.toHaveBeenCalled()
    await frameAct(() => {
      attachments.accept([picked('one.png')])
      attachments.accept([picked('two.png')])
    })

    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(2))
    expect(ensureSession).toHaveBeenCalledOnce()
    expect(ensureSession).toHaveBeenCalledWith({ threadId: 'global' })
    expect(uploadImage.mock.calls.map(([input]) => [input.sessionId, input.filename])).toEqual([
      ['session:attachments', 'one.png'],
      ['session:attachments', 'two.png'],
    ])
  })

  it('prepares a fresh attachment session after clearing the bound Superagent', async () => {
    const ensureSession = vi
      .fn()
      .mockResolvedValueOnce({ podiumSessionId: 'session:first' })
      .mockResolvedValueOnce({ podiumSessionId: 'session:second' })
    const clear = vi.fn(async () => {})
    const uploadImage = vi.fn(async ({ filename }: { filename: string; sessionId: string }) => ({
      path: `/uploads/${filename}`,
    }))
    await renderWithMobileStore(<SuperagentScreen />, {
      api: {
        superagent: {
          listThreads: { query: async () => [{ id: 'global', kind: 'global' }] },
          ensureSession: { mutate: ensureSession },
          sendTurn: { mutate: async () => ({ threadId: 'global' }) },
          latestTurnFailure: { query: async () => null },
          clear: { mutate: clear },
          interruptTurn: { mutate: async () => {} },
        },
        sessions: {
          uploadImage: { mutate: uploadImage },
          transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
          answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
        },
      },
    })
    const picked = (name: string): PickedFile => ({
      name,
      mimeType: 'image/png',
      previewUri: `file:///${name}`,
      dataBase64: `bytes:${name}`,
    })

    await frameAct(() => composerProps.at(-1)?.attachments?.accept([picked('before.png')]))
    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(1))
    expect(uploadImage.mock.calls[0]?.[0].sessionId).toBe('session:first')

    fireEvent.click(screen.getByLabelText('Clear context — start the chat fresh'))
    await waitFor(() => expect(clear).toHaveBeenCalledOnce())
    await waitFor(() => expect(composerProps.at(-1)?.attachments?.attachments).toEqual([]))

    await frameAct(() => composerProps.at(-1)?.attachments?.accept([picked('after.png')]))
    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(2))
    expect(ensureSession).toHaveBeenCalledTimes(2)
    expect(uploadImage.mock.calls.map(([input]) => input.sessionId)).toEqual([
      'session:first',
      'session:second',
    ])
  })

  it('sends the picked model and effort with the turn', async () => {
    const sendTurn = vi.fn(async () => ({ threadId: 'global' }))
    await renderWithMobileStore(<SuperagentScreen />, {
      api: {
        superagent: {
          listThreads: { query: async () => [] },
          sendTurn: { mutate: sendTurn },
          latestTurnFailure: { query: async () => null },
          clear: { mutate: async () => {} },
          interruptTurn: { mutate: async () => {} },
        },
      },
    })
    fireEvent.click(screen.getByLabelText('Model'))
    fireEvent.click(screen.getByLabelText('Claude Code Opus'))
    fireEvent.click(screen.getByText('send'))
    await waitFor(() =>
      expect(sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'hello',
          model: 'opus',
          agentKind: 'claude-code',
          effort: 'auto',
        }),
      ),
    )
  })

  it('shows one working indicator immediately while the send is still in flight', async () => {
    let rejectSend: ((reason: Error) => void) | undefined
    const sendTurn = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectSend = reject
        }),
    )
    await renderWithMobileStore(<SuperagentScreen />, {
      api: {
        superagent: {
          listThreads: {
            query: async () => [{ id: 'global', kind: 'global', turnRunning: false }],
          },
          sendTurn: { mutate: sendTurn },
          latestTurnFailure: { query: async () => null },
          clear: { mutate: async () => {} },
          interruptTurn: { mutate: async () => {} },
        },
      },
    })

    fireEvent.click(screen.getByText('send'))

    await waitFor(() => {
      const indicators = screen.getAllByTestId('superagent-working-indicator')
      expect(indicators).toHaveLength(1)
      expect(indicators[0]?.textContent).toBe('Sending')
    })

    await frameAct(async () => {
      rejectSend?.(new Error('offline'))
      await Promise.resolve()
    })
    expect(screen.queryByTestId('superagent-working-indicator')).toBeNull()
  })

  it('orders coalesced text behind newer status and invalidates cancelled frames', async () => {
    const view = await renderWithMobileStore(<SuperagentScreen />, {
      api: {
        superagent: {
          listThreads: {
            query: async () => [
              {
                id: 'global',
                kind: 'global',
                podiumSessionId: 'session:superagent',
                turnRunning: true,
              },
            ],
          },
          sendTurn: { mutate: async () => ({ threadId: 'global' }) },
          latestTurnFailure: { query: async () => null },
          clear: { mutate: async () => {} },
          interruptTurn: { mutate: async () => {} },
        },
      },
    })
    await waitFor(() => expect(screen.getByTestId('superagent-working-indicator')).toBeTruthy())

    const frames: FrameRequestCallback[] = []
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const settledBeforeStreaming = transcriptProps.at(-1)?.items

    await frameAct(() => {
      view.emit('headlessActivity', 'session:superagent', {
        kind: 'partial-text',
        text: 'one',
      })
      view.emit('headlessActivity', 'session:superagent', {
        kind: 'partial-text',
        text: 'one two',
      })
      view.emit('headlessActivity', 'session:superagent', {
        kind: 'partial-text',
        text: 'one two three',
      })
      view.emit('headlessActivity', 'session:superagent', {
        kind: 'status',
        status: 'tool',
        label: 'Bash',
      })
    })

    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('superagent-live-text').textContent).toBe('')

    await frameAct(() => frames[0]?.(0))

    expect(screen.getByTestId('superagent-live-text').textContent).toBe('one two three')
    expect(screen.getByTestId('superagent-working-indicator').textContent).toBe('Bash')
    expect(transcriptProps.at(-1)?.items).toBe(settledBeforeStreaming)

    await frameAct(() => {
      view.emit('headlessActivity', 'session:superagent', {
        kind: 'partial-text',
        text: 'newer than the status',
      })
      frames[1]?.(1)
    })

    expect(requestFrame).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('superagent-live-text').textContent).toBe('newer than the status')
    expect(screen.getByTestId('superagent-working-indicator').textContent).toBe('Working')
    expect(transcriptProps.at(-1)?.items).toBe(settledBeforeStreaming)

    await frameAct(() => {
      view.emit('headlessActivity', 'session:superagent', {
        kind: 'partial-text',
        text: 'must not survive turn end',
      })
      view.emit('headlessActivity', 'session:superagent', { kind: 'turn-end' })
      view.emit('headlessActivity', 'session:superagent', { kind: 'turn-start' })
      // Model the host dequeuing the callback just before cancelAnimationFrame.
      frames[2]?.(2)
    })

    expect(requestFrame).toHaveBeenCalledTimes(3)
    // The shared model applies text, turn end and the next start in one frame.
    expect(screen.getByTestId('superagent-live-text').textContent).toBe('')
    expect(screen.getByTestId('superagent-working-indicator').textContent).toBe('starting')

    await frameAct(() => {
      view.emit('headlessActivity', 'session:superagent', {
        kind: 'partial-text',
        text: 'cancel on unmount',
      })
    })
    expect(requestFrame).toHaveBeenCalledTimes(4)
    view.unmount()
    // A warm model outlives its screen; principal destruction cancels its frame.
    view.runtime.destroy()
    expect(cancelFrame).toHaveBeenCalledWith(4)
  })

  it('restores the offline failure and the user message after reload (POD-4806)', async () => {
    await renderWithMobileStore(<SuperagentScreen />, {
      api: {
        superagent: {
          listThreads: {
            query: async () => [
              {
                id: 'global',
                kind: 'global',
                podiumSessionId: 'session:superagent',
                turnRunning: false,
              },
            ],
          },
          latestTurnFailure: {
            query: async () => ({
              inputId: 'input-1',
              userText: 'Reply with exactly the word PONG-SUPER.',
              error:
                "the headless harness turn failed: machine 'ludovico' is offline — bring its daemon online, then retry.",
              at: '2026-09-29T01:31:27.000Z',
            }),
          },
          sendTurn: { mutate: async () => ({ threadId: 'global' }) },
          clear: { mutate: async () => {} },
          interruptTurn: { mutate: async () => {} },
        },
        sessions: {
          transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
        },
      },
    })
    await waitFor(() => {
      const pending = transcriptProps.at(-1)?.pendingTurns ?? []
      expect(
        pending.some((t) => t.text.includes('PONG-SUPER') && t.failed?.includes('is offline')),
      ).toBe(true)
    })
    expect(screen.getByText(/ludovico.*is offline/)).toBeTruthy()
    expect(screen.queryByText(/SessionBinding/)).toBeNull()
  })

  it('does not restore an old failure after a failed send, a success, and reopening', async () => {
    const failure = savedFailure
    let durableFailure: SuperagentTurnFailure | null = null
    let items: TranscriptItem[] = []
    const latestTurnFailure = vi.fn(async () => durableFailure)
    const sendTurn = vi
      .fn()
      .mockImplementationOnce(async () => {
        durableFailure = failure
        throw new Error(failure.error)
      })
      .mockResolvedValue({ threadId: 'global', podiumSessionId: 'session:superagent' })
    const fixture = failureFixture(latestTurnFailure, () => items, sendTurn)
    const first = await renderWithMobileStore(<SuperagentScreen />, fixture)
    await waitFor(() => expect(latestTurnFailure).toHaveBeenCalledOnce())
    await frameAct(() => composerProps.at(-1)?.onSend('first failed prompt'))
    await waitFor(() =>
      expect(transcriptProps.at(-1)?.pendingTurns).toEqual([
        expect.objectContaining({ text: failure.userText, failed: failure.error }),
      ]),
    )

    await frameAct(() => composerProps.at(-1)?.onSend('later successful prompt'))
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2))
    items = [
      {
        id: 'user:success',
        role: 'user',
        text: 'later successful prompt',
        ts: '2026-09-29T01:32:00.000Z',
      },
      {
        id: 'assistant:success',
        role: 'assistant',
        text: 'Successful reply',
        ts: '2026-09-29T01:32:01.000Z',
      },
    ]
    await frameAct(() => {
      first.emit('transcriptDelta', 'session:superagent', items, { reset: false })
      first.emit('headlessActivity', 'session:superagent', { kind: 'turn-end' })
    })
    await waitFor(() =>
      expect(screen.getByTestId('superagent-live-text').textContent).toBe('Successful reply'),
    )
    first.unmount()
    transcriptProps.length = 0

    await renderWithMobileStore(<SuperagentScreen />, fixture)
    await waitFor(() => expect(latestTurnFailure).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('superagent-live-text').textContent).toBe('Successful reply')
    expect(transcriptProps.at(-1)?.pendingTurns).toEqual([])
    expect(screen.queryByTestId('superagent-failed-row')).toBeNull()
    expect(screen.queryByText(failure.error)).toBeNull()
  })

  it.each([
    'unrecorded user words',
    null,
  ])('suppresses the restored row and reason for a newer raw transcript item (userText: %s)', async (userText) => {
    const latestTurnFailure = vi.fn(async () => ({ ...savedFailure, userText }))
    await renderWithMobileStore(
      <SuperagentScreen />,
      failureFixture(latestTurnFailure, () => [
        // Results can be folded out of the visible transcript; they still supersede a failure.
        {
          id: 'call:older',
          role: 'tool',
          text: '',
          toolUseId: 'tool:1',
          toolName: 'Bash',
          ts: '2026-09-29T01:30:00.000Z',
        },
        {
          id: 'result:newer',
          role: 'tool',
          text: '',
          toolUseId: 'tool:1',
          toolResult: 'done',
          ts: '2026-09-29T01:32:00.000Z',
        },
      ]),
    )
    await waitFor(() => expect(latestTurnFailure).toHaveBeenCalledOnce())
    expect(transcriptProps.at(-1)?.pendingTurns).toEqual([])
    expect(screen.queryByTestId('superagent-failed-row')).toBeNull()
    expect(screen.queryByText(savedFailure.error)).toBeNull()
  })

  it('drops the restored row and reason when newer transcript history arrives', async () => {
    const view = await renderWithMobileStore(
      <SuperagentScreen />,
      failureFixture(async () => savedFailure),
    )
    await waitFor(() => expect(screen.getByText(savedFailure.error)).toBeTruthy())
    expect(screen.getByTestId('superagent-failed-row')).toBeTruthy()
    await frameAct(() =>
      view.emit(
        'transcriptDelta',
        'session:superagent',
        [
          {
            id: 'assistant:newer',
            role: 'assistant',
            text: 'A later reply',
            ts: '2026-09-29T01:32:00.000Z',
          },
        ],
        { reset: false },
      ),
    )
    expect(transcriptProps.at(-1)?.pendingTurns).toEqual([])
    expect(screen.queryByTestId('superagent-failed-row')).toBeNull()
    expect(screen.queryByText(savedFailure.error)).toBeNull()
  })

  it('keeps an unsuperseded post-dispatch reason without duplicating the user row', async () => {
    await renderWithMobileStore(
      <SuperagentScreen />,
      failureFixture(
        async () => ({ ...savedFailure, userText: null }),
        () => [{ id: 'user:failed', role: 'user', text: 'recorded prompt', ts: savedFailure.at }],
      ),
    )
    await waitFor(() => expect(screen.getByText(savedFailure.error)).toBeTruthy())
    expect(transcriptProps.at(-1)?.pendingTurns).toEqual([])
    expect(screen.queryByTestId('superagent-failed-row')).toBeNull()
  })

  describe.each(['before', 'after'])('restoration resolves %s live activity', (timing) => {
    it.each([
      'send',
      'turn-start',
      'partial-text',
      'status',
      'turn-end',
      'failed turn-end',
    ])('does not revive the restored row or reason after %s', async (activity) => {
      let resolveFailure: ((failure: SuperagentTurnFailure) => void) | undefined
      const latestTurnFailure = vi.fn(
        () =>
          new Promise<SuperagentTurnFailure>((resolve) => {
            resolveFailure = resolve
          }),
      )
      const sendTurn = vi.fn(async () => ({
        threadId: 'global',
        podiumSessionId: 'session:superagent',
      }))
      const view = await renderWithMobileStore(
        <SuperagentScreen />,
        failureFixture(latestTurnFailure, () => [], sendTurn),
      )
      await waitFor(() => expect(latestTurnFailure).toHaveBeenCalledOnce())
      if (timing === 'before') {
        await frameAct(async () => resolveFailure?.(savedFailure))
        expect(screen.getByText(savedFailure.error)).toBeTruthy()
        expect(screen.getByTestId('superagent-failed-row')).toBeTruthy()
      }

      if (activity === 'send') {
        await frameAct(() => composerProps.at(-1)?.onSend('hello'))
        await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce())
        await frameAct(() =>
          view.emit(
            'transcriptDelta',
            'session:superagent',
            [
              // Deliberately no timestamp: this case relies on live activity, not time comparison.
              { id: 'user:sent', role: 'user', text: 'hello' },
            ],
            { reset: false },
          ),
        )
      } else {
        const event =
          activity === 'partial-text'
            ? { kind: 'partial-text', text: 'live reply' }
            : activity === 'status'
              ? { kind: 'status', status: 'tool', label: 'Bash' }
              : activity === 'failed turn-end'
                ? { kind: 'turn-end', error: 'Current live failure' }
                : { kind: activity }
        await frameAct(() => view.emit('headlessActivity', 'session:superagent', event))
      }
      if (activity !== 'failed turn-end') {
        await frameAct(() =>
          view.emit('headlessActivity', 'session:superagent', { kind: 'turn-end' }),
        )
      }
      if (timing === 'after') await frameAct(async () => resolveFailure?.(savedFailure))

      expect(transcriptProps.at(-1)?.pendingTurns).toEqual([])
      expect(screen.queryByTestId('superagent-failed-row')).toBeNull()
      expect(screen.queryByText(savedFailure.error)).toBeNull()
      expect(screen.queryByTestId('superagent-working-indicator')).toBeNull()
      if (activity === 'failed turn-end') {
        expect(screen.getByText('Current live failure')).toBeTruthy()
      }
    })
  })

  it('does not begin restoration when a send precedes transcript loading', async () => {
    let resolveItems: ((items: TranscriptItem[]) => void) | undefined
    const readItems = () =>
      new Promise<TranscriptItem[]>((resolve) => {
        resolveItems = resolve
      })
    const latestTurnFailure = vi.fn(async () => savedFailure)
    const sendTurn = vi.fn(async () => ({
      threadId: 'global',
      podiumSessionId: 'session:superagent',
    }))
    const view = await renderWithMobileStore(
      <SuperagentScreen />,
      failureFixture(latestTurnFailure, readItems, sendTurn),
    )
    await waitFor(() => expect(resolveItems).toBeDefined())
    await frameAct(() => composerProps.at(-1)?.onSend('hello'))
    await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce())
    await frameAct(async () => {
      view.emit('headlessActivity', 'session:superagent', { kind: 'turn-end' })
      resolveItems?.([{ id: 'user:sent', role: 'user', text: 'hello' }])
    })
    expect(latestTurnFailure).not.toHaveBeenCalled()
    expect(transcriptProps.at(-1)?.pendingTurns).toEqual([])
    expect(screen.queryByText(savedFailure.error)).toBeNull()
  })

  it('preserves a current live failure when newer transcript items arrive, then clears it on success', async () => {
    const view = await renderWithMobileStore(
      <SuperagentScreen />,
      failureFixture(async () => null),
    )
    await frameAct(() => {
      view.emit('headlessActivity', 'session:superagent', {
        kind: 'turn-end',
        error: 'Current live failure',
      })
      view.emit(
        'transcriptDelta',
        'session:superagent',
        [
          {
            id: 'result:newer',
            role: 'tool',
            text: '',
            toolUseId: 'tool:1',
            toolResult: 'done',
            ts: '2026-09-29T01:32:00.000Z',
          },
        ],
        { reset: false },
      )
    })
    expect(screen.getByText('Current live failure')).toBeTruthy()
    await frameAct(() => view.emit('headlessActivity', 'session:superagent', { kind: 'turn-end' }))
    expect(screen.queryByText('Current live failure')).toBeNull()
  })
})

it('does not poll the thread every five seconds while a turn is running', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval')
  try {
    const view = await renderWithMobileStore(
      <SuperagentScreen />,
      failureFixture(async () => null),
    )
    await screen.findByText('transcript')
    await frameAct(() =>
      view.emit('headlessActivity', 'session:superagent', { kind: 'turn-start' }),
    )
    await waitFor(() => expect(screen.getByTestId('superagent-working-indicator')).toBeTruthy())
    expect(interval.mock.calls.filter(([, delay]) => delay === 5000)).toEqual([])
  } finally {
    interval.mockRestore()
  }
})
