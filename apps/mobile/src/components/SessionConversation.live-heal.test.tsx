import type { SessionView } from '@podium/client-core/session-values'
/**
 * THE PHONE'S TRANSCRIPT DOES NOT WAIT FOR A RELOAD [POD-4643].
 *
 * The acceptance run sent a message from the phone ~1 min after a daemon
 * restart. The agent answered ("49 LEMON" on the desktop) but the phone kept
 * the bubble "waiting its turn" for 150 s; a reload showed the answer at once.
 * The live transcript stream is lossy by contract, and the server had not
 * forwarded that turn's answer. The desktop chat survives exactly that because
 * it re-reads when the session row moves and probes the tail on a heartbeat
 * while the session is live [POD-701]; the phone relied on the stream alone.
 *
 * These tests run the REAL conversation over a socket that never delivers a
 * frame, so the only way the answer can appear is the phone reading it.
 */

import type { TranscriptItem } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
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
vi.mock('./TranscriptList', async () => {
  const { observer } = await import('mobx-react-lite')
  const { Pressable, Text, View } = await import('react-native')
  return {
    TranscriptList: observer(({
      transcript,
    items = transcript?.ids.map(id => transcript.byId.get(id)!) ?? [],
      onLoadOlder,
      onFollowChange,
      onSearchChange,
    }: {
      transcript?: import('@podium/client-core/conversation').TranscriptLog
      items?: readonly TranscriptItem[]
      onLoadOlder?: () => void
      onFollowChange?: (following: boolean) => void
      onSearchChange?: (searching: boolean) => void
    }) => (
      <View>
        <Pressable accessibilityLabel="Read history" onPress={() => onFollowChange?.(false)}>
          <Text>Read</Text>
        </Pressable>
        <Pressable accessibilityLabel="Load history" onPress={onLoadOlder}>
          <Text>Older</Text>
        </Pressable>
        <Pressable accessibilityLabel="Follow newest" onPress={() => onFollowChange?.(true)}>
          <Text>Follow</Text>
        </Pressable>
        <Pressable accessibilityLabel="Find history" onPress={() => onSearchChange?.(true)}>
          <Text>Find</Text>
        </Pressable>
        <Pressable accessibilityLabel="Finish find" onPress={() => onSearchChange?.(false)}>
          <Text>Finish</Text>
        </Pressable>
        {items.map((entry) => (
          <Text key={entry.id}>{entry.text}</Text>
        ))}
      </View>
    )),
  }
})

const { SessionConversation } = await import('./SessionConversation')

const working = {
  sessionId: 'sess-grok',
  agentKind: 'grok',
  cwd: '/repo',
  status: 'live',
  title: 'Agent',
  lastActiveAt: '2026-09-23T07:47:56.000Z',
  agentState: { phase: 'working', since: '2026-09-23T07:47:56.000Z' },
} as unknown as SessionView

function entry(
  id: string,
  cursor: string,
  role: 'user' | 'assistant',
  text: string,
): TranscriptItem {
  return { id, cursor, role, text }
}

/** What the agent has written, answered to every read like the server's
 *  transcript read does — newest window, or the page before an anchor. */
function authority(initial?: TranscriptItem[]) {
  const written: TranscriptItem[] = initial ?? [
    entry('u1', 'c1', 'user', 'What is 2 times 50?'),
    entry('a1', 'c2', 'assistant', '100 DATE'),
    entry('u2', 'c3', 'user', 'What is 7 times 7?'),
  ]
  const transcriptRead = vi.fn(async (request: { anchor?: string; limit: number }) => {
    const end = request.anchor
      ? written.findIndex((item) => item.cursor === request.anchor)
      : written.length
    const start = Math.max(0, end - request.limit)
    const items = written.slice(start, end)
    return { items, head: items[0]?.cursor, tail: items.at(-1)?.cursor, hasMore: start > 0 }
  })
  return { written, transcriptRead }
}

let moveRow: (next: SessionView) => void = () => {}

function Screen({ initial }: { initial: SessionView }) {
  const [session, setSession] = useState(initial)
  moveRow = setSession
  return <SessionConversation session={session} issue={undefined} />
}

async function mount(initial?: TranscriptItem[]) {
  const io = authority(initial)
  await renderWithMobileStore(<Screen initial={working} />, {
    sessions: [working],
    api: {
      sessions: {
        transcriptRead: { query: io.transcriptRead },
        answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
        interrupt: { mutate: async () => ({ ok: true }) },
      },
    },
  })
  await screen.findByText(initial?.at(-1)?.text ?? 'What is 7 times 7?')
  return io
}

describe('phone transcript over a live stream that went quiet', () => {
  it('retains find history before a match moves the viewport, then resumes the newest window', async () => {
    const initial = Array.from({ length: 180 }, (_, index) =>
      entry(`i${index}`, `c${index}`, 'assistant', `Message ${index}`),
    )
    const io = await mount(initial)
    fireEvent.click(screen.getByLabelText('Find history'))
    fireEvent.click(screen.getByLabelText('Load history'))
    expect(await screen.findByText('Message 20')).toBeTruthy()
    io.written.push(entry('new', 'c180', 'assistant', 'New while finding'))
    act(() => moveRow({ ...working, lastActiveAt: '2026-09-23T07:49:00.000Z' } as SessionView))
    expect(await screen.findByText('New while finding')).toBeTruthy()
    expect(screen.getByText('Message 20')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Finish find'))
    io.written.push(entry('later', 'c181', 'assistant', 'After finding'))
    act(() => moveRow({ ...working, lastActiveAt: '2026-09-23T07:50:00.000Z' } as SessionView))
    expect(await screen.findByText('After finding')).toBeTruthy()
    expect(screen.queryByText('Message 20')).toBeNull()
  })
  it('retains paged history during activity refresh while reading, then permits trimming on follow', async () => {
    const initial = Array.from({ length: 180 }, (_, index) =>
      entry(`i${index}`, `c${index}`, 'assistant', `Message ${index}`),
    )
    const io = await mount(initial)
    fireEvent.click(screen.getByLabelText('Read history'))
    fireEvent.click(screen.getByLabelText('Load history'))
    expect(await screen.findByText('Message 20')).toBeTruthy()
    io.written.push(entry('new', 'c180', 'assistant', 'New live answer'))
    act(() => moveRow({ ...working, lastActiveAt: '2026-09-23T07:49:00.000Z' } as SessionView))
    expect(await screen.findByText('New live answer')).toBeTruthy()
    expect(screen.getByText('Message 20')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Follow newest'))
    io.written.push(entry('later', 'c181', 'assistant', 'Later answer'))
    act(() => moveRow({ ...working, lastActiveAt: '2026-09-23T07:50:00.000Z' } as SessionView))
    expect(await screen.findByText('Later answer')).toBeTruthy()
    expect(screen.queryByText('Message 20')).toBeNull()
  })
  it('shows the answer once the session row moves, without a reload', async () => {
    const io = await mount()
    io.written.push(entry('a2', 'c4', 'assistant', '49 LEMON'))
    act(() =>
      moveRow({
        ...working,
        lastActiveAt: '2026-09-23T07:47:58.313Z',
        agentState: { phase: 'idle', since: '2026-09-23T07:47:58.313Z' },
      } as unknown as SessionView),
    )
    expect(await screen.findByText('49 LEMON', {}, { timeout: 3000 })).toBeTruthy()
  })

  it('shows the answer while the row is stuck on Working — the reported case', async () => {
    const io = await mount()
    io.written.push(entry('a2', 'c4', 'assistant', '49 LEMON'))
    // Nothing on the row moves: the server still says Working. Only the
    // heartbeat under a live session can find the answer.
    await waitFor(() => expect(screen.getByText('49 LEMON')).toBeTruthy(), { timeout: 9000 })
  }, 15_000)
})
