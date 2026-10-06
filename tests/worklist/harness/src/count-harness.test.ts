/**
 * POD-4445 follow-up (coordinator): guard BOTH directions of `assertIsolation`.
 *
 * Every other use of this function in the tree asserts that it THROWS — the
 * legacy control's whole purpose is to fail the isolation budget. Nothing
 * asserted that it can PASS. That matters: if this function were ever changed
 * to throw unconditionally, every arm would "fail isolation", the comparison
 * would be broken, and not one existing test would notice, because they all
 * expect a throw.
 *
 * This epic has already been bitten by a one-directional guard once, in Stage 0,
 * where a fix had two mechanisms and removing the faster one left all 267 tests
 * green. A detector is only evidence if it can say both yes and no.
 */
import { expect, it } from 'vitest'
import { createElement } from 'react'
import {
  ancestorCount,
  assertCommits,
  assertIsolation,
  assertReads,
  burstReadBudget,
  clockTickReadBudget,
  evictKeeperReadBudget,
  newIssueReadBudget,
  parentReassignmentReadBudget,
  phaseChangeReadBudget,
  READ_BUDGETS,
  removeOneReadBudget,
  runCountScenario,
  type MountedArm,
} from './count-harness'
import type { RowView } from '@podium/client-graph/shared/row-view'
import { DISABLED_READ_FENCE } from '../../shared/src/instrument/reads'
import { createCommitLog } from '../../shared/src/row-shell'

const result = {
  scenario: 'assertIsolation-guard',
  methodology: 'unit',
  rowsCommitted: 3,
  commitsByRow: { a: 3 },
  stats: {},
  parity: true,
  parityDiff: null,
} as never

it('passes when the committed rows are within budget', () => {
  expect(() => assertIsolation(result, { rowsCommitted: 3 })).not.toThrow()
  expect(() => assertIsolation(result, { rowsCommitted: 99 })).not.toThrow()
})

it('throws when the committed rows exceed budget, naming the scenario', () => {
  expect(() => assertIsolation(result, { rowsCommitted: 2 })).toThrow(/assertIsolation-guard/)
})

// ------------------------------------------------------------------ POD-4557
// `assertReads`, both directions, plus the missing-cell rule: a result with no
// reads cell (fence disabled) must FAIL, never pass as "0 reads".

const withReads = (readsPerChange: number | null) =>
  ({
    scenario: 'assertReads-guard',
    methodology: 'unit',
    rowsCommitted: 1,
    readsPerChange,
    reads:
      readsPerChange === null
        ? null
        : {
            rows: readsPerChange,
            data: 0,
            byEntity: { session: readsPerChange },
            accesses: { get: 0, iterate: readsPerChange, relation: 0, field: 0, feed: 0 },
            sample: ['session:s0'],
          },
    commitsByRow: {},
    stats: {},
    parity: true,
    parityDiff: null,
  }) as never

it('assertReads passes when the reads are within budget', () => {
  expect(() => assertReads(withReads(3), { readsPerChange: 3 })).not.toThrow()
  expect(() => assertReads(withReads(0), { readsPerChange: 0 })).not.toThrow()
})

it('assertReads throws when the reads exceed budget, naming the scenario and the breakdown', () => {
  expect(() => assertReads(withReads(4), { readsPerChange: 3 })).toThrow(
    /assertReads-guard.*read 4 rows, budget 3.*byEntity=\{"session":4\}/,
  )
})

it('assertReads throws on a missing reads cell instead of passing it', () => {
  expect(() => assertReads(withReads(null), { readsPerChange: 99 })).toThrow(/no reads cell/)
})

it('budget helpers: phase change scales with the chain, never the family', () => {
  const parents: Record<string, string | null> = { a: 'b', b: 'c', c: null, x: 'y', y: 'x' }
  expect(ancestorCount('a', (id) => parents[id])).toBe(2)
  expect(ancestorCount('c', (id) => parents[id])).toBe(0)
  expect(ancestorCount('x', (id) => parents[id])).toBe(1)
  expect(phaseChangeReadBudget(0)).toBe(READ_BUDGETS.phaseChangePerLevel)
  expect(phaseChangeReadBudget(2)).toBe(3 * READ_BUDGETS.phaseChangePerLevel)
})

// POD-4609 — the #6–#10 budgets are the sums their derivations state
// (`docs/plans/pod-4441-harness.md`, "Reads per change"). A changed term
// changes a number here, where a reviewer sees it.
it('budget helpers: #6–#10 are the derived sums', () => {
  expect(READ_BUDGETS.placeOne).toBe(12)
  expect(newIssueReadBudget()).toBe(3 + 1 + 12)
  expect(removeOneReadBudget(0)).toBe(3 + 12)
  expect(removeOneReadBudget(2)).toBe(9 + 12)
  expect(evictKeeperReadBudget(1)).toBe(6 + 24)
  expect(parentReassignmentReadBudget(1, 0)).toBe(6 + 3 + 12)
  // A tick: #5's move per row it crosses. The plain tick crosses none.
  expect(clockTickReadBudget(0)).toBe(0)
  expect(clockTickReadBudget(4)).toBe(4 * 24)
  expect(READ_BUDGETS.markRead).toBe(3)
  // #3 corrected to the #9a shape (POD-4619): a click is a local plus a mark-read.
  expect(READ_BUDGETS.selectionClick).toBe(READ_BUDGETS.markRead)
  // Chains, not families: fifty roots cost 150, fifty depth-2 children 300.
  expect(burstReadBudget(Array.from({ length: 50 }, () => 0))).toBe(150)
  expect(burstReadBudget(Array.from({ length: 50 }, () => 1))).toBe(300)
})

// ------------------------------------------------------------------ POD-4563
// `assertCommits`, both directions (over and under), plus the missing cell.

const withCommits = (changed: string[] | null, drawn: string[] | null, remounted: string[] = []) =>
  ({
    scenario: 'assertCommits-guard',
    methodology: 'unit',
    rowsCommitted: drawn?.length ?? 0,
    oracleChangedRows: changed,
    drawnRows: drawn,
    remountedRows: remounted,
    commitsByRow: {},
    stats: {},
    parity: true,
    parityDiff: null,
  }) as never

it('assertCommits passes when the drawn rows equal the changed rows', () => {
  expect(() => assertCommits(withCommits(['a', 'b'], ['a', 'b']))).not.toThrow()
  expect(() => assertCommits(withCommits([], []))).not.toThrow()
})

it('assertCommits throws on an over-commit, naming the row', () => {
  expect(() => assertCommits(withCommits(['a'], ['a', 'x']))).toThrow(
    /assertCommits-guard.*over=\[x\] under=\[\]/,
  )
})

it('assertCommits throws on an under-commit (a changed row that did not redraw)', () => {
  expect(() => assertCommits(withCommits(['a', 'b'], ['a']))).toThrow(/over=\[\] under=\[b\]/)
})

it('assertCommits throws on a missing commit cell instead of passing it', () => {
  expect(() => assertCommits(withCommits(null, null))).toThrow(/no commit cell/)
})

it('complete row content detects a redraw and a missed redraw beyond the prototype fields', async () => {
  const snapshot = { rowsById: {}, order: { pinnedIds: [], groups: [] } }
  const log = createCommitLog()
  const mounted: MountedArm = {
    handle: {
      snapshot: () => snapshot,
      stats: { rowsDerived: 0, rollupsDerived: 0, indexUpdates: 0, notifications: 0, reset() {} },
      dispose() {}, mountWeb: () => () => {}, mountNative: () => createElement('div'),
    },
    log, reads: DISABLED_READ_FENCE, locals: null, work: false, unmount() {},
  }
  let color: string | null = null
  const row = { id: 'a' } as RowView
  const input = {
    scenario: 'complete-content', methodology: 'unit', expected: () => snapshot,
    views: () => ({ a: row }), content: () => ({ a: { color } }),
  }
  const changed = await runCountScenario(mounted, {
    ...input, apply() { color = 'blue'; log.record('a') },
  })
  expect(changed.oracleChangedRows).toEqual(['a'])
  expect(() => assertCommits(changed)).not.toThrow()
  const missed = await runCountScenario(mounted, {
    ...input, apply() { color = 'green' },
  })
  expect(() => assertCommits(missed)).toThrow(/over=\[\] under=\[a\]/)
  const unchanged = await runCountScenario(mounted, { ...input, apply() {} })
  expect(unchanged.oracleChangedRows).toEqual([])
  expect(() => assertCommits(unchanged)).not.toThrow()
  const publications: Readonly<Record<string, unknown>>[] = []
  const rolledBack = await runCountScenario(mounted, {
    ...input, contentDuring: () => publications,
    apply() {
      color = 'orange'
      publications.push(input.content())
      log.record('a')
      color = 'green'
      publications.push(input.content())
      log.record('a')
    },
  })
  expect(rolledBack.oracleChangedRows).toEqual(['a'])
  expect(rolledBack.rowsCommitted).toBe(2)
  expect(() => assertCommits(rolledBack)).not.toThrow()
})
