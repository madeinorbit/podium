import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { FirstFlightsBadge } from './FirstFlightsBadge'
import { MemoryTipLog } from './memory-tip-log'
import { TipContext } from './tip-context'
import { TipEngine } from './tip-engine'

afterEach(cleanup)

it('offers Replay only for a seen moment whose first anchor is on screen', async () => {
  const log = new MemoryTipLog()
  log.record('first-send', 'finished')
  log.record('team-forms', 'finished')
  const engine = new TipEngine(log, (name) => name === 'on-screen')
  const card = (anchor: string) => ({ anchor, title: 'A tip', body: 'A pointer.' })
  engine.register('first-send', () => ({ active: false, cards: [card('on-screen')] }))
  // Registered, but its coordinator card is not on this view.
  engine.register('team-forms', () => ({ active: false, cards: [card('off-screen')] }))
  render(
    <TipContext.Provider value={engine}>
      <FirstFlightsBadge />
    </TipContext.Provider>,
  )
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /First flights/ }))
  })
  const row = (title: string) => screen.getByText(title).parentElement as HTMLElement
  const button = (title: string) => row(title).querySelector('button') as HTMLButtonElement
  expect(button('Your list and flight deck').textContent).toBe('Replay')
  expect(button('Your list and flight deck').disabled).toBe(false)
  expect(button('Working with a team').textContent).toBe('Return to this moment to replay')
  expect(button('Working with a team').disabled).toBe(true)
})
