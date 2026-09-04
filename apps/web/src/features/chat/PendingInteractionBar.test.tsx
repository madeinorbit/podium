import type { PendingInteractionWire } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingInteractionBar } from './PendingInteractionBar'

// ---------------------------------------------------------------------------
// THE BLOCKED-SESSION BAR (POD-2414). §4 promises a blocking ask renders where
// a person is, and answering it from any surface resolves it everywhere. These
// tests hold the two halves the shell owns: it draws only while an ask is open,
// and pressing a button submits the viewmodel's TYPED answer through
// `interactions.answer` rather than a shape this file invented.
// ---------------------------------------------------------------------------

const answer = vi.fn(async () => ({ ok: true }))
const rows: PendingInteractionWire[] = []

vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (state: unknown) => unknown) =>
    select({ trpc: { interactions: { answer: { mutate: answer } } }, pendingInteractions: rows }),
}))

const login = (id: string): PendingInteractionWire =>
  ({
    id,
    sessionId: 'ses_1',
    kind: 'login',
    payload: { v: 1, provider: 'anthropic', reason: 'auth-expired' },
    askedAt: '2026-08-20T00:00:00.000Z',
    source: 'protocol',
    answerable: 'keystroke-emulated',
    status: 'asked',
    fingerprint: 'fp',
  }) as unknown as PendingInteractionWire

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  rows.length = 0
  answer.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = () => act(() => root.render(<PendingInteractionBar sessionId={'ses_1' as never} />))

describe('PendingInteractionBar', () => {
  it('draws nothing while no ask is open', () => {
    render()
    expect(container.textContent).toBe('')
  })

  it('renders a session-blocking ask a session has no other surface for', () => {
    rows.push(login('ixn_1'))
    render()
    expect(container.textContent).toContain('Sign-in needed')
    expect(container.textContent).toContain('anthropic')
    expect(container.querySelector('[data-testid="pending-interaction"]')).not.toBeNull()
  })

  it('submits the TYPED answer the viewmodel decided, never a string this file built', () => {
    rows.push(login('ixn_1'))
    render()
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="pending-interaction-action-completed"]',
    )
    act(() => {
      button?.click()
    })
    expect(answer).toHaveBeenCalledWith({
      id: 'ixn_1',
      answer: { kind: 'login', outcome: 'completed' },
    })
  })

  it('ignores another session’s ask', () => {
    rows.push({ ...login('ixn_other'), sessionId: 'ses_2' } as PendingInteractionWire)
    render()
    expect(container.textContent).toBe('')
  })

  it('leaves a readable question to the transcript’s own card', () => {
    // The generic bar must not draw a second, worse copy of the AskUserQuestion
    // card that is already in the feed.
    rows.push({
      ...login('ixn_q'),
      kind: 'question',
      payload: {
        v: 1,
        questions: [
          {
            question: 'Which database?',
            multiSelect: false,
            previewLayout: false,
            options: [{ label: 'Postgres' }],
          },
        ],
      },
    } as unknown as PendingInteractionWire)
    render()
    expect(container.textContent).toBe('')
  })
})
