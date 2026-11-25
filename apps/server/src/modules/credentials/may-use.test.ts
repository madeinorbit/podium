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

  // POD-7594: a disable is temporary. What the person shared stays shared;
  // only they themselves may use nothing until they are enabled again.
  it('a grant from a member who was disabled still counts; the disabled manager uses nothing', async () => {
    await grant(MANAGER, 'manage', OWNER)
    await grant(CAROL, 'use', MANAGER)
    expect(await mayUse(store, CAROL, credential)).toBe('use')
    await memberFacts(store).disable(MANAGER, new Date().toISOString())
    expect(await mayUse(store, CAROL, credential)).toBe('use')
    expect(await mayUse(store, MANAGER, credential)).toBeNull()
  })

  it("a disabled owner's shared credential stays usable by the people it was shared with", async () => {
    await grant(ALL_MEMBERS_GRANTEE, 'use', OWNER)
    expect(await mayUse(store, BOB, credential)).toBe('use')
    await memberFacts(store).disable(OWNER, new Date().toISOString())
    expect(await mayUse(store, BOB, credential)).toBe('use')
    expect(await mayUse(store, OWNER, credential)).toBeNull()
  })

  it('removing a member leaves the all-members grant in place', async () => {
    await grant(ALL_MEMBERS_GRANTEE, 'use', OWNER)
    await grant(BOB, 'use', OWNER)
    await memberFacts(store).removeMember(BOB, ADMIN)
    const edges = await store.grants.listForResource('credential', credential.id)
    expect(edges.map((e) => e.grantee)).toEqual([ALL_MEMBERS_GRANTEE])
    expect(await mayUse(store, CAROL, credential)).toBe('use')
  })

  // POD-7594: a removal ends the shares of the keys the person owns, in its own
  // transaction (final review N1); the grants they gave as a manager on someone
  // else's key stand (operator decision), handed to that key's owner, and no
  // edge names the removed person, so a re-invite with the same id restores
  // nothing (final review 2).
  it("removing a member ends the shares of their keys, keeps what they gave on another's key, and a re-invite restores nothing", async () => {
    await grant(MANAGER, 'manage', OWNER)
    await grant(CAROL, 'use', MANAGER)
    const managers = await store.credentials.insert({
      ownerUserId: MANAGER,
      label: 'Manager key',
      type: 'anthropic.api-key',
    })
    await store.grants.upsert({
      resourceKind: 'credential',
      resourceId: managers.id,
      grantee: BOB,
      verb: 'use',
      owner: MANAGER,
      visibility: 'secret',
      createdAt: new Date().toISOString(),
      actorKind: 'user',
      actorId: MANAGER,
      onBehalfOf: MANAGER,
    })
    expect(await mayUse(store, BOB, managers)).toBe('use')
    await memberFacts(store).removeMember(MANAGER, ADMIN)
    // Their own key: no share left, before any cleanup runs.
    expect(await store.grants.listForResource('credential', managers.id)).toEqual([])
    expect(await mayUse(store, BOB, managers)).toBeNull()
    // What they gave on the owner's key stands, given now by the owner.
    const edges = await store.grants.listForResource('credential', credential.id)
    expect(edges.some((e) => e.grantee === MANAGER || e.owner === MANAGER)).toBe(false)
    expect(edges.find((e) => e.grantee === CAROL)?.owner).toBe(OWNER)
    expect(await mayUse(store, CAROL, credential)).toBe('use')
    expect(await mayUse(store, MANAGER, credential)).toBeNull()
    // Invited again under the same id: nothing they held comes back.
    await memberFacts(store).enable(MANAGER, new Date().toISOString(), ADMIN)
    expect(await store.users.get(MANAGER)).toBeDefined()
    expect(await mayUse(store, MANAGER, credential)).toBeNull()
    expect(await mayUse(store, CAROL, credential)).toBe('use')
    // The owner revokes it like any other share.
    expect(await store.grants.remove('credential', credential.id, CAROL, 'use')).toBe(true)
    expect(await mayUse(store, CAROL, credential)).toBeNull()
  })

  // POD-7594, review F2: a refresh or a re-judge for a person who left says no.
  it('a member who was removed may use nothing, through the all-members grant included', async () => {
    await grant(ALL_MEMBERS_GRANTEE, 'use', OWNER)
    await grant(BOB, 'use', OWNER)
    expect(await mayUse(store, BOB, credential)).toBe('use')
    await memberFacts(store).removeMember(BOB, ADMIN)
    expect(await mayUse(store, BOB, credential)).toBeNull()
    expect(await mayUse(store, CAROL, credential)).toBe('use')
  })

  it('a member who was disabled may use nothing, their own credential and a manage grant included', async () => {
    await grant(MANAGER, 'manage', OWNER)
    expect(await mayUse(store, MANAGER, credential)).toBe('manage')
    await memberFacts(store).disable(MANAGER, new Date().toISOString())
    expect(await mayUse(store, MANAGER, credential)).toBeNull()
    await memberFacts(store).disable(OWNER, new Date().toISOString())
    expect(await mayUse(store, OWNER, credential)).toBeNull()
    await memberFacts(store).enable(OWNER, new Date().toISOString())
    expect(await mayUse(store, OWNER, credential)).toBe('owner')
  })
})
