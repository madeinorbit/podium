import { describe, expect, it } from 'vitest'
import { groupUnifiedWorkRows, splitPinnedWork } from '../viewmodels/slices/worklist/folds'
import { sortUnifiedWorkRows } from '../viewmodels/slices/worklist/row-order'
import type { UnifiedWorkRow } from '../viewmodels/slices/worklist/row-types'
import { SIDEBAR_FINISHED_GRACE_MS } from '../viewmodels/slices/worklist/visibility'
import type { IssueNavigationModel } from '../viewmodels/slices/issues'
import {
  createWorklistStructure,
  rowDisplayOf,
  stableRowId,
  type WorklistSelection,
} from './worklist-structure'

const NOW = Date.parse('2026-09-18T12:00:00Z')
const iso = (deltaMs: number) => new Date(NOW + deltaMs).toISOString()

function issue(id: string, repo: string, extra: Partial<IssueNavigationModel> = {}): IssueNavigationModel {
  return {
    id: id as never, seq: Number(id.replace(/\D/g, '') || 1), title: id, stage: 'in_progress',
    audience: 'human', repoPath: `/r/${repo}`, repoId: `repo-${repo}` as never,
    createdAt: iso(-7200_000), updatedAt: iso(-3600_000),
    ...extra,
  } as IssueNavigationModel
}

function row(id: string, repo: string, extra: Partial<IssueNavigationModel> = {}): UnifiedWorkRow {
  const it = issue(id, repo, extra)
  return { kind: 'issue', issue: it, sessions: [], activityAt: Date.parse(it.updatedAt) || 0 }
}

const laneIds = (rows: readonly UnifiedWorkRow[]) => rows.map(stableRowId)
const structureOf = (placed: ReturnType<ReturnType<typeof createWorklistStructure>['place']>) => ({
  pinned: laneIds(placed.pinned),
  groups: placed.groups.map(g => ({
    key: g.key, open: laneIds(g.rows), snoozed: laneIds(g.snoozedRows), closed: laneIds(g.closedRows),
  })),
})

function fixture() {
  return [
    row('a1', 'a'),
    row('a2', 'a', { stage: 'planning' }),
    row('b1', 'b'),
    row('s1', 'a', { deferUntil: iso(3600_000) }),
    // Settled closure, finished long ago: closed fold from the start.
    row('c1', 'a', { stage: 'done', closedReason: 'done', closedAt: iso(-2 * SIDEBAR_FINISHED_GRACE_MS), updatedAt: iso(-2 * SIDEBAR_FINISHED_GRACE_MS) }),
    // Freshly finished: open, awaiting tuck.
    row('c2', 'b', { stage: 'done', closedReason: 'done', closedAt: iso(-1000), updatedAt: iso(-1000) }),
    row('p1', 'b', { pinned: true }),
  ]
}

/** Legacy arm: the REAL whole-world split + grouping. It always allocates every group. */
const legacy = {
  groupCalls: 0,
  place(rows: readonly UnifiedWorkRow[], selection: WorklistSelection, now: number) {
    this.groupCalls++
    const { rest } = splitPinnedWork([...rows])
    return groupUnifiedWorkRows(rest, selection.selectedIssueId as never, selection.selectedIssueWasFolded ?? false, now)
  },
}

function budgetNoRegen(stats: { groupsRegenerated: number }) {
  expect(stats.groupsRegenerated).toBe(0)
}

describe('worklist structure rows/selection split', () => {
  it('matches legacy grouping, and a pure selection change regenerates no groups while legacy rebuilds all', () => {
    const struct = createWorklistStructure()
    struct.updateTime(NOW)
    const rows = sortUnifiedWorkRows(fixture(), NOW)
    const first = struct.place(rows)
    expect(structureOf(first)).toEqual(structureOf({
      pinned: first.pinned,
      groups: legacy.place(rows, { selectedIssueId: null }, NOW),
    }))
    const before = struct.stats()
    const selected: WorklistSelection = { selectedIssueId: 'c2' as never, selectedIssueWasFolded: false }
    const second = struct.place(rows, selected)
    // The open finished row stays open under selection (the latch); nothing regenerates.
    expect(laneIds(second.groups.flatMap(g => g.rows))).toContain('issue:c2')
    const delta = struct.stats().groupsRegenerated - before.groupsRegenerated
    expect(delta).toBe(0)
    expect(second.groups.map(g => g.key)).toEqual(first.groups.map(g => g.key))
    for (let i = 0; i < first.groups.length; i += 1) expect(second.groups[i]).toBe(first.groups[i])
    // Legacy arm FAILS the same budget: every group object is rebuilt.
    const legacyFirst = legacy.place(rows, { selectedIssueId: null }, NOW)
    const legacySecond = legacy.place(rows, selected, NOW)
    expect(() => {
      let regenerated = 0
      for (let i = 0; i < legacyFirst.length; i += 1) if (legacyFirst[i] !== legacySecond[i]) regenerated++
      budgetNoRegen({ groupsRegenerated: regenerated })
    }).toThrow()
    // Control dimension asserted equal in both arms: same lanes, same order.
    expect(structureOf(second)).toEqual(structureOf({ pinned: second.pinned, groups: legacySecond }))
    console.info('[E4 selection A/B]', JSON.stringify({
      pilotGroupsRegenerated: delta, legacyGroupsRegenerated: legacyFirst.length,
      equalGroups: legacySecond.length, negativeControl: 'legacy fails zero-regen budget',
    }))
  })

  it('keeps the selected open closure in its lane until focus moves, then folds it in its own group only', () => {
    const struct = createWorklistStructure()
    struct.updateTime(NOW)
    // c3 finished past grace but currently selected-open: the latch holds it open.
    const rows = sortUnifiedWorkRows([
      ...fixture(),
      row('c3', 'a', { stage: 'done', closedReason: 'done', closedAt: iso(-2 * SIDEBAR_FINISHED_GRACE_MS), updatedAt: iso(-2 * SIDEBAR_FINISHED_GRACE_MS) }),
    ], NOW)
    const open = struct.place(rows, { selectedIssueId: 'c3' as never, selectedIssueWasFolded: false })
    expect(laneIds(open.groups.flatMap(g => g.rows))).toContain('issue:c3')
    const before = struct.stats()
    const moved = struct.place(rows, { selectedIssueId: 'a1' as never, selectedIssueWasFolded: false })
    expect(laneIds(moved.groups.flatMap(g => g.rows))).not.toContain('issue:c3')
    expect(laneIds(moved.groups.flatMap(g => g.closedRows))).toContain('issue:c3')
    const regen = struct.stats().groupsRegenerated - before.groupsRegenerated
    expect(regen).toBe(1)
    const groupA = moved.groups.find(g => g.key === 'repo-a')!
    const groupB = moved.groups.find(g => g.key === 'repo-b')!
    expect(groupB).toBe(open.groups.find(g => g.key === 'repo-b')!)
    expect(groupA).not.toBe(open.groups.find(g => g.key === 'repo-a')!)
    expect(structureOf(moved)).toEqual(structureOf({
      pinned: moved.pinned,
      groups: legacy.place(rows, { selectedIssueId: 'a1' as never, selectedIssueWasFolded: false }, NOW),
    }))
  })

  it('regenerates no groups for a display-only title change, and only the owning group for pin/defer/tuck moves', () => {
    const struct = createWorklistStructure()
    struct.updateTime(NOW)
    let rows = sortUnifiedWorkRows(fixture(), NOW)
    const first = struct.place(rows)
    // Display-only: rename. Title is read only by rowDisplayOf, never placement.
    const renamed: UnifiedWorkRow[] = rows.map(r =>
      r.kind === 'issue' && r.issue.id === 'a1'
        ? { ...r, issue: { ...r.issue, title: 'Renamed' } }
        : r)
    expect(rowDisplayOf(renamed.find(r => stableRowId(r) === 'issue:a1')!).title).toBe('Renamed')
    const before = struct.stats()
    const second = struct.place(renamed)
    expect(struct.stats().groupsRegenerated - before.groupsRegenerated).toBe(0)
    for (let i = 0; i < first.groups.length; i += 1) expect(second.groups[i]).toBe(first.groups[i])
    expect(structureOf(second)).toEqual(structureOf({
      pinned: second.pinned,
      groups: legacy.place(renamed, { selectedIssueId: null }, NOW),
    }))

    // Pin moves a2 out of group A into the pinned section: only group A regenerates.
    rows = sortUnifiedWorkRows(renamed.map((r): UnifiedWorkRow =>
      r.kind === 'issue' && r.issue.id === 'a2' ? { ...r, issue: { ...r.issue, pinned: true } } : r), NOW)
    const pinned = struct.place(rows)
    expect(laneIds(pinned.pinned)).toContain('issue:a2')
    expect(pinned.groups.find(g => g.key === 'repo-b')).toBe(second.groups.find(g => g.key === 'repo-b'))
    expect(pinned.groups.find(g => g.key === 'repo-a')).not.toBe(second.groups.find(g => g.key === 'repo-a'))
    expect(structureOf(pinned)).toEqual(structureOf({
      pinned: pinned.pinned,
      groups: legacy.place(rows, { selectedIssueId: null }, NOW),
    }))

    // Snooze b1: only group B regenerates, and the row lands in its snoozed fold.
    rows = sortUnifiedWorkRows(rows.map((r): UnifiedWorkRow =>
      r.kind === 'issue' && r.issue.id === 'b1' ? { ...r, issue: { ...r.issue, deferUntil: iso(3600_000) } } : r), NOW)
    const snoozed = struct.place(rows)
    expect(laneIds(snoozed.groups.find(g => g.key === 'repo-b')!.snoozedRows)).toContain('issue:b1')
    expect(snoozed.groups.find(g => g.key === 'repo-a')).toBe(pinned.groups.find(g => g.key === 'repo-a'))

    // Tuck c2: only group B regenerates, into the closed fold.
    rows = rows.map((r): UnifiedWorkRow =>
      r.kind === 'issue' && r.issue.id === 'c2' ? { ...r, issue: { ...r.issue, tuckedAt: iso(0) } } : r)
    const tucked = struct.place(rows)
    expect(laneIds(tucked.groups.find(g => g.key === 'repo-b')!.closedRows)).toContain('issue:c2')
    expect(tucked.groups.find(g => g.key === 'repo-a')).toBe(snoozed.groups.find(g => g.key === 'repo-a'))
    expect(structureOf(tucked)).toEqual(structureOf({
      pinned: tucked.pinned,
      groups: legacy.place(rows, { selectedIssueId: null }, NOW),
    }))
  })

  it('pins band/manual/closed ordering and snooze/grace boundary-time behaviour', () => {
    const struct = createWorklistStructure()
    struct.updateTime(NOW)
    // Manual order: sortKey ascending beats creation-desc among keyed rows.
    const ordered = sortUnifiedWorkRows([
      row('m1', 'a', { sortKey: 'b', createdAt: iso(-9000_000) }),
      row('m2', 'a', { sortKey: 'a', createdAt: iso(-1000) }),
      row('m3', 'a', { createdAt: iso(-100) }),
    ], NOW)
    expect(ordered.map(r => (r as { issue: IssueNavigationModel }).issue.id)).toEqual(['m2', 'm1', 'm3'])
    // Closed fold: newest tuck/finish first, measured per-group sort.
    const cOld = row('cOld', 'a', { stage: 'done', closedReason: 'done', closedAt: iso(-3 * SIDEBAR_FINISHED_GRACE_MS), updatedAt: iso(-3 * SIDEBAR_FINISHED_GRACE_MS) })
    const cNew = row('cNew', 'a', { stage: 'done', closedReason: 'done', closedAt: iso(-2 * SIDEBAR_FINISHED_GRACE_MS), updatedAt: iso(-2 * SIDEBAR_FINISHED_GRACE_MS) })
    const placed = struct.place(sortUnifiedWorkRows([cOld, cNew, row('live', 'a')], NOW))
    const groupA = placed.groups.find(g => g.key === 'repo-a')!
    expect(laneIds(groupA.closedRows)).toEqual(['issue:cNew', 'issue:cOld'])
    expect(struct.stats().closedSorts).toBe(1)

    // Snooze boundary: deferUntil == now is NOT deferred; it is returned (band 0).
    const at = row('edge', 'a', { deferUntil: iso(0) })
    expect(struct.placementInputs(at)).toEqual({ deferred: false, returned: true, band: 0 })
    expect(struct.placementInputs(row('future', 'a', { deferUntil: iso(1) }))).toMatchObject({ deferred: true, band: 2 })
    // Grace boundary: exactly GRACE still awaits tuck; 1ms later it folds.
    const anchor = NOW - SIDEBAR_FINISHED_GRACE_MS
    const mk = (finishIso: string) => row('g', 'a', { stage: 'done', closedReason: 'done', closedAt: finishIso, updatedAt: finishIso })
    const atGrace = struct.place([mk(new Date(anchor).toISOString())])
    expect(atGrace.groups[0]!.rows.length).toBe(1)
    const pastGrace = struct.place([mk(new Date(anchor - 1).toISOString())])
    expect(pastGrace.groups[0]!.rows.length).toBe(0)
    expect(laneIds(pastGrace.groups[0]!.closedRows)).toEqual(['issue:g'])
  })

  it('advances a quiet snooze only from explicit time and rejects bad inputs', () => {
    const struct = createWorklistStructure()
    struct.updateTime(NOW)
    const rows = [row('s', 'a', { deferUntil: iso(60_000) })]
    const first = struct.place(rows)
    expect(laneIds(first.groups[0]!.snoozedRows)).toEqual(['issue:s'])
    // No clock read inside place: re-placing without updateTime keeps the fold.
    const frozen = struct.place(rows)
    expect(frozen.groups[0]).toBe(first.groups[0])
    struct.updateTime(NOW + 60_000)
    const lapsed = struct.place(rows)
    expect(laneIds(lapsed.groups[0]!.snoozedRows)).toEqual([])
    expect(laneIds(lapsed.groups[0]!.rows)).toEqual(['issue:s'])
    expect(() => struct.updateTime(NaN)).toThrow()
    expect(() => createWorklistStructure().place(rows)).toThrow()
  })
})
