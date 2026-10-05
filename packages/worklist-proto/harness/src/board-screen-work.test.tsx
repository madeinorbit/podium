import { expect, it } from 'vitest'
import { poolScreenCellsAt } from './pool-screen-work'
import { assertScreenWork, screenWorkVerdicts } from './screen-work-ratios'

it('keeps every board row, derivation and collection-element counter flat for scripted clicks and deltas', async () => {
  const readers = new Set(['board.catalog', 'board.query', 'board.card', 'board.model', 'board.explorer'])
  const at1x = await poolScreenCellsAt(1, undefined, readers)
  const at4x = await poolScreenCellsAt(4, undefined, readers)
  expect(at1x.readers.map(reader => reader.name).sort()).toEqual([...readers].sort())
  expect(at4x.readers).toEqual(at1x.readers)
  expect(at4x.corpus.issues).toBeGreaterThan(at1x.corpus.issues * 3)
  const verdicts = screenWorkVerdicts(at1x.cells, at4x.cells)
  // Counts from the independent meter include IDs traversed inside column
  // and layout bodies, not only the number of times those bodies execute.
  assertScreenWork(verdicts)
  expect(verdicts.some(value => value.reader.includes('board.card') && value.at1x > 0)).toBe(true)
  for (const run of [at1x, at4x]) {
    for (const cell of run.cells) {
      for (const counts of [cell.work.rowsBy!, cell.work.derivationsBy, cell.work.elementsBy!]) {
        expect(Object.entries(counts).filter(([name]) => name.includes('board.catalog'))).toEqual([])
      }
    }
  }
  console.info('[board work]', JSON.stringify(verdicts.filter(value =>
    ['stage-change', 'heartbeat', 'lane-change'].includes(value.action) &&
    (value.reader.includes('IssueBoard.columnIds') || value.reader.includes('IssueBoard.layout')))))
}, 600_000)
