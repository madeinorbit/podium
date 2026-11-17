/** Old account ids resolve to what they meant (review focus 4). */

import { ALL_MEMBERS_GRANTEE, asUserId, type UserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { memberFacts } from '../../store/fixtures/test-support'
import { openTestStore } from '../../test-support/open-test-store'
import { credentialIdFromLegacy } from './legacy-ids'
import { CREDENTIAL_RESOURCE_KIND } from './may-use'

const ALICE = asUserId('user:legacy-alice')
const BOB = asUserId('user:legacy-bob')
const CAROL = asUserId('user:legacy-carol')
const DAVE = asUserId('user:legacy-dave')

let store: SessionStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

describe('credentialIdFromLegacy', () => {
  it('reads every old spelling as it was meant', async () => {
    store = await openTestStore(':memory:')
    const s = store
    const anthropic = await s.credentials.insert({
      ownerUserId: ALICE,
      label: 'Anthropic',
      type: 'anthropic.api-key',
      legacyId: 'acct-anthropic-alice',
      legacyKey: 'managed:anthropic',
    })
    const token = await s.credentials.insert({
      ownerUserId: ALICE,
      label: 'Claude token',
      type: 'anthropic.claude-token',
      legacyKey: 'managed:claude-oauth',
    })
    const earlier = await s.credentials.insert({
      ownerUserId: ALICE,
      label: 'Earlier workspace',
      type: 'anthropic.api-key',
      legacyKey: 'managed:anthropic:earlier-workspace',
    })
    const codexLogin = await s.credentials.insert({
      ownerUserId: ALICE,
      label: 'ChatGPT',
      type: 'openai.chatgpt-login',
      identity: { fingerprint: 'fp-codex' },
    })

    const read = (id: string) => credentialIdFromLegacy(s, id, ALICE)
    expect(await read('')).toBeNull()
    expect(await read('native:claude-code')).toBeNull()
    expect(await read('native:codex')).toBeNull()
    expect(await read('native:codex:fp-codex')).toBe(codexLogin.id)
    expect(await read('native:codex:fp-unknown')).toBeNull()
    // A harness's fingerprint never names another harness's login type.
    expect(await read('native:claude-code:fp-codex')).toBeNull()
    expect(await read('managed:anthropic')).toBe(anthropic.id)
    expect(await read('managed:claude-oauth')).toBe(token.id)
    expect(await read('managed:anthropic:earlier-workspace')).toBe(earlier.id)
    // The accounts row id, when that is what was recorded.
    expect(await read('acct-anthropic-alice')).toBe(anthropic.id)
    expect(await read('managed:openai')).toBeNull()
    // A credential id written where an account id was read passes through.
    expect(await read(anthropic.id)).toBe(anthropic.id)
  })

  it("resolves the same managed:anthropic to each owner's own credential", async () => {
    store = await openTestStore(':memory:')
    const s = store
    const alices = await s.credentials.insert({
      ownerUserId: ALICE,
      label: 'Alice',
      type: 'anthropic.api-key',
      legacyKey: 'managed:anthropic',
    })
    const bobs = await s.credentials.insert({
      ownerUserId: BOB,
      label: 'Bob',
      type: 'anthropic.api-key',
      legacyKey: 'managed:anthropic',
    })
    expect(await credentialIdFromLegacy(s, 'managed:anthropic', ALICE)).toBe(alices.id)
    expect(await credentialIdFromLegacy(s, 'managed:anthropic', BOB)).toBe(bobs.id)
  })
})

/**
 * POD-6937: with no key of their own, an old stored-connection id meant the key
 * another member shared with them, picked as the old own-then-shared read did
 * (`managedKeyFor` at credential-epic-base): among other members' rows of that
 * id or its `:earlier-workspace` alias shared with the person, the oldest by
 * the row's `created_at`, then its id. Shared now means a grant `mayUse` reads.
 */
describe('credentialIdFromLegacy: a key another member shared', () => {
  async function member(s: SessionStore, id: UserId) {
    await memberFacts(s).create(
      {
        id,
        displayName: id,
        email: null,
        role: 'member',
        createdAt: '2026-11-13T00:00:00.000Z',
        disabledAt: null,
      },
      'not-a-real-hash',
    )
  }

  /**
   * The credential the import made of an old `accounts` row. Its creation time
   * stands for the row's: the destruction of the old plaintext copies the row's
   * onto it before the row goes (`store/legacy-plaintext.test.ts` pins that), so
   * the old order is read from the credentials. Each is made a little after the
   * one before, so times do not tie.
   */
  async function imported(s: SessionStore, owner: UserId, accountKey: string) {
    await new Promise((done) => setTimeout(done, 3))
    return await s.credentials.insert({
      ownerUserId: owner,
      label: `${owner} ${accountKey}`,
      type: 'anthropic.api-key',
      legacyId: `${accountKey}@${owner}`,
      legacyKey: accountKey,
    })
  }

  const share = (s: SessionStore, id: string, owner: UserId, grantee: string) =>
    s.grants.upsert({
      resourceKind: CREDENTIAL_RESOURCE_KIND,
      resourceId: id,
      grantee,
      verb: 'use',
      owner,
      visibility: 'secret',
      createdAt: '2026-11-13T00:00:00.000Z',
      actorKind: 'system',
      actorId: null,
      onBehalfOf: owner,
    })

  it('takes the oldest shared key in the old order, then the next, then none', async () => {
    store = await openTestStore(':memory:')
    const s = store
    for (const id of [ALICE, BOB, CAROL, DAVE]) await member(s, id)
    // The old rows' order: Alice's, then Carol's, then Dave's.
    const alices = await imported(s, ALICE, 'managed:anthropic')
    const carols = await imported(s, CAROL, 'managed:anthropic:earlier-workspace')
    const daves = await imported(s, DAVE, 'managed:anthropic')
    await share(s, carols.id, CAROL, BOB)
    await share(s, daves.id, DAVE, ALL_MEMBERS_GRANTEE)
    const read = () => credentialIdFromLegacy(s, 'managed:anthropic', BOB)

    // Alice's is the oldest but not shared with Bob; Carol's earlier-workspace
    // key counts under the plain id, as it did, and is older than Dave's.
    expect(await read()).toBe(carols.id)
    // Carol unshares: the next shared key in the order, Dave's (shared with all).
    expect(await s.grants.remove(CREDENTIAL_RESOURCE_KIND, carols.id, BOB, 'use')).toBe(true)
    expect(await read()).toBe(daves.id)
    // Dave removes his: a revoked credential is no candidate, and Alice's was
    // never shared, so the id names nothing (the launch refuses not-found).
    await s.credentials.remove(daves.id)
    expect(await read()).toBeNull()
    // The owner's own key always comes first, shared keys or not.
    await share(s, alices.id, ALICE, BOB)
    expect(await read()).toBe(alices.id)
    const bobs = await imported(s, BOB, 'managed:anthropic')
    expect(await read()).toBe(bobs.id)
    // Alice's own id still names her own key.
    expect(await credentialIdFromLegacy(s, 'managed:anthropic', ALICE)).toBe(alices.id)
  })

  it('a shared earlier-workspace id reaches only keys of that id', async () => {
    store = await openTestStore(':memory:')
    const s = store
    for (const id of [ALICE, BOB]) await member(s, id)
    const plain = await imported(s, ALICE, 'managed:anthropic')
    await share(s, plain.id, ALICE, BOB)
    expect(await credentialIdFromLegacy(s, 'managed:anthropic:earlier-workspace', BOB)).toBeNull()
    const earlier = await imported(s, ALICE, 'managed:anthropic:earlier-workspace')
    await share(s, earlier.id, ALICE, BOB)
    expect(await credentialIdFromLegacy(s, 'managed:anthropic:earlier-workspace', BOB)).toBe(
      earlier.id,
    )
  })
})
