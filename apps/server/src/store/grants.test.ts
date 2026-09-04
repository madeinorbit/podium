/**
 * THE OWNER COLUMN AND THE GRANT EDGES, AT THE STORE (POD-1079).
 *
 * These run against a REAL migrated SQLite database, not a fake: the thing under
 * test is what the columns do, and a fake repository would agree with whatever
 * this file asserted. That includes the migration — `new SessionStore(':memory:')`
 * applies the bundled manifest, so a `machines` table without `owner_user_id`
 * fails here rather than at boot on somebody's laptop.
 *
 * Every denial below is paired with an admission in the SAME fixture, so no
 * assertion can be satisfied by a store that simply returns nothing.
 */

import { asMachineId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'

const COLLEAGUE = 'colleague'

let store: SessionStore

beforeEach(async () => {
  store = await openTestStore(':memory:')
})

const pair = async (id: string, ownerUserId: string | null): Promise<void> =>
  await store.machines.upsertMachine({
    id: asMachineId(id),
    name: id,
    hostname: `${id}.local`,
    tokenHash: `hash-${id}`,
    ownerUserId: ownerUserId === null ? null : asUserId(ownerUserId),
  })

describe('machines.owner_user_id', () => {
  it('round-trips an owner, and null means unowned rather than absent', async () => {
    await pair('laptop', FIRST_ADMIN_USER_ID)
    await pair('orphan', null)

    const rows = await store.machines.listMachines()
    expect(rows.find((m) => m.id === 'laptop')?.ownerUserId).toBe(FIRST_ADMIN_USER_ID)
    // Present-and-null, NOT undefined: `MachineRecord.ownerUserId` is required so
    // "unowned" and "nobody threaded the value" cannot look alike.
    expect(rows.find((m) => m.id === 'orphan')).toHaveProperty('ownerUserId', null)
    expect((await store.machines.getMachine('orphan'))?.ownerUserId).toBeNull()
  })

  it('a re-pair does NOT transfer ownership — the existing owner survives', async () => {
    await pair('laptop', FIRST_ADMIN_USER_ID)

    // The same daemon re-pairs (or a boot-time provision runs) with a different
    // owner in the frame. Latest-writer-wins here would make re-pairing a silent
    // take-over of somebody else's machine.
    await pair('laptop', COLLEAGUE)

    expect((await store.machines.getMachine('laptop'))?.ownerUserId).toBe(FIRST_ADMIN_USER_ID)
  })

  it('a row that has NO owner acquires one — the COALESCE fills NULL, it does not only preserve', async () => {
    // The counterfactual to the test above: if the ON CONFLICT clause simply kept
    // the old value unconditionally, a legacy NULL row could never be adopted and
    // that machine would be permanently unusable.
    await pair('legacy', null)
    await pair('legacy', COLLEAGUE)

    expect((await store.machines.getMachine('legacy'))?.ownerUserId).toBe(COLLEAGUE)
  })
})

describe('the grant edge table', () => {
  const edge = (grantee: string, verb: 'see' | 'use' | 'manage', resourceId = 'laptop') => ({
    resourceKind: 'machine',
    resourceId,
    grantee,
    verb,
    owner: FIRST_ADMIN_USER_ID,
    visibility: 'owned-compute',
    createdAt: '2026-07-30T00:00:00.000Z',
    actorKind: 'user',
    actorId: FIRST_ADMIN_USER_ID,
    onBehalfOf: FIRST_ADMIN_USER_ID,
  })

  it('stores, reads back and revokes one verb without touching the others', async () => {
    const before = await store.grants.visibilityRevision()
    await store.grants.upsert(edge(COLLEAGUE, 'use'))
    await store.grants.upsert(edge(COLLEAGUE, 'see'))
    expect(await store.grants.visibilityRevision()).toBe(before + 2)

    expect(
      (await store.grants.listForResource('machine', 'laptop')).map((g) => g.verb).sort(),
    ).toEqual(['see', 'use'])

    expect(await store.grants.remove('machine', 'laptop', COLLEAGUE, 'use')).toBe(true)
    expect(await store.grants.visibilityRevision()).toBe(before + 3)
    expect((await store.grants.listForResource('machine', 'laptop')).map((g) => g.verb)).toEqual([
      'see',
    ])
  })

  it('revoking something that was never granted reports false rather than pretending', async () => {
    await store.grants.upsert(edge(COLLEAGUE, 'see'))

    const afterGrant = await store.grants.visibilityRevision()
    expect(await store.grants.remove('machine', 'laptop', COLLEAGUE, 'manage')).toBe(false)
    expect(await store.grants.visibilityRevision()).toBe(afterGrant)
    // …and the instrument can say true, in the same fixture:
    expect(await store.grants.remove('machine', 'laptop', COLLEAGUE, 'see')).toBe(true)
  })

  it('re-granting the same verb is idempotent and re-stamps the granter', async () => {
    await store.grants.upsert(edge(COLLEAGUE, 'use'))
    await store.grants.upsert({ ...edge(COLLEAGUE, 'use'), owner: 'someone-else' })

    const rows = await store.grants.listForResource('machine', 'laptop')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.owner).toBe('someone-else')
  })

  it('an edge whose verb this build does not understand is DROPPED, not admitted', async () => {
    await store.grants.upsert(edge(COLLEAGUE, 'use'))
    // The cast is the point: this is the row a NEWER build (or a corruption)
    // leaves behind, and the type system is exactly what stops this build from
    // writing it. Reading it back must fail CLOSED.
    await store.grants.upsert({ ...edge(COLLEAGUE, 'use'), verb: 'teleport' as 'use' })

    const rows = await store.grants.listForResource('machine', 'laptop')
    // The unknown verb replaced nothing and is not returned; the known one still
    // is, so this is not an empty-store pass.
    expect(rows.map((g) => g.verb)).toEqual(['use'])
  })

  it('edges are scoped to their resource, and die with it', async () => {
    await store.grants.upsert(edge(COLLEAGUE, 'use', 'laptop'))
    await store.grants.upsert(edge(COLLEAGUE, 'use', 'workstation'))

    const beforeRemove = await store.grants.visibilityRevision()
    await store.grants.removeAllForResource('machine', 'laptop')
    expect(await store.grants.visibilityRevision()).toBe(beforeRemove + 1)

    expect(await store.grants.listForResource('machine', 'laptop')).toEqual([])
    expect(await store.grants.listForResource('machine', 'workstation')).toHaveLength(1)
  })

  it('listForKind returns every machine edge and nothing from another kind', async () => {
    await store.grants.upsert(edge(COLLEAGUE, 'use', 'laptop'))
    await store.grants.upsert({ ...edge(COLLEAGUE, 'use', 'iss_1'), resourceKind: 'issue' })

    expect((await store.grants.listForKind('machine')).map((g) => g.resourceId)).toEqual(['laptop'])
  })
})
