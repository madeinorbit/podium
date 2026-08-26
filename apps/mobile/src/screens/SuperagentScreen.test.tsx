/**
 * Phone Superagent chrome: the large Screen header Work/Tasks wear, no
 * leftover OVERARCHING bar, and sendTurn carries the prompt-box backend.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'

const transcriptProps = vi.hoisted(
  () => [] as { items: { text: string }[]; liveItem?: { text: string } }[],
)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  transcriptProps.length = 0
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
vi.mock('lucide-react-native', () => ({
  ArrowUp: () => null,
  ChevronLeft: () => null,
  Cpu: () => null,
  Eraser: () => null,
  Gauge: () => null,
}))
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
vi.mock('../components/TranscriptList', () => ({
  TranscriptList: ({
    items = [],
    liveItem,
    tail,
  }: {
    items?: { text: string }[]
    liveItem?: { text: string }
    tail?: { label: string; tone: string }
  }) => {
    transcriptProps.push({ items, ...(liveItem ? { liveItem } : {}) })
    return (
      <div>
        transcript
        <span data-testid="superagent-live-text">{liveItem?.text ?? items.at(-1)?.text ?? ''}</span>
        {tail?.tone === 'working' ? (
          <span data-testid="superagent-working-indicator">{tail.label}</span>
        ) : null}
      </div>
    )
  },
}))
vi.mock('../components/Composer', () => ({
  Composer: ({ leading, onSend }: { leading?: ReactNode; onSend: (text: string) => void }) => (
    <div>
      {leading}
      <button type="button" onClick={() => onSend('hello')}>
        send
      </button>
    </div>
  ),
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

describe('SuperagentScreen chrome', () => {
  it('wears the large Superagent header and no OVERARCHING bar', async () => {
    await renderWithMobileStore(<SuperagentScreen />)
    expect(screen.getByText('Superagent')).toBeTruthy()
    expect(screen.queryByText('OVERARCHING')).toBeNull()
    expect(screen.getByLabelText('Clear context — start the chat fresh')).toBeTruthy()
    expect(screen.getByLabelText('Model')).toBeTruthy()
  })

  it('sends the picked model and effort with the turn', async () => {
    const sendTurn = vi.fn(async () => ({ threadId: 'global' }))
    await renderWithMobileStore(<SuperagentScreen />, {
      api: {
        superagent: {
          listThreads: { query: async () => [] },
          sendTurn: { mutate: sendTurn },
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

    await act(async () => {
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

    act(() => {
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

    act(() => frames[0]?.(0))

    expect(screen.getByTestId('superagent-live-text').textContent).toBe('one two three')
    expect(screen.getByTestId('superagent-working-indicator').textContent).toBe('Bash')
    expect(transcriptProps.at(-1)?.items).toBe(settledBeforeStreaming)

    act(() => {
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

    act(() => {
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
    expect(cancelFrame).toHaveBeenCalledWith(3)
    expect(screen.getByTestId('superagent-live-text').textContent).toBe('')
    expect(screen.getByTestId('superagent-working-indicator').textContent).toBe('starting')

    act(() => {
      view.emit('headlessActivity', 'session:superagent', {
        kind: 'partial-text',
        text: 'cancel on unmount',
      })
    })
    expect(requestFrame).toHaveBeenCalledTimes(4)
    view.unmount()
    expect(cancelFrame).toHaveBeenCalledWith(4)
  })
})
