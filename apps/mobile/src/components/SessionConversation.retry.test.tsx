import type { SessionView } from '@podium/client-core/session-values'
import { asSessionId, type MessageRecordWire, type TranscriptItem } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { type ReactNode, useLayoutEffect, useState } from 'react'
import { Platform } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import type { PendingTurn } from './TranscriptList'

const originalOS = Platform.OS
afterEach(() => {
  cleanup()
  Platform.OS = originalOS
})

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('./Composer', () => ({
  Composer: ({ onRestingHeight }: { onRestingHeight?: (height: number) => void }) => {
    useLayoutEffect(() => onRestingHeight?.(100), [onRestingHeight])
    return <div data-testid="composer" />
  },
}))
vi.mock('./PullToRefreshBoundary', () => ({
  PullToRefreshBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('./SessionActionCard', () => ({ SessionActionCard: () => null }))
vi.mock('./TaskSheet', () => ({ TaskSheet: () => null }))
// Keep the real bootstrap crossfade: a pending bubble hidden underneath its
// placeholder is the bug, even when the list has mounted successfully.
vi.mock('./TranscriptList', () => ({
  TranscriptList: ({
    transcript,
    pendingTurns,
    emptyComponent,
  }: {
    transcript: { items: TranscriptItem[] }
    pendingTurns: readonly PendingTurn[]
    emptyComponent?: ReactNode
  }) => (
    <div data-testid="transcript-list">
      {transcript.items.map((item) => (
        <div key={item.id}>{item.text}</div>
      ))}
      {pendingTurns.map((turn) => (
        <div key={turn.id} data-testid="pending">
          {turn.text}
          {turn.files?.map((file) => (
            <span key={file.path}>{file.path}</span>
          ))}
        </div>
      ))}
      {emptyComponent}
    </div>
  ),
}))

const { SessionConversation } = await import('./SessionConversation')
const session = {
  sessionId: asSessionId('retry-chat'),
  agentKind: 'claude-code',
  cwd: '/repo',
  status: 'live',
  transcriptAvailable: true,
} as SessionView
const prompt = 'Review the image'
const record: MessageRecordWire = {
  id: 'retry-first-prompt',
  sessionId: session.sessionId,
  senderUserId: 'user:test',
  body: prompt,
  createdAt: '2026-11-17T20:00:00Z',
  status: 'stored',
  initialPrompt: true,
  attachments: [
    { id: 'retry-image', filename: 'retry.png', mediaType: 'image/png', kind: 'image' },
  ],
}

it('shows the optimistic first turn while session recognition defers the transcript', async () => {
  Platform.OS = 'ios'
  const read = vi.fn(async () => ({ items: [], hasMore: false }))
  await renderWithMobileStore(
    <SessionConversation
      session={session}
      issue={undefined}
      initialPendingText={prompt}
      deferInitialTranscript
    />,
    { sessions: [session], api: { sessions: { transcriptRead: { query: read } } } },
  )
  expect(screen.getByTestId('pending').textContent).toBe(prompt)
  expect(screen.queryByTestId('bootstrap-placeholder')).toBeNull()
  expect(read).not.toHaveBeenCalled()
})

it.each([
  { items: [] as TranscriptItem[] },
  {
    items: [
      { id: 'assistant-only', role: 'assistant', text: 'The transcript is already here.' },
    ] as TranscriptItem[],
  },
])('activates the retained chat after a failed deferred mount, retry and reopen without a first-prompt echo: %j', async ({
  items,
}) => {
  Platform.OS = 'ios'
  const read = vi.fn(async () => ({ items, hasMore: false }))
  const sendText = vi.fn(async () => ({ ok: true }))
  const resumeAndSend = vi.fn(async () => ({ ok: true }))
  function Host() {
    const [phase, setPhase] = useState('first')
    return (
      <>
        {['closed', 'retry', 'accepted', 'reopened'].map((next) => (
          <button key={next} type="button" onClick={() => setPhase(next)}>
            {next}
          </button>
        ))}
        {phase !== 'closed' ? (
          <SessionConversation
            key={phase === 'first' ? 'first' : 'retry'}
            session={session}
            issue={undefined}
            initialPendingText={phase === 'reopened' ? undefined : prompt}
            deferInitialTranscript={phase === 'first' || phase === 'retry'}
          />
        ) : null}
      </>
    )
  }
  const app = await renderWithMobileStore(<Host />, {
    sessions: [session],
    messageRecords: [record],
    api: {
      sessions: {
        transcriptRead: { query: read },
        sendText: { mutate: sendText },
        resumeAndSend: { mutate: resumeAndSend },
      },
    },
  })
  const subscribe = vi.spyOn(app.runtime.services.connection.hub, 'subscribeTranscript')
  expect(read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'closed' }))
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  expect(read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'accepted' }))

  await waitFor(() => expect(read).toHaveBeenCalledOnce())
  await waitFor(() => expect(subscribe).toHaveBeenCalledOnce())
  expect(screen.queryByTestId('bootstrap-placeholder')).toBeNull()
  expect(screen.getAllByTestId('pending')).toHaveLength(1)
  expect(screen.getByTestId('pending').textContent).toContain(prompt)
  expect(screen.getByText('retry.png')).toBeTruthy()
  for (const item of items) expect(screen.getByText(item.text)).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'closed' }))
  fireEvent.click(screen.getByRole('button', { name: 'reopened' }))
  expect(screen.queryByTestId('bootstrap-placeholder')).toBeNull()
  expect(screen.getAllByTestId('pending')).toHaveLength(1)
  for (const item of items) expect(screen.getByText(item.text)).toBeTruthy()
  expect(sendText).not.toHaveBeenCalled()
  expect(resumeAndSend).not.toHaveBeenCalled()
})

it('opens a confirmed chat without an optimistic seed when its transcript has no first-prompt echo', async () => {
  Platform.OS = 'ios'
  const read = vi.fn(async () => ({
    items: [{ id: 'assistant-only', role: 'assistant', text: 'Loaded after reopening.' }],
    hasMore: false,
  }))
  await renderWithMobileStore(<SessionConversation session={session} issue={undefined} />, {
    sessions: [session],
    messageRecords: [record],
    api: { sessions: { transcriptRead: { query: read } } },
  })
  await screen.findByText('Loaded after reopening.')
  expect(screen.queryByTestId('bootstrap-placeholder')).toBeNull()
  expect(screen.getAllByTestId('pending')).toHaveLength(1)
  expect(screen.getByText('retry.png')).toBeTruthy()
})
