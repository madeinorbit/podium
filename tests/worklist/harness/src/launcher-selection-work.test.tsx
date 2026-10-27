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
      displayRef: { derivations: count(work.derivationsBy, 'displayRef'), elements: count(work.elementsBy, 'displayRef') },
    }
  })
  mkdirSync('.artifacts/launcher-selection', { recursive: true })
  writeFileSync('.artifacts/launcher-selection/work.json', JSON.stringify({ samples, at1x, at4x }, null, 2))
  console.info('[palette selected-child bounds]', JSON.stringify(samples))
  for (const sample of samples) {
    expect(sample.loaded).toEqual({ rows: 0, derivations: 0, elements: 0 })
    expect(sample.displayRef).toEqual({ derivations: 0, elements: 0 })
  }
}, 1_800_000)
