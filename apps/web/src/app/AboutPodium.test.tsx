import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AboutPodium } from './AboutPodium'

afterEach(() => {
  cleanup()
})

describe('AboutPodium', () => {
  it('renders the wordmark, version, and purpose when open', () => {
    render(<AboutPodium open version="0.4.2" onClose={() => {}} />)

    expect(screen.getByRole('dialog', { name: 'About Podium ADE' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Podium' })).toBeTruthy()
    expect(screen.getByText('0.4.2')).toBeTruthy()
    expect(screen.getByText('Mission control for coding agents.')).toBeTruthy()
  })

  it('renders nothing interactive when closed', () => {
    render(<AboutPodium open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog', { name: 'About Podium ADE' })).toBeNull()
  })
})
