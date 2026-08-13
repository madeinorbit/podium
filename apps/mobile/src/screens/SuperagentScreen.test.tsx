/**
 * Phone Superagent chrome: the large Screen header Work/Tasks wear, no
 * leftover OVERARCHING bar, and sendTurn carries the prompt-box backend.
 */
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
  TranscriptList: () => <div>transcript</div>,
}))
vi.mock('../components/Composer', () => ({
  Composer: ({
    below,
    onSend,
  }: {
    below?: ReactNode
    onSend: (text: string) => void
  }) => (
    <div>
      {below}
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
vi.mock('../components/StatusGlyphs', () => ({
  BrailleSpinner: () => null,
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
})
