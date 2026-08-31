import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// This lane does not run testing-library's auto-cleanup, so an earlier render
// stays in the document and the next query finds two cards instead of one.
afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))
// The offer's artifact strip mounts the artifact viewer, which imports the boot
// gate — a composition root this leaf lane cannot load. The strip itself is
// covered by OfferArtifactStrip.test.tsx; these tests are about the card.
vi.mock('./ArtifactViewer', () => ({ ArtifactViewer: () => null }))
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
  it('opens a URL in the body with the phone browser', async () => {
    const { Linking } = await import('react-native')
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(true)
    render(
      <SessionActionCard
        offer={{ ...offer, message: 'Preview is up\nOpen https://preview.example.com/login.' }}
        onAction={async () => {}}
      />,
    )

    const link = screen.getByText('https://preview.example.com/login')
    fireEvent.click(link)
    await waitFor(() => expect(openURL).toHaveBeenCalledWith('https://preview.example.com/login'))
    // The trailing period stays in the prose rather than riding along in the URL.
    expect(screen.getByTestId('session-action-card').textContent).toContain(
      'Open https://preview.example.com/login.',
    )
    openURL.mockRestore()
  })

  it('keeps direct and feedback actions executable in the session flow', async () => {
    const onAction = vi.fn(async () => {})
    render(<SessionActionCard offer={offer} onAction={onAction} />)

    expect(screen.getByTestId('session-action-card').textContent).toContain('Ready to merge')
    fireEvent.click(screen.getByLabelText('Merge'))
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('Merge it'))
    await waitFor(() =>
      expect(screen.getByLabelText('Send back').hasAttribute('disabled')).toBe(false),
    )

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

  it('dismisses the offer it was rendered for, naming that offer', async () => {
    const onDismiss = vi.fn(async () => {})
    render(
      <SessionActionCard offer={offer} onAction={vi.fn(async () => {})} onDismiss={onDismiss} />,
    )

    fireEvent.click(screen.getByLabelText('Dismiss offer'))
    // The stamp is the guard: a replacement posted between render and press must
    // survive, so the command names THIS offer rather than "whatever is standing".
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith(offer.createdAt))
  })

  it('keeps the offer and says so when the dismissal does not reach the server', async () => {
    const onDismiss = vi.fn(async () => {
      throw new Error('offline')
    })
    render(
      <SessionActionCard offer={offer} onAction={vi.fn(async () => {})} onDismiss={onDismiss} />,
    )

    fireEvent.click(screen.getByLabelText('Dismiss offer'))
    await waitFor(() =>
      expect(screen.getByTestId('session-action-card').textContent).toContain('Not dismissed'),
    )
    expect(screen.getByTestId('session-action-card').textContent).toContain('offline')
    // The control comes back rather than staying spent — the offer is still
    // standing on the server, so the operator must be able to try again.
    await waitFor(() =>
      expect(screen.getByLabelText('Dismiss offer').hasAttribute('disabled')).toBe(false),
    )
  })

  it('offers no dismissal on a host that cannot write', () => {
    render(<SessionActionCard offer={offer} onAction={vi.fn(async () => {})} />)

    expect(screen.queryByLabelText('Dismiss offer')).toBeNull()
  })
})
