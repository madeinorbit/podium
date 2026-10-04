import { expect, it } from 'vitest'
import { issueBoardPoolScreen as screen } from './board-pool-screen'

it('always registers the board and its declared cold fields', () => {
  expect(screen).not.toHaveProperty('initialize')
  expect(screen).not.toHaveProperty('enabled')
  expect(screen.options?.({} as never)).toMatchObject({
    summaries: { issue: expect.arrayContaining(['description', 'priority']) },
  })
})
