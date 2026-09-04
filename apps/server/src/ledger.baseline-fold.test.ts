import { Ledger } from '@podium/sync'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from './store'
import { applyAfterCommit, spanOpen } from './store/executor/synchronous-span'
import { openTestStore } from './test-support/open-test-store'

/**
 * THE BASELINE FOLD IS A COMMIT APPLICATION, NOT A SAVEPOINT RELEASE (POD-3328,
 * spec §3.3 mechanism 1).
 *
 * A `ledger.commit` nested inside an enclosing `store.transact` is a SAVEPOINT.
 * Releasing that savepoint is not a commit: the enclosing span can still roll
 * back, and when it does the database forgets the change rows. The in-memory
 * baseline has to forget them too, or process memory outlives the truth and
 * keeps claiming rows the database never kept until something reseeds it.
 *
 * WHAT THESE TESTS ASSERT ON, deliberately: the baseline itself, through
 * `authority.snapshot` (its `current` map) and through the DEDUP DECISION it
 * drives (a re-commit of the rolled-back value must append, because a baseline
 * that still remembers the value would dedup it away). Both are reads of
 * process memory. Nothing here reloads the store, reseeds a baseline or
 * re-reads the database between the rollback and the assertion — the whole
 * point is to observe the state a reload would paper over.
 */
describe('the baseline fold waits for the outermost commit (POD-3328)', () => {
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
      // The same wiring the composition root uses (`relay.ts`): the fold is
      // mechanism 1 on the OUTERMOST commit, and with no span open it applies
      // at once, which is where it happens today.
      applyCommit: { spanOpen, onCommit: applyAfterCommit },
    })
  }

  const baselineIds = (ledger: Ledger): string[] =>
    ledger.authority.snapshot('conversation').map((v) => (v as { id: string }).id)

  it('drops a nested write the enclosing span rolled back', async () => {
    const store = await openTestStore(':memory:')
    const ledger = makeLedger(store)
    const cursorBefore = ledger.cursor()

    expect(() =>
      store.transact(() => {
        // A nested ledger.commit: its own transact span degrades to a savepoint
        // and RELEASES when this callback returns.
        ledger.commit({
          write: () => {
            store.conversations.index.upsert([
              { ...conversationRow('c-rolled-back'), machineId: store.hostMachineId },
            ])
          },
          changes: () => [
            {
              entity: 'conversation',
              id: 'c-rolled-back',
              op: 'upsert',
              value: conversationRow('c-rolled-back'),
            },
          ],
        })
        // …and now the ENCLOSING span fails, after the savepoint was released.
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // The database forgot the row and the change append.
    expect(store.conversations.index.search({}).map((r) => r.id)).not.toContain('c-rolled-back')
    expect(ledger.cursor()).toBe(cursorBefore)
    // THE MECHANISM: so must the in-memory baseline.
    expect(baselineIds(ledger)).not.toContain('c-rolled-back')
  })

  it('leaves a baseline that still dedups correctly after the rollback', async () => {
    const store = await openTestStore(':memory:')
    const ledger = makeLedger(store)

    expect(() =>
      store.transact(() => {
        ledger.commit({
          write: () => {},
          changes: () => [
            {
              entity: 'conversation',
              id: 'c-rolled-back',
              op: 'upsert',
              value: conversationRow('c-rolled-back'),
            },
          ],
        })
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // Committing the SAME value again must append: the row is not in the log,
    // so a baseline that still held its detection key would dedup away the only
    // record of a row that does exist.
    const { changes } = ledger.commit({
      write: () => {},
      changes: () => [
        {
          entity: 'conversation',
          id: 'c-rolled-back',
          op: 'upsert',
          value: conversationRow('c-rolled-back'),
        },
      ],
    })
    expect(changes.map((c) => ({ id: c.id, op: c.op }))).toEqual([
      { id: 'c-rolled-back', op: 'upsert' },
    ])
    expect(baselineIds(ledger)).toContain('c-rolled-back')
  })

  it('still folds when the enclosing span commits', async () => {
    const store = await openTestStore(':memory:')
    const ledger = makeLedger(store)
    const cursorBefore = ledger.cursor()

    await store.transact(() => {
      ledger.commit({
        write: () => {
          store.conversations.index.upsert([
            { ...conversationRow('c-kept'), machineId: store.hostMachineId },
          ])
        },
        changes: () => [
          { entity: 'conversation', id: 'c-kept', op: 'upsert', value: conversationRow('c-kept') },
        ],
      })
    })

    expect(ledger.cursor()).toBe(cursorBefore + 1)
    expect(baselineIds(ledger)).toContain('c-kept')
    // And the fold landed, so the same value now dedups away.
    const { changes } = ledger.commit({
      write: () => {},
      changes: () => [
        { entity: 'conversation', id: 'c-kept', op: 'upsert', value: conversationRow('c-kept') },
      ],
    })
    expect(changes).toEqual([])
  })

  it('does not serve an orphaned stage to a LATER commit that opens its own span', async () => {
    // THE HAZARD `spanOpen()` ALONE CANNOT SEE [POD-3366]. It answers "is ANY
    // write span open", so a layer orphaned by a rollback and then read from
    // inside a later commit's OWN transaction sees `true` and survives. The
    // read here happens inside `ledger.commit`'s span, in `changes()`, which is
    // where the issue row map and the session baselines are read for real.
    const store = await openTestStore(':memory:')
    const ledger = makeLedger(store)

    expect(() =>
      store.transact(() => {
        ledger.commit({
          write: () => {},
          changes: () => [
            {
              entity: 'conversation',
              id: 'c-orphan',
              op: 'upsert',
              value: conversationRow('c-orphan'),
            },
          ],
        })
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // A later, unrelated top-level commit. Its own `transact` is open while
    // `changes()` runs, so the orphan is only dropped if the layer knows which
    // UNIT staged it rather than merely that something is open.
    let seenInsideTheSpan: string[] = []
    ledger.commit({
      write: () => {},
      changes: () => {
        seenInsideTheSpan = baselineIds(ledger)
        return [
          { entity: 'conversation', id: 'c-other', op: 'upsert', value: conversationRow('c-other') },
        ]
      },
    })

    expect(seenInsideTheSpan).not.toContain('c-orphan')
    expect(baselineIds(ledger)).not.toContain('c-orphan')
  })

  it('a second nested write in the same span still sees the first one (the in-window reader)', async () => {
    // WHY THIS TEST EXISTS. Deferring the fold is only free if nothing reads the
    // baseline between the savepoint release and the outermost commit. Something
    // does: `Authority.stage` dedups every later write against it, and it DROPS a
    // remove whose id the baseline does not hold. A bare deferral would therefore
    // turn create-then-delete inside one enclosing span into a durable upsert
    // with no remove after it — a phantom row in the log for an entity the
    // transaction deleted. The pending overlay is what keeps that reader honest.
    const store = await openTestStore(':memory:')
    const ledger = makeLedger(store)
    const cursorBefore = ledger.cursor()

    await store.transact(() => {
      ledger.commit({
        write: () => {},
        changes: () => [
          {
            entity: 'conversation',
            id: 'c-churn',
            op: 'upsert',
            value: conversationRow('c-churn'),
          },
        ],
      })
      // Same value again: the first write is not folded yet, but the overlay
      // holds it, so this dedups away exactly as it does outside a span.
      const repeat = ledger.commit({
        write: () => {},
        changes: () => [
          {
            entity: 'conversation',
            id: 'c-churn',
            op: 'upsert',
            value: conversationRow('c-churn'),
          },
        ],
      })
      expect(repeat.changes).toEqual([])
      // And the remove is NOT dropped, because the overlay says the id is there.
      const removed = ledger.commit({
        write: () => {},
        changes: () => [{ entity: 'conversation', id: 'c-churn', op: 'remove' }],
      })
      expect(removed.changes.map((c) => c.op)).toEqual(['remove'])
    })

    expect(ledger.cursor()).toBe(cursorBefore + 2)
    expect(baselineIds(ledger)).not.toContain('c-churn')
  })
})
