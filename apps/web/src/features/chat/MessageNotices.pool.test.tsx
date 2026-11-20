import '../../../test/shared-notice-model-fixture'
import { NOTICE_MESSAGE_WINDOW } from '@podium/client-graph/notice-views'
import type { JSX, ReactNode } from 'react'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { noticeFixture } from '../../../../../tests/worklist/diagnostics/notice-fixture'
import { OutboxRecoveryList } from '../machines/OutboxRecovery'
import { MessageNoticeList } from './MessageNotices'
import { PendingInteractionBar } from './PendingInteractionBar'
import { usePoolMessageNoticeCount } from './use-pool-notices'

const mock = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  pool: {} as unknown,
  selectors: vi.fn(),
  dismiss: vi.fn(async () => ({})),
  answer: vi.fn(async () => ({ ok: true })),
  open: vi.fn(),
  discard: vi.fn(),
  retry: vi.fn(),
  edit: vi.fn(),
  owner: {
    get access() {
      return mock.state
    },
  },
  rows: vi.fn(),
}))
vi.mock('@podium/client-core/react', async () => {
  const { fixtureRuntimeHooks } = await import('@podium/client-core/test-support/command-hooks')
  return {
    ...fixtureRuntimeHooks(() => mock.owner),
    useOutboxRecovery: () => mock.state.recoverOutbox,
  }
})
vi.mock('@/app/store', () => ({
  readFixture: () => {
    mock.selectors()
    throw new Error('Legacy notice selector executed')
  },
}))
vi.mock('@/app/store-worklist-pool', () => ({
  // No pool: an answer resolves on the server's word (useAnswerSession).
  useWorklistPool: () => null,
  useWorklistPoolProjection: (read: (pool: unknown) => unknown, empty: unknown, active = true) =>
    active ? read(mock.pool) : empty,
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: JSX.Element }) => render,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ui/dialog', () =>
  Object.fromEntries(
    ['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription'].map((name) => [
      name,
      ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ]),
  ),
)

let root: Root, container: HTMLDivElement
beforeEach(() => {
  const data = noticeFixture('selected-session')
  const catalog = {
    messages: data.messages.map((row) => row.id),
    interactions: data.interactions.map((row) => row.id),
    deadLetters: data.deadLetters.map((row) => row.entry.mutationId),
  }
  mock.rows.mockReset().mockImplementation((entity: string, id: string) => {
    if (entity === 'noticeCatalog') return catalog
    if (entity === 'noticeAttention') return { count: 3, newest: 'notice-message-2' }
    if (entity === 'noticeMessageCatalog') return { messages: catalog.messages.slice(0, 3) }
    if (entity === 'noticeRecoveryCatalog') return { deadLetters: catalog.deadLetters }
    if (entity === 'noticeSession')
      return { messages: catalog.messages, interactions: catalog.interactions }
    if (entity === 'messageRecord') return data.messages.find((row) => row.id === id)
    if (entity === 'session') return data.sessions.find((row) => row.sessionId === id)
    if (entity === 'pendingInteraction') return data.interactions.find((row) => row.id === id)
    if (entity === 'outboxDeadLetter')
      return data.deadLetters.find((row) => row.entry.mutationId === id)
  })
  mock.pool = { row: mock.rows }
  mock.state = {
    messageRecords: data.messages,
    sessions: data.sessions,
    pendingInteractions: data.interactions,
    outboxDeadLetters: data.deadLetters,
    trpc: {
      messages: { dismissNotice: { mutate: mock.dismiss } },
      interactions: { answer: { mutate: mock.answer } },
    },
    navigateToSession: mock.open,
    answerSession: mock.answer,
    recoverOutbox: { discard: mock.discard, retry: mock.retry, edit: mock.edit },
  }
  for (const fn of [
    mock.selectors,
    mock.dismiss,
    mock.answer,
    mock.open,
    mock.discard,
    mock.retry,
    mock.edit,
  ])
    fn.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
/**
 * The sync panel's contract for this list (POD-6852): a closed panel reads the
 * count alone, the list mounts only while the panel is open, and opening a
 * chat closes the panel behind it.
 */
function NoticePanel(): JSX.Element | null {
  const count = usePoolMessageNoticeCount()
  const [open, setOpen] = useState(false)
  if (count === 0) return null
  return open ? (
    <MessageNoticeList onOpenChat={() => setOpen(false)} />
  ) : (
    <button type="button" data-testid="notice-panel-open" onClick={() => setOpen(true)}>
      {count} need review
    </button>
  )
}
const render = () =>
  act(() =>
    root.render(
      <>
        <NoticePanel />
        <PendingInteractionBar sessionId={'selected-session' as never} />
        <OutboxRecoveryList />
      </>,
    ),
  )
const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === label,
  )!
  expect(button).toBeTruthy()
  await act(async () => {
    button.click()
  })
}
const openNotices = () =>
  act(() =>
    (container.querySelector('[data-testid="notice-panel-open"]') as HTMLButtonElement).click(),
  )

it('uses zero legacy selectors and derivations and retains open, dismiss, answer and discard actions', async () => {
  render()
  openNotices()
  await click('Dismiss')
  await click('Open chat')
  await click('I signed in, retry')
  await click('Discard')
  expect(mock.open).toHaveBeenCalledWith('missing-session')
  expect(mock.dismiss).toHaveBeenCalledWith({ id: 'notice-message-2' })
  expect(mock.answer).toHaveBeenCalledExactlyOnceWith('selected-session', {
    via: 'interaction',
    interactionId: 'notice-ask-8',
    answer: { kind: 'login', outcome: 'completed' },
  })
  expect(mock.discard).toHaveBeenCalledWith('notice-mutation-0')
  expect(mock.selectors).not.toHaveBeenCalled()
})

it('retains recover and edited-send payloads on the existing mutation owner', async () => {
  render()
  const retry = container.querySelector('[data-testid="outbox-retry"]') as HTMLButtonElement
  await act(async () => retry.click())
  expect(mock.retry).toHaveBeenCalledWith('notice-mutation-1', { rightsFixed: true })
  await click('Edit')
  await click('Send updated')
  expect(mock.edit).toHaveBeenCalledWith('notice-mutation-0', {
    id: 'invisible-target',
    patch: { title: 'Synthetic authored 0' },
  })
  expect(mock.selectors).not.toHaveBeenCalled()
})

it('preserves saved notice, interaction and recovery output', () => {
  render()
  openNotices()
  expect(container.textContent).toMatchSnapshot('last green notices and recovery')
  expect(mock.selectors).not.toHaveBeenCalled()
})

it('says when older notices stay in their chats', () => {
  const base = mock.rows.getMockImplementation()!
  mock.rows.mockImplementation((entity: string, id: string) => {
    if (entity === 'noticeAttention')
      return { count: NOTICE_MESSAGE_WINDOW + 1, newest: 'notice-message-2' }
    return base(entity, id)
  })
  act(() => root.render(<NoticePanel />))
  openNotices()
  expect(container.textContent).toContain(`Showing the newest ${NOTICE_MESSAGE_WINDOW}`)
})

it('reads only the count with the list closed and releases list reads after opening a chat', async () => {
  act(() => root.render(<NoticePanel />))
  expect(mock.rows.mock.calls.map(([entity]) => entity)).toEqual(['noticeAttention'])
  mock.rows.mockClear()
  openNotices()
  expect(mock.rows.mock.calls.some(([entity]) => entity === 'noticeMessageCatalog')).toBe(true)
  expect(mock.rows.mock.calls.filter(([entity]) => entity === 'messageRecord')).toHaveLength(3)
  mock.rows.mockClear()
  await click('Open chat')
  expect(
    mock.rows.mock.calls.some(
      ([entity]) => entity === 'noticeMessageCatalog' || entity === 'messageRecord',
    ),
  ).toBe(false)
})
