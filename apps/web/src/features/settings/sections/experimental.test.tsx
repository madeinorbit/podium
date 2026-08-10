import { DEFAULT_SETTINGS } from '@podium/runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExperimentalSection } from './experimental'

vi.mock('@/lib/use-feature', () => ({
  useFeaturesState: () => ({
    devMode: false,
    channel: 'edge',
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
    ],
  }),
}))

afterEach(cleanup)

describe('ExperimentalSection', () => {
  it('presents the queue control and patches its durable feature key', () => {
    const patch = vi.fn()
    render(<ExperimentalSection settings={DEFAULT_SETTINGS} patch={patch} onReset={vi.fn()} />)

    expect(screen.getByText('Queues')).toBeTruthy()
    expect(screen.getByText('Show merge and heavy-test queues in the right sidebar.')).toBeTruthy()

    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)

    expect(patch).toHaveBeenCalledWith({ experimental: { 'merge-queue': true } })
  })
})
