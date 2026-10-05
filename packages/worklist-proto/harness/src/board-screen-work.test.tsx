import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { poolScreenCellsAt } from './pool-screen-work'
import screenWorkExceptions from './screen-work.expected-failures.json'
import { assertScreenWork, classifyScreenWork, screenWorkVerdicts } from './screen-work-ratios'

it('keeps every board row, derivation and collection-element counter flat for scripted clicks and deltas', async () => {
  // Retain every app reader so shared derivations have the same owners as
  // the full structural lane, including Explorer and launcher consumers.
  const at1x = await poolScreenCellsAt(1)
  const at4x = await poolScreenCellsAt(4)
  expect(at4x.readers).toEqual(at1x.readers)
  expect(at4x.corpus.issues).toBeGreaterThan(at1x.corpus.issues * 3)
  const verdicts = screenWorkVerdicts(at1x.cells, at4x.cells)
  const exceptions = screenWorkExceptions.flatMap(({ issue, readers }) =>
    readers.flatMap(({ reader, actions }) => Object.entries(actions).flatMap(([action, kinds]) =>
      (kinds ?? []).map((kind: string) => ({ action, kind, reader, issue })))))
  const classified = classifyScreenWork(verdicts, exceptions)
  writeFileSync(new URL('../browser/results/work-board-screens.json', import.meta.url),
    JSON.stringify({ at1x, at4x, verdicts, ...classified }, null, 2) + '\n')
  console.info('[board work] existing failures', JSON.stringify(classified.expectedFailures))
  // Counts from the independent meter include IDs traversed inside column
  // and layout bodies, not only the number of times those bodies execute.
  assertScreenWork(classified.unexpected)
  for (const value of verdicts) {
    if (value.reader.includes('IssueBoard.columnIds') || value.reader.includes('IssueBoard.layout'))
      expect(value.passed, JSON.stringify(value)).toBe(true)
  }
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
