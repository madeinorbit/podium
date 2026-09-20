// POD-4420 S2 — selection out of the worklist derive.
//
// A/B evidence: a warm rotation of selection-only publishes. The legacy arm
// (selection as a declared derive input, placement inside derive) derives once
// per click and hands every read a fresh slice object; the fixed arm (baseline
// derive + memoized `placeWorklistSelection` post-pass) derives zero times and
// keeps one slice identity, while group contents and the selected row's
// placement stay identical in both arms. Counts, not milliseconds.
import { type IssueWire } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { Store } from '../../../engine/types'
import { readRuntimeStoreStats, storeStats } from '../../../perf/store-stats'
import { createSlicePublisher } from '../publish'
import { groupUnifiedWorkRows, splitPinnedWork } from './folds'
import {
  placeWorklistSelection,
  worklistSlice,
  type WorklistSelection,
  type WorklistSlice,
} from './published'

const NOW = Date.parse('2026-09-18T12:00:00.000Z')
const AT = new Date(NOW).toISOString()
// Settled long past the 24h finished grace: closed fold unless selected-open.
const OLD = new Date(NOW - 10 * 24 * 3_600_000).toISOString()
// Finished a second ago: open, awaiting tuck.
const FRESH = new Date(NOW - 1_000).toISOString()
const SOON = new Date(NOW + 3_600_000).toISOString()

function issue(id: string, repo: string, over: Partial<IssueWire> = {}): IssueWire {
  return {
    id,
    seq: 1,
    title: id,
    description: '',
    stage: 'in_progress',
    repoPath: `/repo-${repo}`,
    worktreePath: `/repo-${repo}`,
    branch: 'feature',
    parentBranch: 'main',
    createdAt: OLD,
    updatedAt: AT,
    archived: false,
    audience: 'human',
    origin: 'human',
    draft: false,
    pinned: false,
    needsHuman: false,
    blocked: false,
    ready: true,
    deps: [],
    dependents: [],
    labels: [],
    comments: [],
    blockedByNotes: [],
    ...over,
  } as IssueWire
}

function world(selectedIssueId: string | null): Store {
  return {
    repos: [
      { path: '/repo-a', kind: 'repository', branch: 'main', worktrees: [] },
      { path: '/repo-b', kind: 'repository', branch: 'main', worktrees: [] },
    ],
    machines: [],
    sessions: [],
    pins: { panels: [], worktrees: [], repos: [] },
    issues: [
      issue('a-live', 'a'),
      issue('b-live', 'b'),
      issue('a-old', 'a', {
        stage: 'done',
        closedReason: 'done',
        closedAt: OLD,
        updatedAt: OLD,
      }),
      issue('b-fresh', 'b', { stage: 'done', closedReason: 'done', closedAt: FRESH, updatedAt: FRESH }),
      issue('a-tucked', 'a', {
        stage: 'done',
        closedReason: 'done',
        closedAt: OLD,
        updatedAt: OLD,
        tuckedAt: AT,
      }),
      issue('b-gone', 'b', {
        stage: 'done',
        closedReason: 'cancelled',
        closedAt: OLD,
        updatedAt: OLD,
      }),
      issue('a-pinned', 'a', { pinned: true }),
      issue('s-snoozed', 'a', { deferUntil: SOON }),
    ],
    issueProjections: [],
    coarseNow: NOW,
    selectedIssueId,
  } as unknown as Store
}

function laneIds(rows: readonly { kind: string }[]): string[] {
  return rows.map((row) =>
    row.kind === 'issue'
      ? (row as { issue: { id: string } }).issue.id
      : `wt:${(row as { worktree: { path: string } }).worktree.path}`,
  )
}

/** Control dimension, asserted equal in both arms: group contents + placement. */
function structure(slice: WorklistSlice) {
  return {
    pinned: laneIds(slice.pinned),
    groups: slice.groups.map((group) => ({
      key: group.key,
      open: laneIds(group.rows),
      snoozed: laneIds(group.snoozedRows),
      closed: laneIds(group.closedRows),
    })),
  }
}

function laneOf(struct: ReturnType<typeof structure>, id: string): string {
  if (struct.pinned.includes(id)) return 'pinned'
  for (const group of struct.groups) {
    if (group.open.includes(id)) return `open:${group.key}`
    if (group.snoozed.includes(id)) return `snoozed:${group.key}`
    if (group.closed.includes(id)) return `closed:${group.key}`
  }
  return 'absent'
}

function sel(id: string | null, selectedIssueWasFolded = false): WorklistSelection {
  return { selectedIssueId: id as never, selectedIssueWasFolded }
}

// The pre-S2 contract: selection is a declared derive input and placement
// happens inside derive. Fails the zero-derives assertion by construction.
const legacySlice = {
  ...worklistSlice,
  sourceEqual: (a: Store, b: Store) =>
    a.coarseNow === b.coarseNow &&
    a.selectedIssueId === b.selectedIssueId &&
    a.repos === b.repos &&
    a.machines === b.machines &&
    a.sessions === b.sessions &&
    a.pins === b.pins &&
    a.issues === b.issues,
  derive: (store: Store) => {
    const base = worklistSlice.derive(store)
    const { rest } = splitPinnedWork(base.work)
    return {
      ...base,
      groups: groupUnifiedWorkRows(rest, store.selectedIssueId, false, store.coarseNow),
    }
  },
}

// Fourteen warm clicks: live rows, the settled latch row, tucked/cancelled
// stays, pinned, snoozed, cleared, and a selection pointing at a deleted row.
const CLICKS = [
  'a-live',
  'b-live',
  'a-old',
  'b-fresh',
  'a-tucked',
  'b-gone',
  'a-pinned',
  's-snoozed',
  null,
  'missing',
  'a-live',
  'a-old',
  'b-live',
  null,
] as const

afterEach(() => {
  storeStats.enable(false)
  storeStats.reset()
})

describe('POD-4420 S2 selection costs zero derivations', () => {
  it('A/B warm rotation: legacy derives per click, fixed derives zero, placement equal', () => {
    const perArm: Array<{
      legacy: boolean
      derives: number
      slices: WorklistSlice[]
      placed: WorklistSlice[]
      structs: ReturnType<typeof structure>[]
    }> = []
    for (const legacy of [true, false]) {
      const owner = {}
      storeStats.reset()
      storeStats.enable(true)
      let store = world(null)
      const definition = legacy ? legacySlice : worklistSlice
      const publisher = createSlicePublisher<Store>(() => store, owner)
      const slices: WorklistSlice[] = [publisher.read(definition)]
      const placed: WorklistSlice[] = [
        legacy ? slices[0]! : placeWorklistSelection(slices[0]!, sel(null)),
      ]
      for (const click of CLICKS) {
        store = { ...store, selectedIssueId: click as never }
        const base = publisher.read(definition)
        slices.push(base)
        placed.push(legacy ? base : placeWorklistSelection(base, sel(click)))
      }
      const stats = readRuntimeStoreStats(owner)
      perArm.push({
        legacy,
        derives: stats?.slices.worklist ?? -1,
        slices,
        placed,
        structs: placed.map(structure),
      })
      storeStats.enable(false)
    }
    const [before, after] = perArm as [typeof perArm[number], typeof perArm[number]]

    // BEFORE: one derive for the initial read plus one per click.
    expect(before.derives).toBe(1 + CLICKS.length)
    // AFTER: the initial read only — selection never re-derives.
    expect(after.derives).toBe(1)
    // The legacy arm FAILS the new assertion, so the counter is real evidence.
    expect(() => expect(before.derives - 1).toBe(0)).toThrow()
    expect(after.derives - 1).toBe(0)

    // Fresh slice objects per click before; one identity throughout after.
    expect(new Set(before.slices).size).toBe(before.slices.length)
    expect(new Set(after.slices).size).toBe(1)

    // CONTROL, asserted equal in both arms: identical group contents and
    // identical placement of the selected row on every click.
    expect(after.structs).toEqual(before.structs)
    CLICKS.forEach((click, index) => {
      if (click === null) return
      expect(laneOf(after.structs[index + 1]!, click)).toBe(
        laneOf(before.structs[index + 1]!, click),
      )
    })
    // The latch still holds: the settled row stays open while selected, and
    // folds back into its own group once focus moves on.
    expect(laneOf(after.structs[3]!, 'a-old')).toBe('open:/repo-a')
    expect(laneOf(after.structs[11]!, 'a-old')).toBe('open:/repo-a')
    expect(laneOf(after.structs[12]!, 'a-old')).toBe('closed:/repo-a')
    console.info(
      '[S2 selection A/B]',
      JSON.stringify({
        clicks: CLICKS.length,
        legacyDerives: before.derives,
        fixedDerives: after.derives,
      }),
    )
  })

  it('a material change still re-derives in the fixed arm (not doing less work)', () => {
    for (const legacy of [true, false]) {
      const owner = {}
      storeStats.reset()
      storeStats.enable(true)
      let store = world('a-live')
      const definition = legacy ? legacySlice : worklistSlice
      const publisher = createSlicePublisher<Store>(() => store, owner)
      const first = publisher.read(definition)
      expect(readRuntimeStoreStats(owner)?.slices.worklist).toBe(1)
      // The tuck press: new issues array, one row moved. A real movement, so
      // the fixed arm must derive exactly like the legacy arm.
      store = {
        ...store,
        issues: store.issues.map((row) =>
          row.id === 'b-fresh' ? { ...row, tuckedAt: AT } : row,
        ),
      }
      const second = publisher.read(definition)
      expect(readRuntimeStoreStats(owner)?.slices.worklist).toBe(2)
      const placed = legacy ? second : placeWorklistSelection(second, sel('a-live'))
      expect(laneOf(structure(placed), 'b-fresh')).toBe('closed:/repo-b')
      storeStats.enable(false)
    }
  })
})

describe('POD-4420 S2 post-pass placement oracle', () => {
  const base = worklistSlice.derive(world(null))
  const rest = splitPinnedWork(base.work).rest
  const legacyGroups = (selection: WorklistSelection) =>
    groupUnifiedWorkRows(
      rest,
      selection.selectedIssueId,
      selection.selectedIssueWasFolded ?? false,
      NOW,
    )

  const cases: Array<[string, WorklistSelection]> = [
    ['nothing selected', sel(null)],
    ['live row', sel('a-live')],
    ['settled closure stays open', sel('a-old')],
    ['fresh finish awaits tuck', sel('b-fresh')],
    ['tucked row stays folded', sel('a-tucked')],
    ['cancelled row stays folded', sel('b-gone')],
    ['pinned row', sel('a-pinned')],
    ['snoozed row', sel('s-snoozed')],
    ['deleted while selected', sel('missing')],
    ['latched folded click', sel('a-old', true)],
    ['latched live click', sel('a-live', true)],
  ]
  it.each(cases)('matches legacy grouping: %s', (_name, selection) => {
    const placed = placeWorklistSelection(base, selection)
    expect(structure(placed)).toEqual(structure({ ...base, groups: legacyGroups(selection) }))
  })

  it('returns the base identity whenever placement is unchanged', () => {
    expect(placeWorklistSelection(base, sel(null))).toBe(base)
    expect(placeWorklistSelection(base)).toBe(base)
    expect(placeWorklistSelection(base, sel('a-live'))).toBe(base)
    expect(placeWorklistSelection(base, sel('a-tucked'))).toBe(base)
    expect(placeWorklistSelection(base, sel('b-gone'))).toBe(base)
    expect(placeWorklistSelection(base, sel('missing'))).toBe(base)
    expect(placeWorklistSelection(base, sel('a-old', true))).toBe(base)
  })

  it('moves only the settled row, rebuilds only its group, never clones a row', () => {
    const placed = placeWorklistSelection(base, sel('a-old'))
    expect(placed).not.toBe(base)
    expect(laneOf(structure(placed), 'a-old')).toBe('open:/repo-a')
    const rows = new Set(base.work)
    for (const group of placed.groups) {
      for (const row of [...group.rows, ...group.snoozedRows, ...group.closedRows])
        expect(rows.has(row)).toBe(true)
    }
    const before = new Map(base.groups.map((group) => [group.key, group]))
    for (const group of placed.groups) {
      if (group.key !== '/repo-a') expect(group).toBe(before.get(group.key))
      else expect(group).not.toBe(before.get(group.key))
    }
    // Memoized: the same selection over the same base is one object.
    expect(placeWorklistSelection(base, sel('a-old'))).toBe(placed)
    expect(placeWorklistSelection(base, sel('b-live'))).toBe(base)
  })

  it('isEqual keeps identical outputs quiet and never equates different ones', () => {
    const isEqual = worklistSlice.isEqual!
    expect(isEqual(base, base)).toBe(true)
    expect(isEqual(base, { ...base })).toBe(true)
    expect(isEqual(base, { ...base, now: base.now + 1 })).toBe(false)
    expect(isEqual(base, { ...base, groups: [] })).toBe(false)
  })
})
