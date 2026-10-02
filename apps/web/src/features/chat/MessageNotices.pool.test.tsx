import type { JSX, ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { noticeFixture } from '@podium/client-graph/diagnostics/notice-fixture'
import { noticeReadStats } from './notice-data-layer'
import { MessageNoticeIndicator } from './MessageNotices'
import { PendingInteractionBar } from './PendingInteractionBar'
import { OutboxRecoveryIndicator } from '../machines/OutboxRecovery'

const mock = vi.hoisted(() => ({ mode: 'pool', state: {} as Record<string, unknown>, pool: {} as unknown,
  selectors: vi.fn(), dismiss: vi.fn(async () => ({})), answer: vi.fn(async () => ({ ok: true })),
  open: vi.fn(), discard: vi.fn(), retry: vi.fn(), edit: vi.fn(), owner: { getSnapshot: () => mock.state } }))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => mock.owner }))
vi.mock('@/app/store', () => ({ useStoreSelector: (read: (state: unknown) => unknown) => {
  mock.selectors()
  if (mock.mode === 'pool') throw new Error('Legacy notice selector executed')
  return read(mock.state)
} }))
vi.mock('./notice-data-layer', async importOriginal => ({
  ...await importOriginal<typeof import('./notice-data-layer')>(), noticesDataLayer: () => mock.mode,
}))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPoolProjection: (read: (pool: unknown) => unknown) => read(mock.pool) }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: JSX.Element }) => render,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ui/dialog', () => Object.fromEntries(['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription'].map(name => [name, ({ children }: { children: ReactNode }) => <div>{children}</div>])))

let root: Root, container: HTMLDivElement
beforeEach(() => {
  const data = noticeFixture('selected-session')
  const catalog = { messages: data.messages.map(row => row.id), interactions: data.interactions.map(row => row.id), deadLetters: data.deadLetters.map(row => row.entry.mutationId) }
  mock.pool = { row: (entity: string, id: string) => {
    if (entity === 'noticeCatalog') return catalog
    if (entity === 'noticeSession') return { messages: catalog.messages, interactions: catalog.interactions }
    if (entity === 'messageRecord') return data.messages.find(row => row.id === id)
    if (entity === 'session') return data.sessions.find(row => row.sessionId === id)
    if (entity === 'pendingInteraction') return data.interactions.find(row => row.id === id)
    if (entity === 'outboxDeadLetter') return data.deadLetters.find(row => row.entry.mutationId === id)
  } }
  mock.state = { messageRecords: data.messages, sessions: data.sessions, pendingInteractions: data.interactions,
    outboxDeadLetters: data.deadLetters, trpc: { messages: { dismissNotice: { mutate: mock.dismiss } }, interactions: { answer: { mutate: mock.answer } } },
    openSessionTab: mock.open, recoverOutbox: { discard: mock.discard, retry: mock.retry, edit: mock.edit } }
  mock.mode = 'pool'
  for (const fn of [mock.selectors, mock.dismiss, mock.answer, mock.open, mock.discard, mock.retry, mock.edit]) fn.mockClear()
  noticeReadStats.enable(); noticeReadStats.reset()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); noticeReadStats.enable(false) })
const render = () => act(() => root.render(<><MessageNoticeIndicator /><PendingInteractionBar sessionId={'selected-session' as never} /><OutboxRecoveryIndicator /></>))
const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!
  expect(button).toBeTruthy()
  await act(async () => { button.click() })
}

it('uses zero legacy selectors and derivations and retains open, dismiss, answer and discard actions', async () => {
  render()
  await click('Open chat')
  await click('Dismiss')
  await click('I signed in — retry')
  await click('Discard')
  expect(mock.open).toHaveBeenCalledWith('missing-session')
  expect(mock.dismiss).toHaveBeenCalledWith({ id: 'notice-message-2' })
  expect(mock.answer).toHaveBeenCalledWith({ id: 'notice-ask-8', answer: { kind: 'login', outcome: 'completed' } })
  expect(mock.discard).toHaveBeenCalledWith('notice-mutation-0')
  expect(mock.selectors).not.toHaveBeenCalled()
  expect(noticeReadStats.read(mock.owner)).toEqual({})
})

it('retains recover and edited-send payloads on the existing mutation owner', async () => {
  render()
  const retry = container.querySelector('[data-testid="outbox-retry"]') as HTMLButtonElement
  await act(async () => retry.click())
  expect(mock.retry).toHaveBeenCalledWith('notice-mutation-1', { rightsFixed: true })
  await click('Edit')
  await click('Send updated')
  expect(mock.edit).toHaveBeenCalledWith('notice-mutation-0', { id: 'invisible-target', patch: { title: 'Synthetic authored 0' } })
  expect(mock.selectors).not.toHaveBeenCalled()
})

it('counts the legacy fallback as a positive control', () => {
  mock.mode = 'legacy'
  render()
  expect(mock.selectors.mock.calls.length).toBe(3)
  expect(noticeReadStats.read(mock.owner)).toMatchObject({ messageSelectors: 1, messageDerivations: 1, interactionSelectors: 1, interactionDerivations: 1, recoverySelectors: 1 })
})
