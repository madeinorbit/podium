// @vitest-environment happy-dom
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { poolScreenCellsAt } from './pool-screen-work'

it('one heartbeat stays within twice the work at four times the corpus', async () => {
  const at1x = await poolScreenCellsAt(1, undefined, undefined, ['heartbeat'])
  const at4x = await poolScreenCellsAt(4, undefined, undefined, ['heartbeat'])
  const directory = resolve('results')
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'heartbeat-work.json'), JSON.stringify({ at1x, at4x }, null, 2) + '\n')
  expect(at4x.readers).toEqual(at1x.readers)
  for (const kind of ['rows', 'derivations', 'elements', 'visits'] as const) {
    const one = at1x.cells[0]!.work[kind] ?? 0
    const four = at4x.cells[0]!.work[kind] ?? 0
    console.info(`[heartbeat work] ${kind}: ${one} → ${four}`)
    expect(four, kind).toBeLessThanOrEqual(2 * one)
  }
}, 1_800_000)
