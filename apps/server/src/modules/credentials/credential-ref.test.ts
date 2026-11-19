/**
 * A LAUNCH NAMES ITS CREDENTIAL (credential management §9 "Choosing for a
 * session", epic plan Task 10): `none`, an id, or a label matched ignoring case
 * among the credentials the acting person can use. Read through a real store.
 */

import { asUserId, type CredentialId, type UserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { memberFacts } from '../../store/fixtures/test-support'
import { openTestStore } from '../../test-support/open-test-store'
import { ACCESS_REFUSAL_MESSAGES } from './access'
import { resolveCredentialRef } from './credential-ref'

const ALICE = asUserId('user:ref-alice')
const BOB = asUserId('user:ref-bob')

let store: SessionStore

const member = async (id: UserId): Promise<void> =>
  await memberFacts(store).create(
    { id, displayName: id, role: 'member', createdAt: new Date().toISOString(), disabledAt: null },
    'not-a-real-hash',
  )

const credential = async (owner: UserId, label: string): Promise<CredentialId> =>
  (await store.credentials.insert({ ownerUserId: owner, label, type: 'anthropic.api-key' })).id

const shareUse = async (id: CredentialId, grantee: UserId, granter: UserId): Promise<void> =>
  await store.grants.upsert({
    resourceKind: 'credential',
    resourceId: id,
    grantee,
    verb: 'use',
    owner: granter,
    visibility: 'secret',
    createdAt: new Date().toISOString(),
    actorKind: 'user',
    actorId: granter,
    onBehalfOf: granter,
  })

const refusalsRecorded = async (): Promise<string[]> =>
  (await store.settingsAudit.list(100))
    .filter((row) => row.command === 'credentials.refuse')
    .map((row) => String((row.detail as { detail?: string }).detail))

beforeEach(async () => {
  store = await openTestStore(':memory:')
  await member(ALICE)
  await member(BOB)
})
afterEach(async () => {
  await store.close()
})

describe('resolveCredentialRef', () => {
  it('reads `none` in any case as the harness login', async () => {
    for (const ref of ['none', 'None', ' NONE ']) {
      expect(await resolveCredentialRef(store, { ref, actingUserId: ALICE })).toEqual({
        ok: true,
        credentialId: null,
      })
    }
  })

  it('takes an id the person can use', async () => {
    const id = await credential(ALICE, 'Work key')
    expect(await resolveCredentialRef(store, { ref: id, actingUserId: ALICE })).toEqual({
      ok: true,
      credentialId: id,
    })
  })

  it("refuses an id the person cannot use, with the resolver's sentence and a refuse event", async () => {
    const id = await credential(BOB, 'Bob key')
    const result = await resolveCredentialRef(store, { ref: id, actingUserId: ALICE })
    expect(result).toEqual({
      ok: false,
      refusal: 'not-yours',
      message: ACCESS_REFUSAL_MESSAGES['not-yours'],
    })
    expect(await refusalsRecorded()).toEqual(['not-yours'])
  })

  it('refuses an unknown id and a removed one', async () => {
    const unknown = await resolveCredentialRef(store, {
      ref: 'cred_00000000-0000-4000-8000-000000000000',
      actingUserId: ALICE,
    })
    expect(unknown).toMatchObject({ ok: false, refusal: 'not-found' })
    const removed = await credential(ALICE, 'Old key')
    await store.credentials.remove(removed)
    expect(await resolveCredentialRef(store, { ref: removed, actingUserId: ALICE })).toMatchObject({
      ok: false,
      refusal: 'revoked',
    })
  })

  it('matches a label ignoring case and surrounding space, own or shared', async () => {
    const own = await credential(ALICE, 'Work Key')
    const shared = await credential(BOB, 'Team key')
    await shareUse(shared, ALICE, BOB)
    expect(await resolveCredentialRef(store, { ref: ' work key', actingUserId: ALICE })).toEqual({
      ok: true,
      credentialId: own,
    })
    expect(await resolveCredentialRef(store, { ref: 'TEAM KEY', actingUserId: ALICE })).toEqual({
      ok: true,
      credentialId: shared,
    })
  })

  it('does not match the label of a credential the person cannot use', async () => {
    await credential(BOB, 'Bob key')
    const result = await resolveCredentialRef(store, { ref: 'bob key', actingUserId: ALICE })
    expect(result).toEqual({
      ok: false,
      message: 'No credential you can use is labelled "bob key".',
    })
  })

  it('an exact id wins over a credential whose label equals it', async () => {
    const target = await credential(ALICE, 'Target')
    // Two others labelled with the target's id, exactly and in another case:
    // matched as a label, the reference would be ambiguous or another one.
    await credential(ALICE, target)
    await credential(ALICE, target.toUpperCase())
    expect(await resolveCredentialRef(store, { ref: target, actingUserId: ALICE })).toEqual({
      ok: true,
      credentialId: target,
    })
  })

  it("`none` is the harness's own login even when a credential is labelled none", async () => {
    await credential(ALICE, 'none')
    await credential(ALICE, 'NONE')
    expect(await resolveCredentialRef(store, { ref: 'none', actingUserId: ALICE })).toEqual({
      ok: true,
      credentialId: null,
    })
  })

  it('refuses a label that matches two credentials and names both', async () => {
    const first = await credential(ALICE, 'Claude')
    const second = await credential(BOB, 'claude')
    await shareUse(second, ALICE, BOB)
    const result = await resolveCredentialRef(store, { ref: 'CLAUDE', actingUserId: ALICE })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain(`"Claude" (${first})`)
    expect(result.message).toContain(`"claude" (${second})`)
    expect(result.message).toContain('Name one by its id.')
  })
})
