import type { SessionResurrectionResult } from '@podium/client-core/engine'
import type { SessionView } from '@podium/client-core/session-values'
import type { TranscriptItem } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { act, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }))
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
vi.mock('./TaskSheet', () => ({ TaskSheet: () => null }))
vi.mock('./ArtifactViewer', () => ({ ArtifactViewer: () => null }))
vi.mock('./ActionSheet', () => ({ ActionSheet: () => null }))
vi.mock('./SharedFiles', () => ({ SharedFiles: () => null }))
vi.mock('./RichMarkdown', () => ({
  RichMarkdownInline: ({ text }: { text: string }) => <>{text}</>,
  RichMarkdown: ({ text }: { text: string }) => <span>{text}</span>,
}))

const { SessionConversation } = await import('./SessionConversation')

const parked = {
  sessionId: 'sess-hibernated',
  agentKind: 'claude-code',
  cwd: '/repo',
  title: 'Hibernated conversation',
  status: 'hibernated',
  resumable: true,
  transcriptAvailable: true,
} as unknown as SessionView

const lastMessage: TranscriptItem = {
  id: 'last-message',
  role: 'assistant',
  ts: '2026-11-13T06:00:00Z',
  text: 'The conversation is ready to continue.',
}
const history = [lastMessage]

async function openConversation({
  items = history,
  session = parked,
  resurrect = vi.fn(async (): Promise<SessionResurrectionResult> => ({ ok: true })),
  resumeAndSend = vi.fn(async () => ({ ok: true })),
} = {}) {
  const sendText = vi.fn(async () => ({ ok: true }))
  const view = await renderWithMobileStore(
    <SessionConversation session={session} issue={undefined} />,
    {
      sessions: [session],
      api: {
        sessions: {
          transcriptRead: { query: async () => ({ items, hasMore: false }) },
          answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
          resurrect: { mutate: resurrect },
          resumeAndSend: { mutate: resumeAndSend },
          sendText: { mutate: sendText },
        },
        messages: {
          ledger: { query: async () => [] },
          cancel: { mutate: async () => {} },
        },
      },
    },
  )
  return { ...view, resurrect, resumeAndSend, sendText }
}

describe('hibernated conversation notice', () => {
  it('ends the real transcript footer after the conversation and its offer, with no top bar', async () => {
    const session = {
      ...parked,
      offer: {
        createdAt: '2026-11-13T06:01:00Z',
        message: 'Ready to review',
        actions: [{ label: 'Review', prompt: 'review it' }],
      },
    } as SessionView
    const { container } = await openConversation({ session })
    await waitFor(() => expect(screen.getByText(lastMessage.text)).toBeTruthy())

    const scroller = screen.getByTestId('transcript-scroller')
    const footer = container.querySelector('[data-row-key="transcript:footer"]')
    const notice = screen.getByTestId('hibernated-notice')
    const offer = screen.getByTestId('session-action-card')
    expect(scroller.contains(notice)).toBe(true)
    expect(footer?.contains(notice)).toBe(true)
    expect(footer?.textContent?.endsWith(`${notice.textContent}`)).toBe(true)
    const message = within(scroller).getByText(lastMessage.text)
    expect(message.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(offer.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByTestId('hibernated-notice')).toHaveLength(1)
    expect(screen.queryByTestId('lifecycle-banner')).toBeNull()
    expect(screen.queryByTestId('lifecycle-pane')).toBeNull()
    expect(screen.getByPlaceholderText('Message to wake it')).toBeTruthy()
  })

  it('uses the note for an empty hibernated transcript without an idle empty-state prompt', async () => {
    await openConversation({ items: [] })
    expect(screen.getByTestId('hibernated-notice')).toBeTruthy()
    expect(screen.queryByTestId('transcript-empty')).toBeNull()
    expect(screen.getByPlaceholderText('Message to wake it')).toBeTruthy()
  })

  it('calls resurrectSession through Resume and shows Waking until it settles', async () => {
    let finish: ((result: SessionResurrectionResult) => void) | undefined
    const resurrect = vi.fn(
      () =>
        new Promise<SessionResurrectionResult>((resolve) => {
          finish = resolve
        }),
    )
    await openConversation({ resurrect })
    const button = screen.getByRole('button', { name: 'Resume' })
    fireEvent.click(button)
    await waitFor(() => expect(resurrect).toHaveBeenCalledWith({ sessionId: parked.sessionId }))
    expect(button.textContent).toBe('Waking…')
    await act(async () => finish?.({ ok: true }))
    expect(button.textContent).toBe('Resume')
  })

  it('keeps sending on the existing resumeAndSend path', async () => {
    const { resurrect, resumeAndSend, sendText } = await openConversation()
    const input = screen.getByPlaceholderText('Message to wake it')
    fireEvent.change(input, { target: { value: 'Continue with the review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(resumeAndSend).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: parked.sessionId, text: 'Continue with the review' }),
      ),
    )
    expect(sendText).not.toHaveBeenCalled()
    expect(resurrect).not.toHaveBeenCalled()
  })

  it('keeps the notice and wake placeholder out of a live session', async () => {
    await openConversation({ session: { ...parked, status: 'live' } as SessionView })
    expect(screen.queryByTestId('hibernated-notice')).toBeNull()
    expect(screen.queryByPlaceholderText('Message to wake it')).toBeNull()
  })
})
