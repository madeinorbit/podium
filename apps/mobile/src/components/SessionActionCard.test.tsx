import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))

const { composeOfferPrompt, SessionActionCard } = await import('./SessionActionCard')

const offer = {
  message: 'Ready to merge\nAll focused checks are green.',
  actions: [
    { label: 'Merge', prompt: 'Merge it' },
    { label: 'Send back', prompt: 'Address this feedback', input: true },
  ],
  createdAt: '2026-08-06T12:00:00.000Z',
}

describe('SessionActionCard', () => {
  it('keeps direct and feedback actions executable in the session flow', async () => {
    const onAction = vi.fn(async () => {})
    const onOpenEvidence = vi.fn()
    render(
      <SessionActionCard
        offer={offer}
        evidenceCount={2}
        onAction={onAction}
        onOpenEvidence={onOpenEvidence}
      />,
    )

    expect(screen.getByTestId('session-action-card').textContent).toContain('Ready to merge')
    fireEvent.click(screen.getByLabelText('Merge'))
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('Merge it'))
    await waitFor(() =>
      expect(screen.getByLabelText('Send back').hasAttribute('disabled')).toBe(false),
    )

    fireEvent.click(screen.getByLabelText('Open 2 offer artifacts'))
    expect(onOpenEvidence).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByLabelText('Send back'))
    fireEvent.change(screen.getByLabelText('Send back feedback'), {
      target: { value: 'Keep the route test.' },
    })
    fireEvent.click(screen.getByLabelText('Send back'))
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith(
        composeOfferPrompt('Address this feedback', 'Keep the route test.'),
      ),
    )
  })
})
