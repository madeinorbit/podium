/**
 * A test's write scope (ADR 12 D9, POD-6592). A Ledger hands its scope mint out
 * once; a test that writes through one Ledger from several helpers needs the
 * same mint each time, so it is kept per Ledger here.
 */

import type { Ledger, LedgerWriter } from '../ledger'
import type { WriteScopeMint } from '../write-scope'

const mints = new WeakMap<Ledger, WriteScopeMint>()

/** The test mint of `ledger`, taken on first use. */
export function testScopeMint(ledger: Ledger): WriteScopeMint {
  let mint = mints.get(ledger)
  if (mint === undefined) {
    mint = ledger.takeScopeMint()
    mints.set(ledger, mint)
  }
  return mint
}

/** `ledger`'s writes under a system scope named `origin` (default `test`). */
export function testLedgerWriter(ledger: Ledger, origin = 'test'): LedgerWriter {
  return ledger.writer(testScopeMint(ledger).system(origin))
}
