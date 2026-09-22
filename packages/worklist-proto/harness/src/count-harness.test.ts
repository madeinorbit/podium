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
import {
  ancestorCount,
  assertCommits,
  assertIsolation,
  assertReads,
  phaseChangeReadBudget,
  READ_BUDGETS,
} from './count-harness'

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
            byEntity: { session: readsPerChange },
            accesses: { get: 0, iterate: readsPerChange, relation: 0, field: 0 },
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
  expect(() => assertCommits(withCommits(['a'], ['a', 'x']))).toThrow(/assertCommits-guard.*over=\[x\] under=\[\]/)
})

it('assertCommits throws on an under-commit (a changed row that did not redraw)', () => {
  expect(() => assertCommits(withCommits(['a', 'b'], ['a']))).toThrow(/over=\[\] under=\[b\]/)
})

it('assertCommits throws on a missing commit cell instead of passing it', () => {
  expect(() => assertCommits(withCommits(null, null))).toThrow(/no commit cell/)
})
