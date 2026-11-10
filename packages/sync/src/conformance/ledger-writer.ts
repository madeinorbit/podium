/**
 * A test's write scope (ADR 12 D9, POD-6592). A Ledger hands its scope mint out
 * once; a test that writes through one Ledger from several helpers needs the
 * same mint each time, so it is kept per Ledger here.
 */

import type { Authority } from '../authority/authority'
import type { EntityChangeSpec, Ledger, LedgerWriter } from '../ledger'
import { type WriteScope, WriteScopeIssuer, type WriteScopeMint } from '../write-scope'

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

/**
 * A scope for a STORE-LEVEL fixture that writes a synced table directly, with no
 * Ledger in the test (ADR 12 D9, POD-6594). A repository does not read the scope;
 * requiring one is how its writers say they belong inside a commit. A test that
 * seeds rows below that layer says so by taking this.
 */
export function fixtureWriteScope(): WriteScope {
  return fixtureIssuer.takeMint().system('test.fixture')
}

const fixtureIssuer = {
  takeMint: () => new WriteScopeIssuer().takeMint(),
}

/**
 * A commit-only writer for a SERVICE unit test with no Ledger (POD-6594): it runs
 * the commit's write with {@link fixtureWriteScope}, hands the declared changes to
 * `onChanges`, then runs `apply`. Nothing is deduplicated or sequenced.
 */
export function fixtureCommitWriter(
  onChanges?: (specs: EntityChangeSpec[]) => void | Promise<void>,
): Pick<LedgerWriter, 'commit'> {
  return {
    commit: async (op) => {
      const result = await op.write(fixtureWriteScope())
      const specs = (await op.changes?.(result)) ?? []
      await onChanges?.(specs)
      op.apply?.(result, [])
      return { result, changes: [] }
    },
  }
}

/**
 * A commit-only writer straight over an Authority, for a SERVICE test with no
 * Ledger whose kind compares at save (POD-6769): the commit's named records,
 * its write (run with {@link fixtureWriteScope}) and its declared changes go to
 * `authority.commit`, so the Authority builds the records around the write as
 * production does. The test gives that Authority its `records`.
 */
export function authorityCommitWriter(
  authority: Pick<Authority, 'commit'>,
): Pick<LedgerWriter, 'commit'> {
  return {
    commit: async (op) => {
      const declare = op.changes
      const outcome = await authority.commit({
        ...(op.affects === undefined
          ? {}
          : { affects: op.affects.map(({ id, ...rest }) => ({ ...rest, entityId: id })) }),
        write: async () => await op.write(fixtureWriteScope()),
        ...(declare === undefined
          ? {}
          : {
              changes: async (result) =>
                (await declare(result)).map(({ id, ...rest }) => ({ ...rest, entityId: id })),
            }),
      })
      if (outcome.outcome !== 'committed') throw new Error(`rejected: ${outcome.reason}`)
      op.apply?.(outcome.result, [])
      return { result: outcome.result, changes: [] }
    },
  }
}
