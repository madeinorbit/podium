/**
 * POD-4547 (L1b) — differential check of the row view's ordering and grouping
 * keys against the LEGACY sort and fold, over the live-shaped fixture corpus.
 *
 * For every visible legacy row we fill a `RowView`'s placement fields by their
 * documented rules (`shared/src/row-view.ts`), from legacy primitives, then
 * assemble the order with `compareRows` / `compareClosedFold` / `groupKeyOf`
 * and require it to equal the oracle's `SliceOrder` exactly. The latch is
 * checked row by row against `rowInClosedFold` under every selection state.
 *
 * ARMED. Each comparison has a sensitivity control that drops one clause
 * (manual key, latch) and asserts the result then DISAGREES with legacy on the
 * same corpus — a differential that cannot fail proves nothing.
 */
import { rowInClosedFold, type UnifiedIssueRow, type UnifiedWorkRow } from '@podium/client-core/viewmodels'
import { describe, expect, it } from 'vitest'
import {
  compareClosedFold,
  compareRank,
  compareRows,
  groupKeyOf,
  rankOf,
  type RowView,
} from '@podium/client-graph/shared/row-view'
import type { SliceLocals, SliceOrder } from '@podium/client-graph/shared/slice-types'
import { buildCorpus, FIXED_NOW, type FixtureCorpus } from '../fixture/index'
import { projectRowViews, projectSnapshot, runLegacyDerivation } from './index'

const HOUR = 3_600_000

function flatten(rows: UnifiedWorkRow[]): UnifiedIssueRow[] {
  const out: UnifiedIssueRow[] = []
  const visit = (row: UnifiedWorkRow): void => {
    if (row.kind !== 'issue') return
    out.push(row)
    for (const child of row.startedByChildren ?? []) visit(child)
  }
  for (const row of rows) visit(row)
  return out
}

interface Case {
  locals: SliceLocals
  legacy: UnifiedIssueRow[]
  views: RowView[]
  expected: SliceOrder
}

/**
 * The shared corpus keys only a few child issues, none of them visible, so it
 * never exercises R-ORDER step 2 (the ARMED control below proved it). Give
 * every third issue a manual key from a small alphabet — collisions keep the
 * creation tie-break live, and keys run against creation order — on both the
 * wire row and its projection, before legacy derives. A test input, not a
 * fixture change.
 */
function withManualKeys(corpus: FixtureCorpus): FixtureCorpus {
  const keyOf = new Map<string, string>()
  corpus.issues.forEach((issue, i) => {
    if (i % 3 === 0) keyOf.set(issue.id, `k${(7 - (i % 7)) % 5}`)
  })
  const key = <T extends { id: string }>(row: T): T =>
    keyOf.has(row.id) ? { ...row, sortKey: keyOf.get(row.id) } : row
  return { ...corpus, issues: corpus.issues.map(key), issueProjections: corpus.issueProjections.map(key) }
}

function buildCase(coarseNow: number, seed = 4443): Case {
  const corpus = withManualKeys(buildCorpus(1, seed))
  const locals: SliceLocals = { selectedIssueId: null, coarseNow }
  const derivation = runLegacyDerivation(corpus, locals)
  const snapshot = projectSnapshot(derivation, locals)
  const legacy = flatten(derivation.slice.work)
  // POD-4563: the views are the row-view oracle's, field for field.
  const byId = projectRowViews(derivation, locals)
  const views = legacy.map((row): RowView => {
    const view = byId[row.issue.id]
    if (view === undefined) throw new Error(`no oracle row for ${row.issue.id}`)
    return view
  })
  return { locals, legacy, views, expected: snapshot.order }
}

/** Order from placements. Groups appear in the rank order of their first member. */
function orderOf(
  views: readonly RowView[],
  locals: SliceLocals,
  compare: (a: RowView, b: RowView) => number = compareRows,
): Omit<SliceOrder, 'groups'> & { groups: { key: string; rowIds: string[]; closedIds: string[] }[] } {
  const ranked = [...views].sort(compare)
  const pinnedIds: string[] = []
  const groups = new Map<string, { key: string; open: RowView[]; closed: RowView[] }>()
  for (const view of ranked) {
    const at = groupKeyOf(view, locals)
    if (at.section === 'pinned') {
      pinnedIds.push(view.id)
      continue
    }
    let group = groups.get(at.repoKey)
    if (group === undefined) {
      group = { key: at.repoKey, open: [], closed: [] }
      groups.set(at.repoKey, group)
    }
    group[at.lane].push(view)
  }
  return {
    pinnedIds,
    groups: [...groups.values()].map((g) => ({
      key: g.key,
      rowIds: g.open.map((v) => v.id),
      closedIds: [...g.closed].sort(compareClosedFold).map((v) => v.id),
    })),
  }
}

const withoutLabels = (order: SliceOrder) => ({
  pinnedIds: order.pinnedIds,
  groups: order.groups.map(({ key, rowIds, closedIds }) => ({ key, rowIds, closedIds })),
})

// FIXED_NOW, then later clocks so defer lapses (band crossings) and the 24 h
// finished grace (closed-fold crossings) actually happen inside the corpus.
const CLOCKS = [FIXED_NOW, FIXED_NOW + 25 * HOUR, FIXED_NOW + 8 * 24 * HOUR]

describe('row view keys vs the legacy sort and fold', () => {
  it.each(CLOCKS)('assembles exactly the oracle order at coarseNow %i', (coarseNow) => {
    const c = buildCase(coarseNow)
    expect(c.views.length).toBeGreaterThan(150)
    expect(c.views.filter((v) => v.sortKey !== null).length).toBeGreaterThan(20)
    expect(orderOf(c.views, c.locals)).toEqual(withoutLabels(c.expected))
  })

  it('agrees on a second seed', () => {
    const c = buildCase(FIXED_NOW, 7)
    expect(orderOf(c.views, c.locals)).toEqual(withoutLabels(c.expected))
  })

  it('ARMED: dropping the manual key disagrees with legacy on this corpus', () => {
    const c = buildCase(FIXED_NOW)
    const noManualKey = (a: RowView, b: RowView) =>
      compareRank({ ...rankOf(a), unkeyed: 0, sortKey: '' }, { ...rankOf(b), unkeyed: 0, sortKey: '' })
    expect(orderOf(c.views, c.locals, noManualKey)).not.toEqual(withoutLabels(c.expected))
  })

  it('matches rowInClosedFold row by row under every selection and latch state', () => {
    let graceFolded = 0
    let dismissed = 0
    let latchMatters = 0
    for (const coarseNow of CLOCKS) {
      const c = buildCase(coarseNow)
      c.legacy.forEach((row, i) => {
        const view = c.views[i] as RowView
        if (view.pinned) return
        if (view.closed && !view.dismissed) graceFolded += 1
        if (view.dismissed) dismissed += 1
        for (const selected of [false, true]) {
          for (const wasFolded of [false, true]) {
            const legacyClosed = rowInClosedFold(row, selected ? row.issue.id : null, wasFolded, coarseNow)
            const at = groupKeyOf({ ...view, selected }, { selectedIssueWasFolded: wasFolded })
            expect(at, `${row.issue.id} selected=${selected} wasFolded=${wasFolded}`).toEqual({
              section: 'group',
              repoKey: view.repoKey,
              lane: legacyClosed ? 'closed' : 'open',
            })
            if (legacyClosed !== view.closed) latchMatters += 1
          }
        }
      })
    }
    // ARMED: the corpus exercises both fold kinds, and at least one row where
    // ignoring the latch (lane = row.closed) would disagree with legacy.
    expect(graceFolded).toBeGreaterThan(0)
    expect(dismissed).toBeGreaterThan(0)
    expect(latchMatters).toBeGreaterThan(0)
  })
})
