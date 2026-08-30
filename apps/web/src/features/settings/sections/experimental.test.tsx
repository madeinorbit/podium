import { DEFAULT_SETTINGS } from '@podium/runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExperimentalSection } from './experimental'

vi.mock('@/lib/use-feature', () => ({
  useFeaturesState: () => ({
    devMode: false,
    channel: 'stable',
    flags: [
      {
        id: 'runtime-drivers',
        name: 'Headless session drivers',
        description:
          'Offer available headless runtime drivers when starting a session. Interactive CLI sessions remain the default.',
        visibility: 'stable',
        listed: true,
        enabled: false,
        source: 'default',
        locked: false,
      },
    ],
  }),
}))

afterEach(cleanup)

describe('ExperimentalSection', () => {
  it('presents the stable runtime-driver control off and patches its durable feature key', () => {
    const patch = vi.fn()
    render(<ExperimentalSection settings={DEFAULT_SETTINGS} patch={patch} onReset={vi.fn()} />)

    expect(screen.getByText('Headless session drivers')).toBeTruthy()
    expect(
      screen.getByText(
        'Offer available headless runtime drivers when starting a session. Interactive CLI sessions remain the default.',
      ),
    ).toBeTruthy()

    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)

    expect(patch).toHaveBeenCalledWith({ experimental: { 'runtime-drivers': true } })
  })
})
