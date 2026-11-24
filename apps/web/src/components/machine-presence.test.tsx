import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MachinePresenceDot, MachinePresenceText } from './machine-presence'

afterEach(cleanup)

it.each([
  [{ online: true, onlineKnown: true }, 'Online', 'bg-success'],
  [{ online: false, onlineKnown: false }, 'Reconnecting', 'bg-muted-foreground/50'],
  [{ online: false, onlineKnown: true }, 'Offline', 'bg-destructive'],
] as const)('renders %s with a distinct indicator and last-seen policy', (reading, label, tone) => {
  const machine = { ...reading, lastSeenAt: '2026-11-20T12:00:00Z' }
  const { container } = render(
    <>
      <MachinePresenceDot machine={machine} />
      <MachinePresenceText machine={machine} />
    </>,
  )
  expect(screen.getByTitle(label).className).toContain(tone)
  expect(container.textContent).toContain(label)
  expect(container.textContent?.includes('Last seen')).toBe(label !== 'Online')
})

it('calls an initial missing reading reconnecting without inventing a last-seen date', () => {
  const { container } = render(
    <MachinePresenceText machine={{ online: false, onlineKnown: false }} />,
  )
  expect(container.textContent).toBe('Reconnecting')
})
