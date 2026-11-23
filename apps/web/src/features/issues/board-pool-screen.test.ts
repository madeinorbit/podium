import { expect, it } from 'vitest'
import { issueBoardPoolScreen as screen } from './board-pool-screen'

it('always registers the board with the header source', () => {
  expect(screen).not.toHaveProperty('initialize')
  expect(screen).not.toHaveProperty('enabled')
  expect(screen.options?.({} as never)).toEqual({ header: true })
})
