/**
 * WHO MAY USE A CREDENTIAL (credential management §12, epic Task 4): its owner,
 * and whoever holds a `use` or `manage` grant that someone with the right to give
 * it gave, read from the grant table at every call. Being an admin counts for
 * nothing. Each denial sits beside an admission in the same fixture.
 */

import {
  ALL_MEMBERS_GRANTEE,
  asUserId,
  type CredentialId,
  firstAdminMemberId,
  type GrantVerb,
  type UserId,
} from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { memberFacts } from '../../store/fixtures/test-support'
import { openTestStore } from '../../test-support/open-test-store'
import { mayUse } from './may-use'

const OWNER = asUserId('user:may-use-owner')
const MANAGER = asUserId('user:may-use-manager')
const BOB = asUserId('user:may-use-bob')
const CAROL = asUserId('user:may-use-carol')
const ADMIN = firstAdminMemberId()

let store: SessionStore
let credential: { id: CredentialId; ownerUserId: UserId }

const member = async (id: UserId): Promise<void> =>
  await memberFacts(store).create(
    { id, displayName: id, role: 'member', createdAt: new Date().toISOString(), disabledAt: null },
    'not-a-real-hash',
  )

const grant = async (grantee: string, verb: GrantVerb, granter: UserId): Promise<void> =>
  await store.grants.upsert({
    resourceKind: 'credential',
    resourceId: credential.id,
    grantee,
    verb,
    owner: granter,
    visibility: 'secret',
    createdAt: new Date().toISOString(),
    actorKind: 'user',
    actorId: granter,
    onBehalfOf: granter,
  })

beforeEach(async () => {
  store = await openTestStore(':memory:')
  for (const id of [OWNER, MANAGER, BOB, CAROL]) await member(id)
  credential = await store.credentials.insert({
    ownerUserId: OWNER,
    label: 'Team key',
    type: 'anthropic.api-key',
  })
})
afterEach(async () => {
  await store.close()
})

describe('mayUse', () => {
  it('the owner owns it; nobody else, an admin included, has any access', async () => {
    expect(await mayUse(store, OWNER, credential)).toBe('owner')
    expect(await mayUse(store, BOB, credential)).toBeNull()
    expect(await mayUse(store, ADMIN, credential)).toBeNull()
  })

  it('a use grant gives use to that person only', async () => {
    await grant(BOB, 'use', OWNER)
    expect(await mayUse(store, BOB, credential)).toBe('use')
    expect(await mayUse(store, CAROL, credential)).toBeNull()
  })

  it('a use grant to all members gives use to every member, the admin included', async () => {
    await grant(ALL_MEMBERS_GRANTEE, 'use', OWNER)
    expect(await mayUse(store, BOB, credential)).toBe('use')
    expect(await mayUse(store, CAROL, credential)).toBe('use')
    expect(await mayUse(store, ADMIN, credential)).toBe('use')
    expect(await mayUse(store, OWNER, credential)).toBe('owner')
  })

  it('manage gives manage, and a manager can give use', async () => {
    await grant(MANAGER, 'manage', OWNER)
    await grant(CAROL, 'use', MANAGER)
    expect(await mayUse(store, MANAGER, credential)).toBe('manage')
    expect(await mayUse(store, CAROL, credential)).toBe('use')
  })

  it("a grant counts only while its granter still may give it (review focus: granter's current rights)", async () => {
    await grant(MANAGER, 'manage', OWNER)
    await grant(CAROL, 'use', MANAGER)
    // Someone with no right to share it: their grant counts for nothing.
    await grant(BOB, 'use', CAROL)
    expect(await mayUse(store, CAROL, credential)).toBe('use')
    expect(await mayUse(store, BOB, credential)).toBeNull()

    expect(await store.grants.remove('credential', credential.id, MANAGER, 'manage')).toBe(true)
    expect(await mayUse(store, MANAGER, credential)).toBeNull()
    expect(await mayUse(store, CAROL, credential)).toBeNull()
  })

  it('a grant from a member who was disabled no longer counts', async () => {
    await grant(MANAGER, 'manage', OWNER)
    await grant(CAROL, 'use', MANAGER)
    expect(await mayUse(store, CAROL, credential)).toBe('use')
    await memberFacts(store).disable(MANAGER, new Date().toISOString())
    expect(await mayUse(store, CAROL, credential)).toBeNull()
  })

  it("nobody else may use a disabled owner's credential", async () => {
    await grant(ALL_MEMBERS_GRANTEE, 'use', OWNER)
    expect(await mayUse(store, BOB, credential)).toBe('use')
    await memberFacts(store).disable(OWNER, new Date().toISOString())
    expect(await mayUse(store, BOB, credential)).toBeNull()
  })

  it('removing a member leaves the all-members grant in place', async () => {
    await grant(ALL_MEMBERS_GRANTEE, 'use', OWNER)
    await grant(BOB, 'use', OWNER)
    await memberFacts(store).removeMember(BOB, ADMIN)
    const edges = await store.grants.listForResource('credential', credential.id)
    expect(edges.map((e) => e.grantee)).toEqual([ALL_MEMBERS_GRANTEE])
    expect(await mayUse(store, CAROL, credential)).toBe('use')
  })
})
