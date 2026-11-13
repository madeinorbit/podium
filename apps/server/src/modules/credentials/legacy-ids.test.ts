/** Old account ids resolve to what they meant (review focus 4). */

import { asUserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { credentialIdFromLegacy } from './legacy-ids'

const ALICE = asUserId('user:legacy-alice')
const BOB = asUserId('user:legacy-bob')

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
