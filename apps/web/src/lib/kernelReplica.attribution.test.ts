/**
 * THE ATTRIBUTION GATE HAS A CALLER, AND IT CAN SAY NO (POD-1239).
 *
 * POD-377 built `decideLegacyAdoption`, POD-378 verified it, POD-377 merged and
 * closed — and nothing on either client ever called it. A gate with no caller is
 * indistinguishable from an enforced one in every handoff that cites it, and
 * this one guards POD-307's fail-closed rule: an unattributable store is
 * DISCARDED and re-bootstrapped, never adopted, because on a shared device
 * adoption is how one person's cached rows become another person's history.
 *
 * WHY THE REFUSAL ARM IS THE WHOLE TEST. The default evidence on this tree is
 * `single-account`, which always adopts — so a suite that only ever presented
 * the default would pass against a root with no gate at all. That is exactly how
 * this survived being built, verified and merged. Every case here presents
 * evidence that must be REFUSED, with the adopting case beside it as the
 * counterfactual.
 */

import { asMutationId } from '@podium/model'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { type KernelAssembly, openKernelAssembly } from './kernelReplica'

/** The gate runs before any row is read, so nothing here needs a live server. */
const trpc = {
  sync: { feedChangesSince: { query: async () => ({ changes: [] }) } },
} as unknown as Parameters<typeof openKernelAssembly>[0]['trpc']

let dbSeq = 0

async function open(
  evidence: Parameters<typeof openKernelAssembly>[0]['evidence'],
  databaseName: string,
  factory: IDBFactory,
): Promise<{ assembly: KernelAssembly; degraded: unknown[] }> {
  const degraded: unknown[] = []
  const assembly = await openKernelAssembly({
    trpc,
    factory: factory as never,
    databaseName,
    evidence,
    principal: 'alice',
    onDegraded: (d) => degraded.push(d),
  })
  return { assembly, degraded }
}

describe('the kernel store is only adopted when attribution is CERTAIN', () => {
  let factory: IDBFactory
  let db: string

  beforeEach(() => {
    factory = new IDBFactory()
    dbSeq += 1
    db = `attribution-${dbSeq}`
  })

  it('ADOPTS under the shared-password grade — no identities exist, so the store is the operator’s', async () => {
    const { assembly, degraded } = await open(
      { kind: 'single-account', principal: 'default' },
      db,
      factory,
    )
    expect(degraded).toEqual([])
    await assembly.dispose()
  })

  it('REFUSES when nobody could say who the store belongs to', async () => {
    const { assembly, degraded } = await open({ kind: 'unknown' }, db, factory)
    expect(degraded).toEqual([{ kind: 'store-not-adopted', reason: 'discarded-identity-unknown' }])
    await assembly.dispose()
  })

  it('REFUSES a device that has held sessions for someone else', async () => {
    const { assembly, degraded } = await open(
      { kind: 'multi-user', signedInAs: 'alice', identitiesEverSignedIn: ['alice', 'bob'] },
      db,
      factory,
    )
    expect(degraded).toEqual([
      { kind: 'store-not-adopted', reason: 'discarded-multiple-identities' },
    ])
    await assembly.dispose()
  })

  it('REFUSES a ledger that does not name the signed-in user', async () => {
    const { assembly, degraded } = await open(
      { kind: 'multi-user', signedInAs: 'alice', identitiesEverSignedIn: ['bob'] },
      db,
      factory,
    )
    expect(degraded).toEqual([{ kind: 'store-not-adopted', reason: 'discarded-foreign-identity' }])
    await assembly.dispose()
  })

  it('ADOPTS when the device has only ever been this user — the certainty the rule allows', async () => {
    const { assembly, degraded } = await open(
      { kind: 'multi-user', signedInAs: 'alice', identitiesEverSignedIn: ['alice'] },
      db,
      factory,
    )
    expect(degraded).toEqual([])
    await assembly.dispose()
  })

  it('DISCARDS THE ROWS on a refusal — the store re-bootstraps instead of serving them', async () => {
    // The assertion that makes the refusal real rather than cosmetic: a warning
    // that left the rows in place would satisfy every test above and none of the
    // privacy rule.
    const seeded = await open({ kind: 'single-account', principal: 'default' }, db, factory)
    seeded.assembly.store.viewFor('alice').cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issue',
          entityId: 'i1',
          value: { id: 'i1' },
          provenance: { seq: 1, originId: 'o', causationId: 'c', mutationId: asMutationId('m') },
        },
      ],
      cursor: { feedId: 'f', epoch: 'e', seq: 1 },
    })
    await seeded.assembly.store.settled()
    expect(seeded.assembly.store.viewFor('alice').cache.readEntities()).toHaveLength(1)
    await seeded.assembly.dispose()

    // Re-open the SAME database with evidence that cannot attribute it.
    const reopened = await open({ kind: 'unknown' }, db, factory)
    expect(reopened.assembly.store.viewFor('alice').cache.readEntities()).toEqual([])
    expect(reopened.assembly.store.viewFor('alice').cache.readCursor()).toBeNull()
    await reopened.assembly.dispose()
  })

  it('…and the SAME store IS still there when attribution succeeds', async () => {
    // The counterfactual for the case above. Without it, a `discardCache()` that
    // ran unconditionally would pass every assertion in this file.
    const seeded = await open({ kind: 'single-account', principal: 'default' }, db, factory)
    seeded.assembly.store.viewFor('alice').cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issue',
          entityId: 'i1',
          value: { id: 'i1' },
          provenance: { seq: 1, originId: 'o', causationId: 'c', mutationId: asMutationId('m') },
        },
      ],
      cursor: { feedId: 'f', epoch: 'e', seq: 1 },
    })
    await seeded.assembly.store.settled()
    await seeded.assembly.dispose()

    const reopened = await open({ kind: 'single-account', principal: 'default' }, db, factory)
    expect(reopened.assembly.store.viewFor('alice').cache.readEntities()).toHaveLength(1)
    await reopened.assembly.dispose()
  })
})
