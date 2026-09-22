/**
 * POD-4563 (L6a) — the row-view oracle agrees with the parity oracle on every
 * `SliceRow` field, and its extra fields are live on the fixture corpus (a
 * field that is null on every row cannot tell the commit fence anything).
 */
import { describe, expect, it } from 'vitest'
import { sliceRowOf } from '../../../shared/src/row-view'
import type { SliceLocals } from '../../../shared/src/slice-types'
import { buildCorpus, FIXED_NOW, type FixtureCorpus } from '../fixture/index'
import { expectedSnapshot, projectRowViews, runLegacyDerivation } from './index'

const LOCALS: SliceLocals = { selectedIssueId: null, coarseNow: FIXED_NOW }

function viewsOf(corpus: FixtureCorpus, locals: SliceLocals = LOCALS) {
  return projectRowViews(runLegacyDerivation(corpus, locals), locals)
}

describe('row-view oracle', () => {
  it('has one view per visible row, and its SliceRow half IS the parity oracle row', () => {
    const corpus = buildCorpus(1)
    const views = viewsOf(corpus)
    const snapshot = expectedSnapshot(corpus, LOCALS)
    expect(Object.keys(views).sort()).toEqual(Object.keys(snapshot.rowsById).sort())
    for (const [id, view] of Object.entries(views)) {
      expect(sliceRowOf(view), id).toEqual(snapshot.rowsById[id])
    }
  })

  it('carries live origin ticks, working stamps and recency on the corpus', () => {
    const views = Object.values(viewsOf(buildCorpus(1)))
    const ticks = views.filter((view) => view.originTick !== null)
    const working = views.filter((view) => view.workingSince !== null)
    console.info(`[row-views] 1x: ${views.length} rows, ${ticks.length} origin ticks, ${working.length} working stamps`)
    expect(ticks.length).toBeGreaterThan(0)
    expect(working.length).toBeGreaterThan(0)
    // A working stamp only on a row that reads working (own seats ⊆ subtree).
    for (const view of working) expect(view.working, view.id).toBe(true)
    expect(views.every((view) => view.activityAt > 0)).toBe(true)
  })

  it('selection flips exactly the selected row', () => {
    const corpus = buildCorpus(1)
    const before = viewsOf(corpus)
    const id = Object.keys(before)[3] as string
    const after = viewsOf(corpus, { ...LOCALS, selectedIssueId: id })
    const changed = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    expect(changed).toEqual([id])
    expect(after[id]?.selected).toBe(true)
  })

  it("renaming a spin-off's origin changes the spin-off's view (the #4 tick, reached through the edge)", () => {
    const corpus = buildCorpus(1)
    const before = viewsOf(corpus)
    const spinOff = Object.values(before).find((view) => view.originTick !== null)
    const originId = spinOff?.originTick?.id as string
    const rename = <T extends { id: string; title?: string }>(row: T): T =>
      row.id === originId ? { ...row, title: 'Renamed origin' } : row
    const renamed: FixtureCorpus = {
      ...corpus,
      issues: corpus.issues.map(rename),
      issueProjections: corpus.issueProjections.map(rename),
    }
    const after = viewsOf(renamed)
    expect(after[spinOff?.id as string]?.originTick?.title).toBe('Renamed origin')
  })
})
