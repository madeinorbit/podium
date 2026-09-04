import { type MatrixRow, OWNERSHIP_MATRIX } from '@podium/model'
import { Ledger } from '@podium/sync'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from './store'
import { applyAfterCommit, spanOpen } from './store/executor/synchronous-span'
import { openTestStore } from './test-support/open-test-store'

/**
 * `Ledger.commit`'s `apply` ARM — one slot that owns "after it is durable"
 * [POD-3366, spec §3.3 mechanism 1].
 *
 * WHAT IT REPLACES. Thirteen of twenty-two audited `ledger.commit` call sites
 * installed something into process-owned memory on the statement AFTER the
 * call returned. That statement is on the success path of a possibly-nested
 * commit, and a nested `ledger.commit` is a SAVEPOINT: its release is not a
 * commit, so the install recorded a fact the enclosing span could still throw
 * away. The arm removes the region those installs were written in.
 *
 * WHAT THESE TESTS ASSERT ON. The arm's own mechanism — did the step run, and
 * WHEN — observed through a probe list written by the step itself. Nothing here
 * reloads a store or re-derives a projection between the rollback and the
 * assertion: a fixture that re-reads the database would report the database's
 * answer and hide the memory this arm exists to protect.
 */
describe("Ledger.commit's apply arm runs on the outermost commit (POD-3366)", () => {
  const conversationRow = (id: string) => ({
    id,
    agentKind: 'claude-code' as const,
    providerId: 'p',
  })

  function makeLedger(store: SessionStore): Ledger {
    return new Ledger({
      repo: store.sync,
      now: () => 1_000,
      transact: (fn) => store.transact(fn),
      applyCommit: { spanOpen, onCommit: applyAfterCommit },
    })
  }

  const upsert = (id: string) => ({
    entity: 'conversation' as const,
    id,
    op: 'upsert' as const,
    value: conversationRow(id),
  })

  it('runs inline, before commit() returns, when no span is open', async () => {
    const store = await openTestStore(':memory:')
    const ledger = makeLedger(store)
    const applied: string[] = []

    ledger.commit({
      write: () => 'w',
      changes: () => [upsert('c-inline')],
      apply: (result) => applied.push(`applied:${result}`),
    })

    // Not "eventually": the synchronous store returns T and not Promise<T>, so
    // a caller's next line already observes the install today.
    expect(applied).toEqual(['applied:w'])
  })

  it('does NOT run while the enclosing span is still open', async () => {
    const store = await openTestStore(':memory:')
    const ledger = makeLedger(store)
    const applied: string[] = []

    await store.transact(() => {
      ledger.commit({
        write: () => {},
        changes: () => [upsert('c-deferred')],
        apply: () => applied.push('applied'),
      })
      // THE MECHANISM: the savepoint has been released and the rows are still
      // not durable. Read here, inside the window the bug lived in.
      expect(applied).toEqual([])
    })

    expect(applied).toEqual(['applied'])
  })

  it('never runs when the enclosing span rolls back', async () => {
    const store = await openTestStore(':memory:')
    const ledger = makeLedger(store)
    const applied: string[] = []

    expect(() =>
      store.transact(() => {
        ledger.commit({
          write: () => {
            store.conversations.index.upsert([
              { ...conversationRow('c-rolled-back'), machineId: store.hostMachineId },
            ])
          },
          changes: () => [upsert('c-rolled-back')],
          apply: () => applied.push('applied'),
        })
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // The database forgot the row…
    expect(store.conversations.index.search({}).map((r) => r.id)).not.toContain('c-rolled-back')
    // …and the install that would have claimed it never happened.
    expect(applied).toEqual([])
  })

  it('runs even when every declared change dedups away', async () => {
    // WHY THIS TEST EXISTS, and why the arm cannot live in `Authority.finalize`
    // beside the baseline fold: `finalize` returns early on an empty row set. A
    // fully-deduped commit still ran `write()` and still made whatever durable
    // change the caller owes an install for, so the arm hangs off the COMMIT
    // and not off the appended rows.
    const store = await openTestStore(':memory:')
    const ledger = makeLedger(store)

    const first = ledger.commit({ write: () => {}, changes: () => [upsert('c-dedup')] })
    expect(first.changes.map((c) => c.id)).toEqual(['c-dedup'])

    const applied: string[] = []
    const second = ledger.commit({
      write: () => {},
      changes: () => [upsert('c-dedup')],
      apply: () => applied.push('applied'),
    })
    expect(second.changes).toEqual([])
    expect(applied).toEqual(['applied'])
  })

  it('runs after the baseline fold, inside a span and outside one alike', async () => {
    // The caller's projection may read the ledger's own baseline, so the two
    // commit applications have an order and it is the same in both worlds.
    const store = await openTestStore(':memory:')
    const ledger = makeLedger(store)
    const seen: string[] = []
    const foldedIds = () =>
      ledger.authority.snapshot('conversation').map((v) => (v as { id: string }).id)

    ledger.commit({
      write: () => {},
      changes: () => [upsert('c-order-outer')],
      apply: () => seen.push(foldedIds().includes('c-order-outer') ? 'after' : 'before'),
    })

    await store.transact(() => {
      ledger.commit({
        write: () => {},
        changes: () => [upsert('c-order-inner')],
        apply: () => seen.push(foldedIds().includes('c-order-inner') ? 'after' : 'before'),
      })
    })

    expect(seen).toEqual(['after', 'after'])
  })

  it('does not run when arbitration rejects the write', async () => {
    // The rejected outcome is a different arm from a throw: nothing was
    // written, so there is nothing to install, and the arm sits past the
    // outcome check for that reason.
    const expRevRow = (OWNERSHIP_MATRIX as readonly MatrixRow[]).find(
      (row) => row.conflict === 'exp-rev',
    )
    if (!expRevRow) throw new Error("no shipped matrix row declares 'exp-rev'")
    const store = await openTestStore(':memory:')
    const ledger = makeLedger(store)
    const applied: string[] = []

    expect(() =>
      ledger.commit({
        arbitrate: {
          rowId: expRevRow.id,
          attempt: { expectedRevision: 1 },
          current: () => ({ revision: 9 }),
        },
        write: () => {
          throw new Error('the write must be unreachable past a rejection')
        },
        changes: () => [upsert('c-rejected')],
        apply: () => applied.push('applied'),
      }),
    ).toThrow(/revision-mismatch/)

    expect(applied).toEqual([])
  })

  it('does not run when the commit itself throws', async () => {
    const store = await openTestStore(':memory:')
    const ledger = makeLedger(store)
    const applied: string[] = []

    expect(() =>
      ledger.commit({
        write: () => {
          throw new Error('the write failed')
        },
        changes: () => [upsert('c-failed')],
        apply: () => applied.push('applied'),
      }),
    ).toThrow('the write failed')

    expect(applied).toEqual([])
  })
})
