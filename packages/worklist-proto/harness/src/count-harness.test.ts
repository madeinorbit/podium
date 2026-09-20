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
import { assertIsolation } from './count-harness'

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
