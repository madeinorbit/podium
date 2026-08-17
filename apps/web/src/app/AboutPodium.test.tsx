import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AboutPodium } from './AboutPodium'

afterEach(() => {
  cleanup()
})

describe('AboutPodium', () => {
  it('renders the app mark, the product name, what it is, and the slogan', () => {
    render(<AboutPodium open version="0.4.2" onClose={() => {}} />)

    const dialog = screen.getByRole('dialog', { name: 'Podium ADE' })
    expect(dialog).toBeTruthy()
    // The Dock icon, not the wordmark: the master under public/, so the mark
    // can never drift from the one macOS shows.
    expect(dialog.querySelector('img[src="/icon.svg"]')).toBeTruthy()
    expect(screen.getByText('Agentic Development Environment')).toBeTruthy()
    expect(screen.getByText('Ship more, better')).toBeTruthy()
    expect(screen.getByText('0.4.2')).toBeTruthy()
  })

  it('renders nothing interactive when closed', () => {
    render(<AboutPodium open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog', { name: 'Podium ADE' })).toBeNull()
  })
})
