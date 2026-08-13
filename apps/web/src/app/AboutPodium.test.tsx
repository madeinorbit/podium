import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AboutPodium } from './AboutPodium'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AboutPodium', () => {
  it('renders the wordmark, version, and purpose when open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ appVersion: '0.4.2' }),
      })),
    )

    render(<AboutPodium open httpOrigin="http://podium.test" onClose={() => {}} />)

    expect(screen.getByRole('dialog', { name: 'About Podium' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Podium' })).toBeTruthy()
    await waitFor(() => expect(screen.getByText('0.4.2')).toBeTruthy())
    expect(screen.getByText('Mission control for coding agents.')).toBeTruthy()
  })

  it('renders nothing interactive when closed', () => {
    render(<AboutPodium open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog', { name: 'About Podium' })).toBeNull()
  })
})
