import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { poolScreenCellsAt } from './pool-screen-work'
import allowances from './screen-work.expected-failures.json'
import { assertScreenWork, classifyScreenWork, screenWorkVerdicts } from './screen-work-ratios'

it('bounds retained header fleet and shell chrome readers at 1x/4x', async () => {
  const readers = new Set(['shell.chrome', 'header.fleet'])
  const at1x = await poolScreenCellsAt(1, undefined, readers)
  const at4x = await poolScreenCellsAt(4, undefined, readers)
  expect(at4x.readers).toEqual(at1x.readers)
  const verdicts = screenWorkVerdicts(at1x.cells, at4x.cells)
  const exceptions = allowances.flatMap(({ issue, readers }) =>
    readers.flatMap(({ reader, actions }) =>
      Object.entries(actions).flatMap(([action, kinds]) =>
        (kinds ?? []).map((kind: string) => ({ action, kind, reader, issue })),
      ),
    ),
  )
  const classified = classifyScreenWork(verdicts, exceptions)
  const directory = resolve('tests/worklist/harness/browser/results')
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'header-chrome-work.json'),
    JSON.stringify({ at1x, at4x, verdicts, ...classified }, null, 2) + '\n')
  console.info('[header/chrome growing readers]', JSON.stringify(classified.expectedFailures))
  assertScreenWork(classified.unexpected)
}, 7_200_000)
