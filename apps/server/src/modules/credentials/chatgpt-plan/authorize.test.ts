/**
 * SIGNING IN WITH A CHATGPT PLAN (credential management §11; epic Task 14,
 * acceptance 1, 2, 3, 5 and 10).
 *
 * A real store and vault; OpenAI is the fake in `fake-openai.ts`. Every token
 * is obviously fake, and each search for one first proves it can find it.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asUserId, firstAdminMemberId, primeFirstAdminMember } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../../../store'
import { memberFacts } from '../../../store/fixtures/test-support'
import { withSecret } from '../vault'
import {
  CHATGPT_PLAN_TYPE,
  CHATGPT_SIGN_IN_TTL_MS,
  type ChatgptCallback,
  ChatgptSignIn,
  PLAN_NOT_ENABLED_REASON,
  parseCallbackAddress,
  SignInRefused,
} from './authorize'
import { FAKE_ACCOUNT, FAKE_CLIENT_ID, fakeOpenAi } from './fake-openai'
import { parseTokenSet } from './openai'

const OWNER = asUserId('user:chatgpt-owner')
const OTHER = asUserId('user:chatgpt-other')
const HOST_ID =
  'urn:ietf:params:oauth:jwk-thumbprint:sha-256:FAKEhostThumbprint00000000000000000000000000'
const T0 = Date.parse('2026-11-16T12:00:00Z')

const rawDb = (store: SessionStore): SqlDatabase => (store as unknown as { db: SqlDatabase }).db
const rawRows = (store: SessionStore, table: string): string =>
  JSON.stringify(rawDb(store).prepare(`SELECT * FROM ${table}`).all())

describe('ChatGPT sign-in', () => {
  let store: SessionStore | undefined
  afterEach(async () => {
    await store?.close()
    store = undefined
  })

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'chatgpt-sign-in-'))
    store = await SessionStore.open(join(dir, 'podium.db'), undefined, {
      vaultKeyFile: join(dir, 'vault.key'),
    })
    primeFirstAdminMember(await firstAdminMemberId(store))
    for (const id of [OWNER, OTHER]) {
      await memberFacts(store).create(
        {
          id,
          displayName: id,
          role: 'member',
          createdAt: new Date(T0).toISOString(),
          disabledAt: null,
        },
        'not-a-real-hash',
      )
    }
    let now = T0
    const openai = fakeOpenAi({ now: () => now })
    const renewed: string[] = []
    const signIn = new ChatgptSignIn({
      store,
      hostId: async () => HOST_ID,
      fetch: openai.fetch,
      now: () => now,
      afterRenew: async (record) => {
        renewed.push(record.id)
      },
    })
    return {
      store,
      openai,
      signIn,
      renewed,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  /** Start an attempt and read back what the authorize address says. */
  async function begin(
    signIn: ChatgptSignIn,
    openai: ReturnType<typeof fakeOpenAi>,
    extra: { credentialId?: Parameters<ChatgptSignIn['start']>[0]['credentialId'] } = {},
  ) {
    const started = await signIn.start({ ownerUserId: OWNER, port: 1455, ...extra })
    const url = new URL(started.authorizeUrl)
    openai.state.nonce = url.searchParams.get('nonce') ?? ''
    return { ...started, url, state: url.searchParams.get('state') ?? '' }
  }

  const callback = (state: string, more: Partial<ChatgptCallback> = {}): ChatgptCallback => ({
    code: 'FAKE-code-0001',
    state,
    clientId: FAKE_CLIENT_ID,
    scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
    ...more,
  })

  describe('acceptance 1: the authorize address', () => {
    it('has an S256 challenge, the scopes and resource exactly, a loopback return address and a state bound to the attempt; the verifier is not in the result', async () => {
      const { signIn, openai } = await setup()
      const first = await begin(signIn, openai)
      const q = first.url.searchParams
      expect(`${first.url.origin}${first.url.pathname}`).toBe(
        'https://auth.openai.com/api/accounts/authorize',
      )
      expect(q.get('code_challenge_method')).toBe('S256')
      expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(q.get('scope')).toBe(
        'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      )
      expect(q.get('resource')).toBe('https://api.openai.com/v1')
      expect(q.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback')
      expect(q.get('response_type')).toBe('code')
      expect(q.get('client_id')).toBe('dynamic_agent_client')
      expect(q.get('agent_name_hint')).toBe('Podium')
      expect(q.get('ext_agent_host_id')).toBe(HOST_ID)
      expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(q.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/)

      // The state is bound to this attempt: a second attempt has its own.
      const second = await begin(signIn, openai)
      expect(second.state).not.toBe(first.state)
      expect(second.attemptId).not.toBe(first.attemptId)

      // The verifier stays on the server: the result has two fields, and the
      // verifier the exchange later sends appears nowhere in them.
      expect(
        Object.keys(first)
          .filter((k) => k !== 'url' && k !== 'state')
          .sort(),
      ).toEqual(['attemptId', 'authorizeUrl'])
      await signIn.complete({
        attemptId: first.attemptId,
        callback: callback(first.state),
        actorUserId: OWNER,
      })
      const verifier = openai.state.tokenForms[0]?.get('code_verifier') ?? ''
      expect(verifier.length).toBeGreaterThanOrEqual(43) // canary: the exchange sent one
      expect(JSON.stringify({ a: first.attemptId, u: first.authorizeUrl })).not.toContain(verifier)
      expect(openai.state.tokenForms[0]?.get('redirect_uri')).toBe(
        'http://127.0.0.1:1455/auth/callback',
      )
      expect(openai.state.tokenForms[0]?.get('client_id')).toBe(FAKE_CLIENT_ID)
      expect(openai.state.tokenForms[0]?.get('resource')).toBe('https://api.openai.com/v1')
    })
  })

  /** The three checks, through whichever path delivers the callback. */
  const threeChecks = (via: 'relay' | 'paste') => {
    const deliver = (state: string, more: Partial<ChatgptCallback> = {}): ChatgptCallback => {
      const cb = callback(state, more)
      if (via === 'relay') return cb
      const address = new URL('http://127.0.0.1:1455/auth/callback')
      if (cb.code) address.searchParams.set('code', cb.code)
      if (cb.scope) address.searchParams.set('scope', cb.scope)
      if (cb.state) address.searchParams.set('state', cb.state)
      if (cb.clientId) address.searchParams.set('client_id', cb.clientId)
      const parsed = parseCallbackAddress(`  ${address.toString()}  `)
      if ('invalid' in parsed) throw new Error(parsed.invalid)
      return parsed
    }

    it('refuses a wrong state and leaves the attempt open', async () => {
      const { signIn, openai } = await setup()
      const a = await begin(signIn, openai)
      await expect(
        signIn.complete({
          attemptId: a.attemptId,
          callback: deliver('FAKE-not-the-state'),
          actorUserId: OWNER,
        }),
      ).rejects.toBeInstanceOf(SignInRefused)
      expect(openai.state.tokenForms).toHaveLength(0)
      expect(signIn.status(a.attemptId, OWNER)).toEqual({ state: 'waiting' })
      const done = await signIn.complete({
        attemptId: a.attemptId,
        callback: deliver(a.state),
        actorUserId: OWNER,
      })
      expect(done.state).toBe('signed-in')
    })

    it('refuses an attempt older than ten minutes', async () => {
      const { signIn, openai, advance } = await setup()
      const a = await begin(signIn, openai)
      advance(CHATGPT_SIGN_IN_TTL_MS + 1)
      await expect(
        signIn.complete({ attemptId: a.attemptId, callback: deliver(a.state), actorUserId: OWNER }),
      ).rejects.toThrow(/more than ten minutes/)
      expect(openai.state.tokenForms).toHaveLength(0)
    })

    it('cannot complete an attempt twice, even at the same moment', async () => {
      const { signIn, openai, store } = await setup()
      const a = await begin(signIn, openai)
      const both = await Promise.allSettled([
        signIn.complete({ attemptId: a.attemptId, callback: deliver(a.state), actorUserId: OWNER }),
        signIn.complete({ attemptId: a.attemptId, callback: deliver(a.state), actorUserId: OWNER }),
      ])
      expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
      await expect(
        signIn.complete({ attemptId: a.attemptId, callback: deliver(a.state), actorUserId: OWNER }),
      ).rejects.toThrow(/completed already/)
      expect(openai.state.tokenForms).toHaveLength(1)
      expect(await store.credentials.listVisibleTo(OWNER)).toHaveLength(1)
    })

    it('refuses another person completing the attempt', async () => {
      const { signIn, openai } = await setup()
      const a = await begin(signIn, openai)
      await expect(
        signIn.complete({ attemptId: a.attemptId, callback: deliver(a.state), actorUserId: OTHER }),
      ).rejects.toBeInstanceOf(SignInRefused)
    })
  }

  describe('acceptance 2: completion through the relay', () => threeChecks('relay'))
  describe('acceptance 3: completion through a pasted address', () => {
    threeChecks('paste')

    it('refuses a pasted address that is not the callback', () => {
      expect(parseCallbackAddress('not an address')).toHaveProperty('invalid')
      expect(parseCallbackAddress('https://chatgpt.com/settings')).toHaveProperty('invalid')
    })
  })

  describe('the callback and the ID token (POD-6894 §9 items 3–5)', () => {
    it('a first sign-in whose callback has no client id is an incomplete registration', async () => {
      const { signIn, openai, store } = await setup()
      const a = await begin(signIn, openai)
      const out = await signIn.complete({
        attemptId: a.attemptId,
        callback: callback(a.state, { clientId: undefined }),
        actorUserId: OWNER,
      })
      expect(out).toMatchObject({ state: 'failed', reason: expect.stringMatching(/registering/) })
      expect(openai.state.tokenForms).toHaveLength(0)
      expect(await store.credentials.listVisibleTo(OWNER)).toHaveLength(0)
    })

    it('an ID token for another nonce is refused and nothing is stored', async () => {
      const { signIn, openai, store } = await setup()
      const a = await begin(signIn, openai)
      openai.state.nonce = 'FAKE-other-nonce'
      const out = await signIn.complete({
        attemptId: a.attemptId,
        callback: callback(a.state),
        actorUserId: OWNER,
      })
      expect(out).toMatchObject({ state: 'failed', reason: expect.stringMatching(/sign-in/) })
      expect(await store.credentials.listVisibleTo(OWNER)).toHaveLength(0)
    })

    it('a cancelled sign-in stores nothing', async () => {
      const { signIn, openai } = await setup()
      const a = await begin(signIn, openai)
      const out = await signIn.complete({
        attemptId: a.attemptId,
        callback: { state: a.state, error: 'access_denied' },
        actorUserId: OWNER,
      })
      expect(out).toMatchObject({ state: 'failed', reason: expect.stringMatching(/cancelled/) })
    })

    it('scopes without plan use keep the sign-in and mark it as needing attention', async () => {
      const { signIn, openai, store } = await setup()
      openai.state.scope = 'email offline_access openid profile resource.invoke'
      const a = await begin(signIn, openai)
      const out = await signIn.complete({
        attemptId: a.attemptId,
        callback: callback(a.state),
        actorUserId: OWNER,
      })
      expect(out).toMatchObject({ state: 'signed-in', planEnabled: false })
      const [record] = await store.credentials.listVisibleTo(OWNER)
      expect(record?.status).toBe('attention')
      expect(record?.statusReason).toBe(PLAN_NOT_ENABLED_REASON)
    })

    it('a returning sign-in sends the stored client id, the ID token hint and no app name; another client id on the callback is refused', async () => {
      const { signIn, openai, store } = await setup()
      const a = await begin(signIn, openai)
      const first = await signIn.complete({
        attemptId: a.attemptId,
        callback: callback(a.state),
        actorUserId: OWNER,
      })
      if (first.state !== 'signed-in') throw new Error('first sign-in failed')
      const storedIdToken = await withSecret(
        store,
        first.credentialId,
        async (s) => parseTokenSet(s).idToken,
      )
      const again = await begin(signIn, openai, { credentialId: first.credentialId })
      const q = again.url.searchParams
      expect(q.get('client_id')).toBe(FAKE_CLIENT_ID)
      expect(q.get('agent_name_hint')).toBeNull()
      expect(q.get('ext_agent_host_id')).toBe(HOST_ID)
      expect(q.get('id_token_hint')).toBe(storedIdToken)
      const refused = await signIn.complete({
        attemptId: again.attemptId,
        callback: callback(again.state, { clientId: 'oaiapp_FAKEsomeOtherClient000000000000' }),
        actorUserId: OWNER,
      })
      expect(refused).toMatchObject({ state: 'failed', reason: expect.stringMatching(/different/) })
      expect((await store.credentials.latestSecret(first.credentialId))?.version).toBe(1)
    })
  })

  describe('acceptance 5: what is stored and shown', () => {
    it('the raw rows hold no token; the credential shows the email and claims no plan', async () => {
      const { signIn, openai, store } = await setup()
      const a = await begin(signIn, openai)
      const out = await signIn.complete({
        attemptId: a.attemptId,
        callback: callback(a.state),
        actorUserId: OWNER,
      })
      if (out.state !== 'signed-in') throw new Error('sign-in failed')
      const set = await withSecret(store, out.credentialId, async (s) => parseTokenSet(s))
      const planted = [set.accessToken, set.refreshToken, set.idToken]
      // Canary: the values are what the fake issued, and the search can find one.
      expect(set.accessToken).toBe('FAKE-access-token-1')
      expect(JSON.stringify({ planted })).toContain(set.refreshToken)
      for (const table of ['credentials', 'credential_secrets', 'settings_audit_events']) {
        const rows = rawRows(store, table)
        for (const secret of planted) expect(rows).not.toContain(secret)
      }
      const [record] = await store.credentials.listVisibleTo(OWNER)
      expect(record?.type).toBe(CHATGPT_PLAN_TYPE)
      expect(record?.identity.email).toBe(FAKE_ACCOUNT.email)
      expect(record?.identity.plan).toBeUndefined()
      expect(record?.status).toBe('ok')
      expect(record?.verifiedAt).toBeTruthy()
      expect(set).toMatchObject({ seq: 1, clientId: FAKE_CLIENT_ID, expiresAt: T0 + 3600_000 })
    })
  })

  describe('acceptance 10: signing in again with the same account', () => {
    it('updates the existing credential: same id, next version, no second credential', async () => {
      const { signIn, openai, store, renewed } = await setup()
      const a = await begin(signIn, openai)
      const first = await signIn.complete({
        attemptId: a.attemptId,
        callback: callback(a.state),
        actorUserId: OWNER,
      })
      if (first.state !== 'signed-in') throw new Error('first sign-in failed')
      await store.credentials.markAttention(first.credentialId, 'disconnected (fake)')
      const b = await begin(signIn, openai)
      const second = await signIn.complete({
        attemptId: b.attemptId,
        callback: callback(b.state, { clientId: 'oaiapp_FAKEsecondRegistration0000000000' }),
        actorUserId: OWNER,
      })
      expect(second).toMatchObject({
        state: 'signed-in',
        credentialId: first.credentialId,
        updated: true,
      })
      const listed = await store.credentials.listVisibleTo(OWNER)
      expect(listed).toHaveLength(1)
      expect(listed[0]?.status).toBe('ok')
      expect((await store.credentials.latestSecret(first.credentialId))?.version).toBe(2)
      const set = await withSecret(store, first.credentialId, async (s) => parseTokenSet(s))
      expect(set).toMatchObject({ seq: 2, clientId: 'oaiapp_FAKEsecondRegistration0000000000' })
      expect(renewed).toEqual([first.credentialId])
    })
  })
})
