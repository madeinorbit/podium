/**
 * The cross-hop conformance suite, against a REAL SQLite engine (POD-375).
 *
 * ─── THE GUARD THAT FIRES FIRST ──────────────────────────────────────────────
 *
 * POD-305's rule, transplanted: a suite wired onto a real implementation must fail
 * LOUDLY and BY NAME the day it stops being backed by one. Everything below
 * `describeSyncConformance` would still pass against a Map wearing this adapter's
 * interface — thirty green cases certifying nothing about SQLite — so the guard runs
 * first, names the engine, and proves the storage the suite receives really writes
 * rows into a database file.
 *
 * ─── AND THE HONEST LIMIT OF A GREEN RUN, STATED HERE SO IT IS NOT OVER-READ ──
 *
 * POD-374 applied the ADR 2 D10 non-compliance verbatim — one transaction per staged
 * write — and this suite stayed green, all 30 cases, because `failNextCommit` fires
 * before the adapter's `BEGIN IMMEDIATE`. The gate is correct for the kernel and
 * BLIND to the adapter. So:
 *
 *   GREEN HERE MEANS: this adapter satisfies the kernel's storage contract.
 *   IT DOES NOT MEAN: entities, cursor and outbox commit in ONE transaction.
 *
 * The second claim belongs to `crash.test.ts`, which kills at every boundary INSIDE
 * one live transaction and reads back through a connection of its own. Mutation
 * evidence for both is in `docs/agents/pod-375-storage-evidence.md`.
 */

import { describe, expect, it } from 'vitest'
import { describeSyncConformance } from '../../conformance/suite'
import { SqliteConformanceStorage, sqliteInstantiation } from './conformance'
import { readDurable, sqliteEngine } from './test-support'

describe('the guard fires FIRST: this instantiation is backed by a real SQLite engine', () => {
  it('names a resolved engine, not a stand-in', () => {
    // `resolveSqliteEngine` throws rather than substituting a fake, so reaching this
    // line at all is part of the claim. Asserting the NAME is what makes a silent
    // swap — to an in-memory imitation with the same shape — a failure here rather
    // than thirty passes downstream.
    expect(['bun:sqlite', 'node:sqlite']).toContain(sqliteEngine.name)
    expect(sqliteInstantiation.name).toBe('mobile-sqlite')
  })

  it('the storage the suite receives writes ROWS INTO A FILE, and the reader can say both yes and no', async () => {
    const storage = await SqliteConformanceStorage.open()
    const view = storage.viewFor('ada')

    // NO first: a fresh storage has an empty file. Without this the "yes" below is
    // equally consistent with a reader that reports rows unconditionally.
    expect(readDurable(storage.databaseFile).entities).toEqual([])

    view.cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issue',
          entityId: 'ADA-1',
          value: { n: 1 },
          provenance: { seq: 1 },
        },
      ],
      cursor: { feedId: 'feed', epoch: 'e1', seq: 1 },
    })

    // …then YES, read through a CONNECTION OF ITS OWN. A mirror cannot satisfy this.
    expect(readDurable(storage.databaseFile).entities).toEqual([
      { principal: 'ada', entity: 'issue', entityId: 'ADA-1', value: { n: 1 } },
    ])
  })
})

describeSyncConformance(sqliteInstantiation)
