/**
 * ACCEPTING AN OFFER IS A SEND, AND MUST LOOK LIKE ONE [POD-1354].
 *
 * The action button used to call straight through to the wire with no
 * optimistic half: the card stayed put, no bubble appeared, and the tail still
 * read idle until the server echoed the turn — minutes, on the parked session an
 * offer usually comes from. These tests pin all three optimistic parts and,
 * just as importantly, pin that a REFUSED send puts every one of them back.
 */

import type { SessionMeta } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
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
vi.mock('./Composer', () => ({ Composer: () => null }))

/**
 * The transcript, reduced to the facts these tests are about: the footer
 * (where the offer card lives), the optimistic rows, the tail's tone, and the
 * empty state — rendered whenever it is passed, which is what the real
 * FlatList does with an empty row array.
 */
vi.mock('./TranscriptList', () => ({
  TranscriptList: ({
    emptyComponent,
    footer,
    pendingTurns,
    tail,
  }: {
    emptyComponent?: ReactNode
    footer?: ReactNode
    pendingTurns?: readonly PendingTurn[]
    tail?: { label: string; tone: string }
  }) => (
    <div>
      <div data-testid="tail">{`${tail?.tone ?? 'none'}:${tail?.label ?? ''}`}</div>
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
} as unknown as SessionMeta

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
    expect(screen.getByTestId('tail').textContent).toContain('working')
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
  } as unknown as SessionMeta

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
    } as unknown as SessionMeta
    await renderWithMobileStore(<SessionConversation session={working} issue={undefined} />, {
      sessions: [working],
    })

    await waitFor(() => expect(screen.getByTestId('transcript-empty')).toBeTruthy())
    expect(screen.getByText('The agent is on it')).toBeTruthy()
    expect(screen.getByTestId('working-mark')).toBeTruthy()
    expect(screen.queryByText('Nothing here yet')).toBeNull()
  })

  it('reads a booting agent as a transcript on its way, before agentState says anything', async () => {
    const starting = { ...bare, status: 'starting' } as unknown as SessionMeta
    await renderWithMobileStore(<SessionConversation session={starting} issue={undefined} />, {
      sessions: [starting],
    })

    await waitFor(() => expect(screen.getByTestId('transcript-empty')).toBeTruthy())
    expect(screen.getByText('The agent is on it')).toBeTruthy()
  })
})
