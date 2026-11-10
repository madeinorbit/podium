import { Sends, TranscriptLog } from '@podium/client-core/conversation'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { asSessionId, type SessionOffer } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { observable, runInAction } from 'mobx'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ conversation: undefined as unknown }))
vi.mock('../SessionConversation', () => ({ useSessionConversation: () => host.conversation }))
vi.mock('../../client/hooks', () => ({ useHttpOrigin: () => '' }))
vi.mock('../../client/mobile-pool', () => ({ useMobilePool: () => null }))
vi.mock('../../client/ServerProfileGate', () => ({ useServerProfile: () => ({ bearer: null }) }))
vi.mock('../../client/server-profile-context', () => ({ useOptionalServerProfile: () => null }))
vi.mock('../ArtifactViewer', () => ({ ArtifactViewer: () => null }))
vi.mock('../SessionActionCard', async () => ({
  ...(await vi.importActual<typeof import('../SessionActionCard')>('../SessionActionCard')),
}))
vi.mock('../OfferArtifactStrip', () => ({ OfferArtifactStrip: () => null }))
vi.mock('../BottomSheet', () => ({
  BottomSheet: ({
    visible,
    children,
    head,
  }: {
    visible: boolean
    children: React.ReactNode
    head: React.ReactNode
  }) =>
    visible ? (
      <div>
        {head}
        {children}
      </div>
    ) : null,
}))
vi.mock('./chrome', () => ({ Disclosure: () => null }))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' }, impactAsync: vi.fn() }))

const { TaskSummary } = await import('./TaskOverview')
afterEach(() => {
  cleanup()
  host.conversation = undefined
})
const offer = (createdAt: string): SessionOffer => ({
  createdAt,
  message: 'Review ready',
  actions: [
    { label: 'Change it', prompt: 'Revise this', input: true },
    { label: 'Accept', prompt: 'Accept this' },
  ],
})
const lead = (id: string) => ({ sessionId: asSessionId(id) }) as SessionView
function setup() {
  const onAccept = vi.fn(async () => {})
  const props: ComponentProps<typeof TaskSummary> = {
    issue: { activityNotes: 'Ready for review' } as IssueViewModel,
    lead: lead('A'),
    offer: offer('stamp-A'),
    onAccept,
    onOpenSession: vi.fn(),
    onComment: vi.fn(),
  }
  const rendered = render(<TaskSummary {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Change it' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Change it' }), {
    target: { value: 'Keep the spacing' },
  })
  return { props, rendered, onAccept }
}
it('sends unchanged feedback to the captured session and offer stamp', async () => {
  const { onAccept } = setup()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
  expect(onAccept).toHaveBeenCalledExactlyOnceWith(
    'A',
    'Revise this\n\nKeep the spacing',
    'stamp-A',
  )
})
it.each([
  'lead',
  'offer',
  'cleared',
])('rejects feedback after the %s changes while the sheet is open', async (change) => {
  const { props, rendered, onAccept } = setup()
  rendered.rerender(
    <TaskSummary
      {...props}
      lead={change === 'lead' ? lead('B') : props.lead}
      offer={change === 'cleared' ? null : offer(change === 'offer' ? 'stamp-B' : 'stamp-A')}
    />,
  )
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
  expect(onAccept).not.toHaveBeenCalled()
  expect(screen.getByText(/This offer has changed/)).toBeTruthy()
})
it('sends a direct action with its source stamp', async () => {
  const { rendered, props, onAccept } = setup()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  rendered.rerender(<TaskSummary {...props} />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Accept' })))
  expect(onAccept).toHaveBeenCalledExactlyOnceWith('A', 'Accept this', 'stamp-A')
})

it('uses shared sendOffer dismissal and restores the offer after delivery fails', async () => {
  const { TaskOfferSummary } = await import('./TaskOfferSummary')
  const sessionId = asSessionId('A')
  const context = observable({ canInterrupt: false, offer: offer('stamp-A') })
  let fail!: (error: Error) => void
  const deliver = vi.fn(
    (_turn: unknown) =>
      new Promise<void>((_resolve, reject) => {
        fail = reject
      }),
  )
  const transcript = new TranscriptLog({
    sessionId,
    source: { read: async () => ({ items: [], hasMore: false }), subscribe: () => () => {} },
  })
  const sends = new Sends({
    sessionId,
    transcript,
    readContext: () => context,
    drafts: { get: () => '', set: () => {} },
    createDeliveryId: () => 'delivery',
    deliver,
  })
  host.conversation = {
    session: { sessionId },
    get offer() {
      return sends.offer
    },
    sendOffer: (prompt: string, at: string) => sends.sendOffer(prompt, at),
  }
  try {
    render(
      <TaskOfferSummary
        issue={{ activityNotes: 'Ready' } as IssueViewModel}
        lead={lead('A')}
        onOpenSession={() => {}}
        onComment={() => {}}
      />,
    )
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Accept' })))
    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ kind: 'offer', wire: 'Accept this' })
    expect(sends.dismissedOfferAt).toBe('stamp-A')
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    await act(async () => fail(new Error('Offline')))
    expect(sends.dismissedOfferAt).toBeNull()
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy()
    expect(screen.getByText(/Offline/)).toBeTruthy()
    // A replacement remains visible even though the previous offer was dismissed.
    act(() =>
      runInAction(() => {
        context.offer = offer('replacement')
      }),
    )
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy()
  } finally {
    sends.dispose()
    transcript.dispose()
  }
})
