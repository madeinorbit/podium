/**
 * POD-4547 (L1b) — the ordering and grouping keys against the slice spec's
 * worked example (`docs/plans/pod-4441-round-two-slice.md` §3.9) and each
 * R-ORDER / R-GROUP clause in isolation. The differential check against the
 * legacy sort and fold is `harness/src/oracle/row-view-legacy.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  compareClosedFold,
  compareRows,
  groupKeyOf,
  rankOf,
  sliceRowOf,
  type RowPlacement,
  type RowView,
} from './row-view'
import type { SliceLocals, SliceOrder } from './slice-types'

const NOW = Date.parse('2026-09-20T12:00:00Z')

function view(over: Partial<RowView> & Pick<RowView, 'id'>): RowView {
  return {
    displayRef: `#${over.seq ?? 1}`,
    title: over.id,
    phase: 'queued',
    progressDone: 0,
    progressTotal: 1,
    working: false,
    asking: false,
    band: 1,
    repoKey: 'r1',
    closed: false,
    selected: false,
    originTick: null,
    activityAt: 0,
    workingSince: null,
    pinned: false,
    sortKey: null,
    createdAt: '2026-09-01T00:00:00Z',
    seq: 1,
    foldAt: '2026-09-01T00:00:00Z',
    dismissed: false,
    ...over,
  }
}

/**
 * Test-local assembly of a `SliceOrder` from placements. Deliberately a
 * whole-list rebuild: the contract freezes the keys, not how a substrate
 * maintains the list incrementally.
 */
function orderOf(rows: readonly RowView[], locals: SliceLocals): SliceOrder {
  const placed = rows.map((row) => ({ row, at: groupKeyOf(row, locals) }))
  const pinnedIds = placed
    .filter((p) => p.at.section === 'pinned')
    .map((p) => p.row)
    .sort(compareRows)
    .map((r) => r.id)
  const groups: SliceOrder['groups'] = []
  const inGroup = (p: { at: RowPlacement }, key: string, lane: 'open' | 'closed') =>
    p.at.section === 'group' && p.at.repoKey === key && p.at.lane === lane
  for (const key of [...new Set(placed.flatMap((p) => (p.at.section === 'group' ? [p.at.repoKey] : [])))]) {
    groups.push({
      key,
      label: key,
      rowIds: placed.filter((p) => inGroup(p, key, 'open')).map((p) => p.row).sort(compareRows).map((r) => r.id),
      closedIds: placed
        .filter((p) => inGroup(p, key, 'closed'))
        .map((p) => p.row)
        .sort(compareClosedFold)
        .map((r) => r.id),
    })
  }
  return { pinnedIds, groups }
}

// §3.9: A and B band 1 with sortKeys a0 < b0. Creation stamps are chosen so
// newest-first alone would put B first — sortKey must be what decides.
const A = view({
  id: 'A',
  displayRef: 'POD-10',
  phase: 'waiting',
  working: true,
  asking: true,
  progressDone: 0,
  progressTotal: 1,
  sortKey: 'a0',
  seq: 10,
  createdAt: '2026-09-18T09:00:00Z',
  activityAt: Date.parse('2026-09-20T11:58:00Z'),
})
const B = view({
  id: 'B',
  displayRef: 'POD-9',
  phase: 'waiting',
  asking: true,
  sortKey: 'b0',
  seq: 9,
  createdAt: '2026-09-19T09:00:00Z',
})
const C = view({
  id: 'C',
  displayRef: 'POD-8',
  phase: 'done',
  sortKey: 'c0',
  seq: 8,
  closed: true,
  dismissed: true,
  foldAt: '2026-09-20T10:00:00Z',
})
const unselected: SliceLocals = { selectedIssueId: null, coarseNow: NOW }

describe('worked example (spec §3.9)', () => {
  it('orders A, B in group r1 and folds C, whatever the input order', () => {
    const expected: SliceOrder = {
      pinnedIds: [],
      groups: [{ key: 'r1', label: 'r1', rowIds: ['A', 'B'], closedIds: ['C'] }],
    }
    for (const input of [
      [A, B, C],
      [C, B, A],
      [B, C, A],
    ]) {
      expect(orderOf(input, unselected)).toEqual(expected)
    }
  })

  it('pinning A moves it out of the group into PINNED (move, not copy)', () => {
    const pinnedA = { ...A, pinned: true, band: 0 as const }
    expect(orderOf([pinnedA, B, C], unselected)).toEqual({
      pinnedIds: ['A'],
      groups: [{ key: 'r1', label: 'r1', rowIds: ['B'], closedIds: ['C'] }],
    })
  })

  it('projects back onto exactly the oracle SliceRow fields', () => {
    expect(Object.keys(sliceRowOf(A)).sort()).toEqual(
      [
        'asking',
        'band',
        'closed',
        'displayRef',
        'id',
        'phase',
        'progressDone',
        'progressTotal',
        'repoKey',
        'title',
        'working',
      ].sort(),
    )
    expect(sliceRowOf(A)).toMatchObject({ id: 'A', displayRef: 'POD-10', phase: 'waiting', band: 1 })
  })
})

describe('rank (spec R-ORDER)', () => {
  const sorted = (...rows: RowView[]) => [...rows].sort(compareRows).map((r) => r.id)

  it('band dominates the manual key', () => {
    const snoozed = view({ id: 's', band: 2, sortKey: 'a' })
    const middle = view({ id: 'm', band: 1, sortKey: 'z' })
    const top = view({ id: 't', band: 0, sortKey: 'zz' })
    expect(sorted(snoozed, middle, top)).toEqual(['t', 'm', 's'])
  })

  it('keyed rows sort before unkeyed; an empty key counts as unkeyed', () => {
    const newestUnkeyed = view({ id: 'u', sortKey: null, createdAt: '2026-09-30T00:00:00Z' })
    const empty = view({ id: 'e', sortKey: '', createdAt: '2026-09-29T00:00:00Z' })
    const keyed = view({ id: 'k', sortKey: 'm', createdAt: '2026-01-01T00:00:00Z' })
    expect(sorted(newestUnkeyed, empty, keyed)).toEqual(['k', 'u', 'e'])
  })

  it('manual keys compare by code unit, as legacy `<` does', () => {
    expect(sorted(view({ id: 'lower', sortKey: 'a' }), view({ id: 'upper', sortKey: 'B' }))).toEqual([
      'upper',
      'lower',
    ])
  })

  it('creation order is newest first, then seq desc, then id asc', () => {
    const t = '2026-09-10T00:00:00Z'
    expect(
      sorted(
        view({ id: 'old', createdAt: '2026-09-01T00:00:00Z', seq: 99 }),
        view({ id: 'z', createdAt: t, seq: 5 }),
        view({ id: 'a', createdAt: t, seq: 5 }),
        view({ id: 'hi', createdAt: t, seq: 6 }),
      ),
    ).toEqual(['hi', 'a', 'z', 'old'])
  })

  it('an unparseable createdAt ranks as epoch 0, as legacy', () => {
    expect(rankOf(view({ id: 'x', createdAt: 'not a date' })).createdMs).toBe(0)
  })

  it('does not move while agents work: activity, phase and timers never enter the rank', () => {
    const idle = view({ id: 'x', sortKey: 'k', seq: 3 })
    const busy = {
      ...idle,
      phase: 'working' as const,
      working: true,
      asking: true,
      activityAt: NOW,
      workingSince: NOW - 5_000,
      progressDone: 1,
      title: 'renamed',
      selected: true,
    }
    expect(rankOf(busy)).toEqual(rankOf(idle))
  })
})

describe('closed fold order (spec R-GROUP step 3)', () => {
  it('newest foldAt first; ties fall back to rank', () => {
    const older = view({ id: 'o', foldAt: '2026-09-19T00:00:00Z' })
    const newer = view({ id: 'n', foldAt: '2026-09-20T00:00:00Z' })
    const tieLowKey = view({ id: 't1', foldAt: '2026-09-18T00:00:00Z', sortKey: 'a' })
    const tieHighKey = view({ id: 't2', foldAt: '2026-09-18T00:00:00Z', sortKey: 'b' })
    expect([older, tieHighKey, newer, tieLowKey].sort(compareClosedFold).map((r) => r.id)).toEqual([
      'n',
      'o',
      't1',
      't2',
    ])
  })
})

describe('group key (spec R-GROUP)', () => {
  const graceFolded = view({ id: 'g', closed: true, dismissed: false })
  const tucked = view({ id: 't', closed: true, dismissed: true })

  it('buckets by repoKey; snoozed rows stay in the open lane', () => {
    expect(groupKeyOf(view({ id: 'x', repoKey: 'r2', band: 2 }), unselected)).toEqual({
      section: 'group',
      repoKey: 'r2',
      lane: 'open',
    })
  })

  it('a pinned row is pinned even when closed (the PINNED section has no fold)', () => {
    expect(groupKeyOf({ ...tucked, pinned: true }, unselected)).toEqual({ section: 'pinned' })
  })

  it('latch: a selected grace-folded row stays open until focus moves', () => {
    const selected = { ...graceFolded, selected: true }
    expect(groupKeyOf(graceFolded, unselected)).toMatchObject({ lane: 'closed' })
    expect(groupKeyOf(selected, { selectedIssueWasFolded: false })).toMatchObject({ lane: 'open' })
    expect(groupKeyOf(selected, {})).toMatchObject({ lane: 'open' })
    expect(groupKeyOf(selected, { selectedIssueWasFolded: true })).toMatchObject({ lane: 'closed' })
  })

  it('latch never holds open an operator dismissal (abandoned or tucked)', () => {
    expect(groupKeyOf({ ...tucked, selected: true }, { selectedIssueWasFolded: false })).toMatchObject({
      lane: 'closed',
    })
  })

  it('latch never folds an open row', () => {
    expect(groupKeyOf(view({ id: 'o', selected: true }), { selectedIssueWasFolded: true })).toMatchObject({
      lane: 'open',
    })
  })

  it('reads no clock and no selected id: those arrive already folded into the view', () => {
    const a = groupKeyOf(graceFolded, { selectedIssueId: 'g', coarseNow: 0 } as SliceLocals)
    const b = groupKeyOf(graceFolded, { selectedIssueId: null, coarseNow: NOW } as SliceLocals)
    expect(a).toEqual(b)
  })
})
