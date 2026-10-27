import { expect, it } from 'vitest'
import { poolScreenCellsAt } from './pool-screen-work'

it('bounds the real automations target heartbeat in the structural corpus', async () => {
  const readers = new Set(['automations'])
  const one = await poolScreenCellsAt(1, undefined, readers, ['heartbeat'])
  const four = await poolScreenCellsAt(4, undefined, readers, ['heartbeat'])
  console.info('[automation census heartbeat]', JSON.stringify({ one, four }))
  expect(one.cells).toHaveLength(1)
  expect(four.cells).toHaveLength(1)
  const work = (run: typeof one) => Object.entries(run.cells[0]!.work.elementsBy)
    .filter(([name]) => name.startsWith('consumer:automations/automations.'))
    .reduce((total, [, count]) => total + count, 0)
  expect(work(four)).toBeLessThanOrEqual(work(one))
}, 1_200_000)
