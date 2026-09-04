/**
 * THE LEDGER-TAIL AUDIT, RUN AGAINST THIS CHECKOUT [POD-3366].
 *
 * The script's own `--probe` proves each check can say YES and stay quiet on a
 * clean fixture, and the gate runs it first. What this file adds is the half a
 * probe cannot cover: that the audit is GREEN on the tree as it stands, so the
 * roster stops describing this checkout the moment somebody adds a commit site
 * — inside the test suite, not only in a lint somebody has to remember to run.
 */

import { describe, expect, it } from 'vitest'
import { auditLedgerCommitTail, commitSiteCount, restatedCommitOp, rowMapReadOnly } from './audit-ledger-commit-tail'

describe('the ledger-tail audit', () => {
  it('is green on this checkout', () => {
    // Named findings rather than a count, so a failure says WHICH claim broke.
    expect(auditLedgerCommitTail().map((f) => `${f.check} ${f.where}`)).toEqual([])
  })

  it('counts a commit site the way the roster does', () => {
    expect(commitSiteCount('a.commit({ x })\nb.commit({ y })')).toBe(2)
    expect(commitSiteCount('a.commit(op)')).toBe(0)
  })

  it('refuses a writable issue row getter', () => {
    // The compile-time half of POD-3366: widening this back restores the wrong
    // shape at every reader with no test failing, which is why it is pinned.
    expect(
      rowMapReadOnly('  get rows(): Map<string, IssueRow> {', 'f.ts').map((f) => f.check),
    ).toEqual(['issue-rows-readonly'])
    expect(rowMapReadOnly('  get rows(): ReadonlyMap<string, IssueRow> {', 'f.ts')).toEqual([])
  })

  it('refuses a hand-restated commit op but allows a deliberate Omit', () => {
    expect(
      restatedCommitOp('commit<T>(op: { write: () => T; changes: () => S[] }): R', 'f.ts').map(
        (f) => f.check,
      ),
    ).toEqual(['one-commit-op'])
    expect(restatedCommitOp("commit<T>(op: Omit<LedgerCommitOp<T>, 'apply'>): R", 'f.ts')).toEqual([])
  })
})
