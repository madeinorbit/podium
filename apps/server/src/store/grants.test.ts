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

import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../store'

const COLLEAGUE = 'colleague'

let store: SessionStore

beforeEach(() => {
  store = new SessionStore(':memory:')
})

const pair = (id: string, ownerUserId: string | null): void =>
  store.machines.upsertMachine({
    id,
    name: id,
    hostname: `${id}.local`,
    tokenHash: `hash-${id}`,
    ownerUserId,
  })

describe('machines.owner_user_id', () => {
  it('round-trips an owner, and null means unowned rather than absent', () => {
    pair('laptop', FIRST_ADMIN_USER_ID)
    pair('orphan', null)

    const rows = store.machines.listMachines()
    expect(rows.find((m) => m.id === 'laptop')?.ownerUserId).toBe(FIRST_ADMIN_USER_ID)
    // Present-and-null, NOT undefined: `MachineRecord.ownerUserId` is required so
    // "unowned" and "nobody threaded the value" cannot look alike.
    expect(rows.find((m) => m.id === 'orphan')).toHaveProperty('ownerUserId', null)
    expect(store.machines.getMachine('orphan')?.ownerUserId).toBeNull()
  })

  it('a re-pair does NOT transfer ownership — the existing owner survives', () => {
    pair('laptop', FIRST_ADMIN_USER_ID)

    // The same daemon re-pairs (or a boot-time provision runs) with a different
    // owner in the frame. Latest-writer-wins here would make re-pairing a silent
    // take-over of somebody else's machine.
    pair('laptop', COLLEAGUE)

    expect(store.machines.getMachine('laptop')?.ownerUserId).toBe(FIRST_ADMIN_USER_ID)
  })

  it('a row that has NO owner acquires one — the COALESCE fills NULL, it does not only preserve', () => {
    // The counterfactual to the test above: if the ON CONFLICT clause simply kept
    // the old value unconditionally, a legacy NULL row could never be adopted and
    // that machine would be permanently unusable.
    pair('legacy', null)
    pair('legacy', COLLEAGUE)

    expect(store.machines.getMachine('legacy')?.ownerUserId).toBe(COLLEAGUE)
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

  it('stores, reads back and revokes one verb without touching the others', () => {
    store.grants.upsert(edge(COLLEAGUE, 'use'))
    store.grants.upsert(edge(COLLEAGUE, 'see'))

    expect(store.grants.listForResource('machine', 'laptop').map((g) => g.verb).sort()).toEqual([
      'see',
      'use',
    ])

    expect(store.grants.remove('machine', 'laptop', COLLEAGUE, 'use')).toBe(true)
    expect(store.grants.listForResource('machine', 'laptop').map((g) => g.verb)).toEqual(['see'])
  })

  it('revoking something that was never granted reports false rather than pretending', () => {
    store.grants.upsert(edge(COLLEAGUE, 'see'))

    expect(store.grants.remove('machine', 'laptop', COLLEAGUE, 'manage')).toBe(false)
    // …and the instrument can say true, in the same fixture:
    expect(store.grants.remove('machine', 'laptop', COLLEAGUE, 'see')).toBe(true)
  })

  it('re-granting the same verb is idempotent and re-stamps the granter', () => {
    store.grants.upsert(edge(COLLEAGUE, 'use'))
    store.grants.upsert({ ...edge(COLLEAGUE, 'use'), owner: 'someone-else' })

    const rows = store.grants.listForResource('machine', 'laptop')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.owner).toBe('someone-else')
  })

  it('an edge whose verb this build does not understand is DROPPED, not admitted', () => {
    store.grants.upsert(edge(COLLEAGUE, 'use'))
    // The cast is the point: this is the row a NEWER build (or a corruption)
    // leaves behind, and the type system is exactly what stops this build from
    // writing it. Reading it back must fail CLOSED.
    store.grants.upsert({ ...edge(COLLEAGUE, 'use'), verb: 'teleport' as 'use' })

    const rows = store.grants.listForResource('machine', 'laptop')
    // The unknown verb replaced nothing and is not returned; the known one still
    // is, so this is not an empty-store pass.
    expect(rows.map((g) => g.verb)).toEqual(['use'])
  })

  it('edges are scoped to their resource, and die with it', () => {
    store.grants.upsert(edge(COLLEAGUE, 'use', 'laptop'))
    store.grants.upsert(edge(COLLEAGUE, 'use', 'workstation'))

    store.grants.removeAllForResource('machine', 'laptop')

    expect(store.grants.listForResource('machine', 'laptop')).toEqual([])
    expect(store.grants.listForResource('machine', 'workstation')).toHaveLength(1)
  })

  it('listForKind returns every machine edge and nothing from another kind', () => {
    store.grants.upsert(edge(COLLEAGUE, 'use', 'laptop'))
    store.grants.upsert({ ...edge(COLLEAGUE, 'use', 'iss_1'), resourceKind: 'issue' })

    expect(store.grants.listForKind('machine').map((g) => g.resourceId)).toEqual(['laptop'])
  })
})
