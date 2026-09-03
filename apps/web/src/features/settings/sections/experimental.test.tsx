import { DEFAULT_SETTINGS } from '@podium/runtime'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExperimentalSection } from './experimental'

vi.mock('@/lib/use-feature', () => ({
  useFeaturesState: () => ({
    devMode: false,
    channel: 'stable',
    flags: [
      {
        id: 'merge-queue',
        name: 'Queues',
        description: 'Show merge and heavy-test queues in the right sidebar.',
        visibility: 'edge',
        listed: true,
        enabled: false,
        source: 'default',
        locked: false,
      },
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
  it('presents the queue control and patches its durable feature key', () => {
    const patch = vi.fn()
    render(<ExperimentalSection settings={DEFAULT_SETTINGS} patch={patch} onReset={vi.fn()} />)

    const name = screen.getByText('Queues')
    expect(screen.getByText('Show merge and heavy-test queues in the right sidebar.')).toBeTruthy()

    const row = name.closest<HTMLDivElement>('.settings-row')
    expect(row).not.toBeNull()
    const toggle = within(row!).getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)

    expect(patch).toHaveBeenCalledWith({ experimental: { 'merge-queue': true } })
  })

  it('presents the stable runtime-driver control off and patches its durable feature key', () => {
    const patch = vi.fn()
    render(<ExperimentalSection settings={DEFAULT_SETTINGS} patch={patch} onReset={vi.fn()} />)

    expect(screen.getByText('Headless session drivers')).toBeTruthy()
    expect(
      screen.getByText(
        'Offer available headless runtime drivers when starting a session. Interactive CLI sessions remain the default.',
      ),
    ).toBeTruthy()

    const row = screen.getByText('Headless session drivers').closest<HTMLDivElement>('.settings-row')
    expect(row).not.toBeNull()
    const toggle = within(row!).getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)

    expect(patch).toHaveBeenCalledWith({ experimental: { 'runtime-drivers': true } })
  })
})
