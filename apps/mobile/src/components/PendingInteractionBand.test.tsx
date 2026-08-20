import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// THE BLOCKED-SESSION BAND (POD-2414) — the phone's half of "every blocking ask
// renders in the web UI, the Tray, mobile, and any attached CLI". What is
// pinned here is what the SHELL owns: draw only while an ask is open, and
// submit the viewmodel's typed answer through `interactions.answer`.
// ---------------------------------------------------------------------------

// This lane does not run testing-library's auto-cleanup.
afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))

const answer = vi.fn(async () => ({ ok: true }))
// Loosely typed on purpose: the mobile lane resolves `@podium/protocol` to its
// built output, and this file only needs rows the band can read.
const rows: Record<string, unknown>[] = []

vi.mock('@podium/client-core/react', () => ({
  useStoreSelector: (select: (state: unknown) => unknown) =>
    select({ trpc: { interactions: { answer: { mutate: answer } } }, pendingInteractions: rows }),
}))

const { PendingInteractionBand } = await import('./PendingInteractionBand')

const recovery = (): Record<string, unknown> => ({
  id: 'ixn_1',
  sessionId: 'ses_1',
  kind: 'recovery',
  payload: {
    v: 1,
    reason: 'context-overflow',
    prompt: 'The turn outgrew the context window.',
    offered: ['full-resume', 'abandon'],
  },
  askedAt: '2026-08-20T00:00:00.000Z',
  source: 'protocol',
  answerable: 'keystroke-emulated',
  status: 'asked',
  fingerprint: 'fp',
})

beforeEach(() => {
  rows.length = 0
  answer.mockClear()
})

describe('PendingInteractionBand', () => {
  it('draws nothing while no ask is open', () => {
    const { container } = render(<PendingInteractionBand sessionId={'ses_1' as never} />)
    expect(container.textContent).toBe('')
  })

  it('renders a failure-blocked session and only the choices it can perform', () => {
    rows.push(recovery())
    render(<PendingInteractionBand sessionId={'ses_1' as never} />)
    expect(screen.getByTestId('pending-interaction')).toBeTruthy()
    expect(screen.getByText('The turn outgrew the context window.')).toBeTruthy()
    expect(screen.getByTestId('pending-interaction-action-full-resume')).toBeTruthy()
    // `abandon` is offered by the harness but has no answer path — its one
    // delivery route woke the session it claimed to stop — so the card must not
    // draw a button for it (POD-2414 review).
    expect(screen.queryByTestId('pending-interaction-action-abandon')).toBeNull()
  })

  it('submits the typed answer, not a label', async () => {
    rows.push(recovery())
    render(<PendingInteractionBand sessionId={'ses_1' as never} />)
    fireEvent.click(screen.getByTestId('pending-interaction-action-full-resume'))
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith({
        id: 'ixn_1',
        answer: { kind: 'recovery', choice: 'full-resume' },
      }),
    )
  })

  it('shows a refusal instead of pretending the answer landed', async () => {
    rows.push(recovery())
    answer.mockResolvedValueOnce({ ok: false, reason: 'already-answered' } as never)
    render(<PendingInteractionBand sessionId={'ses_1' as never} />)
    fireEvent.click(screen.getByTestId('pending-interaction-action-full-resume'))
    await waitFor(() => expect(screen.getByText('already-answered')).toBeTruthy())
  })

  it('ignores another session’s ask', () => {
    rows.push({ ...recovery(), sessionId: 'ses_2' })
    const { container } = render(<PendingInteractionBand sessionId={'ses_1' as never} />)
    expect(container.textContent).toBe('')
  })
})
