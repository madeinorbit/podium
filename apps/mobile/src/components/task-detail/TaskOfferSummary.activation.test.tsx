import type { SessionView } from '@podium/client-core/session-values'
import { here } from '@podium/client-graph/lookup'
import { asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobilePool } from '../../client/mobile-pool'
import { renderWithMobileStore } from '../../client/test-support'

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Error: 'error' },
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}))
vi.mock('../ArtifactViewer', () => ({ ArtifactViewer: () => null }))
vi.mock('../TaskSheet', () => ({ TaskSheet: () => null }))
vi.mock('../TranscriptList', () => ({ TranscriptList: () => null }))
vi.mock('./TaskOverview', () => ({
  TaskSummary: ({
    offer,
    lead,
    onAccept,
  }: {
    offer: SessionView['offer']
    lead: SessionView
    onAccept: (id: string, prompt: string, stamp: string) => Promise<void>
  }) =>
    offer ? (
      <button
        type="button"
        onClick={() => void onAccept(lead.sessionId, 'Accept', offer.createdAt)}
      >
        Accept
      </button>
    ) : (
      <div>No offer</div>
    ),
}))
const { TaskOfferSummary } = await import('./TaskOfferSummary')
const { useSessionConversation } = await import('../SessionConversation')
afterEach(cleanup)

const lead = {
  sessionId: asSessionId('lead'),
  agentKind: 'claude-code',
  cwd: '/repo',
  status: 'live',
  title: 'Lead',
  createdAt: '2026-11-01T00:00:00Z',
  lastActiveAt: '2026-11-01T00:00:00Z',
  agentState: { phase: 'idle', since: '2026-11-01T00:00:00Z' },
} as SessionView
function Chat({ session }: { session: SessionView }) {
  const conversation = useSessionConversation({ session })
  return <div>{conversation ? 'Chat ready' : 'Loading chat'}</div>
}
const Opened = observer(function Opened() {
  const pool = useMobilePool()
  const session = pool ? here(pool.model('session', lead.sessionId)) : undefined
  const [chat, setChat] = useState(false)
  if (!session) return null
  return (
    <>
      <TaskOfferSummary
        issue={{} as never}
        lead={session as unknown as SessionView}
        onOpenSession={() => {}}
        onComment={() => {}}
      />
      <button type="button" onClick={() => setChat(true)}>
        Open chat
      </button>
      {chat ? <Chat session={session as unknown as SessionView} /> : null}
    </>
  )
})
it.each([
  false,
  true,
])('summary with offer=%s makes no transcript read; opening chat activates it once', async (hasOffer) => {
  const read = vi.fn(async () => ({ items: [], hasMore: false }))
  const send = vi.fn(async () => {})
  await renderWithMobileStore(<Opened />, {
    sessions: [
      {
        ...lead,
        ...(hasOffer
          ? {
              offer: {
                createdAt: 'stamp',
                message: 'Ready',
                actions: [{ label: 'Accept', prompt: 'Accept' }],
              },
            }
          : {}),
      },
    ],
    api: {
      sessions: { transcriptRead: { query: read }, sendText: { mutate: send } },
      messages: { ledger: { query: async () => [] } },
    },
  })
  await act(async () => {})
  expect(read).not.toHaveBeenCalled()
  if (hasOffer) {
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Accept' })))
    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(read).not.toHaveBeenCalled()
  } else expect(screen.getByText('No offer')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open chat' })))
  await waitFor(() => expect(read).toHaveBeenCalledOnce())
  expect(screen.getByText('Chat ready')).toBeTruthy()
})
