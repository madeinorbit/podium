/**
 * The engine parameter of the statement pins [POD-6980]. Database-free: the pin
 * reports a fixed count through its own `count` seam.
 */

import { describe, expect, it } from 'vitest'
import { expectConstantStatements, pinnedCountFor, type StatementPin } from './statement-count'

function pinRunning(statements: number): StatementPin<null> {
  return {
    name: 'fixed operation',
    setup: async () => null,
    target: () => ({}),
    count: async (_fixture, run) => ({ result: await run(), statements, byQuery: new Map() }),
    run: () => undefined,
  }
}

describe('statement pins on two engines', () => {
  it('a plain count pins both engines', async () => {
    await expectConstantStatements(pinRunning(3), 3, 'sqlite')
    await expectConstantStatements(pinRunning(3), 3, 'pg')
  })

  it('a per-engine count pins each engine to its own number', async () => {
    const expected = { sqlite: 3, pg: 4, reason: 'the design differs here' }
    await expectConstantStatements(pinRunning(3), expected, 'sqlite')
    await expectConstantStatements(pinRunning(4), expected, 'pg')
    await expect(expectConstantStatements(pinRunning(4), expected, 'sqlite')).rejects.toThrow(
      /^fixed operation: pinned at 3 statements, ran 4/,
    )
    await expect(expectConstantStatements(pinRunning(3), expected, 'pg')).rejects.toThrow(
      /^fixed operation \[pg\]: pinned at 4 statements, ran 3/,
    )
  })

  it('a per-engine count without a reason is refused', () => {
    expect(() => pinnedCountFor({ sqlite: 1, pg: 2, reason: ' ' }, 'pg')).toThrow(/say why/)
  })
})
