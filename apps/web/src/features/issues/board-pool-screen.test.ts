import { expect, it } from 'vitest'
import { issueBoardPoolScreen as screen } from './board-pool-screen'

it('always registers the board and its declared cold fields', () => {
  expect(screen.initialize).toBeUndefined()
  expect(screen.enabled).toBeUndefined()
  expect(screen.options?.({} as never)).toMatchObject({ summaries: { issue: expect.arrayContaining(['description', 'priority']) } })
})
