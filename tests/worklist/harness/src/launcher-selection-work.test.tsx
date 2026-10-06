// @vitest-environment happy-dom
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { poolScreenCellsAt } from './pool-screen-work'

it('keeps selected-child palette metadata within one addressed neighbourhood', async () => {
  const readers = new Set(['sidebar.sections', 'sidebar.row', 'launcher.palette'])
  const at1x = await poolScreenCellsAt(1, undefined, readers, ['select'])
  const at4x = await poolScreenCellsAt(4, undefined, readers, ['select'])
  const samples = [at1x, at4x].map(run => {
    const work = run.cells[0]!.work
    const count = (values: Record<string, number> | undefined, suffix: string) =>
      Object.entries(values ?? {}).filter(([key]) => key.includes('launcher.palette/') && key.includes(`guard-child.${suffix}`))
        .reduce((sum, [, value]) => sum + value, 0)
    return { scale: run.scale, corpus: run.corpus,
      loaded: { rows: count(work.rowsBy, 'loaded'), derivations: count(work.derivationsBy, 'loaded'), elements: count(work.elementsBy, 'loaded') },
      displayRef: { elements: count(work.elementsBy, 'displayRef') },
    }
  })
  mkdirSync('.artifacts/launcher-selection', { recursive: true })
  writeFileSync('.artifacts/launcher-selection/work.json', JSON.stringify({ samples, at1x, at4x }, null, 2))
  console.info('[palette selected-child bounds]', JSON.stringify(samples))
  for (const sample of samples) {
    expect(sample.loaded.rows).toBeLessThanOrEqual(2)
    expect(sample.loaded.derivations).toBeLessThanOrEqual(1)
    expect(sample.loaded.elements).toBeLessThanOrEqual(2)
    expect(sample.displayRef.elements).toBeLessThanOrEqual(1)
  }
}, 1_800_000)
