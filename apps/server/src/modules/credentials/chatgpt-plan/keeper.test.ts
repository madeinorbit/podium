/**
 * THE CHATGPT PLAN KEEPER (credential management §11 "Keeper"; epic Task 14,
 * acceptance 6, 7 and the revocation half of 9; review focus 3).
 *
 * A real store, vault and health service; OpenAI is the fake in
 * `fake-openai.ts`, and the clock is the test's. Every token is obviously fake.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asUserId,
  type CredentialId,
  firstAdminMemberId,
  primeFirstAdminMember,
} from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../../store'
import { newCredentialId } from '../../../store/credentials'
import { memberFacts } from '../../../store/fixtures/test-support'
import { openTestStore } from '../../../test-support/open-test-store'
import { CredentialRefusal } from '../../sessions/launch-config'
import { attentionNoticeKey, CredentialHealth, type CredentialNotice } from '../health'
import { sealCredentialSecret, withSecret } from '../vault'
import { CHATGPT_PLAN_TYPE } from './authorize'
import { FAKE_CLIENT_ID, fakeOpenAi, refreshInvalidated } from './fake-openai'
import { ChatgptPlanKeeper, RenewalUnavailable } from './keeper'
import { type ChatgptTokenSet, FINAL_REFRESH_ERRORS, parseTokenSet } from './openai'

const OWNER = asUserId('user:keeper-owner')
const T0 = Date.parse('2026-11-16T12:00:00Z')
const MIN = 60_000

describe('ChatgptPlanKeeper', () => {
  let store: SessionStore | undefined
  afterEach(async () => {
    await store?.close()
    store = undefined
  })

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'chatgpt-keeper-'))
    store = await openTestStore(join(dir, 'podium.db'), undefined, {
      vaultKeyFile: join(dir, 'vault.key'),
      // A store-level fixture with no change log attached (POD-6920), as health.test.
      changeCapture: 'whenLogAttaches',
    })
    primeFirstAdminMember(await firstAdminMemberId(store))
    for (const id of [OWNER]) {
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
    const s = store
    let now = T0
    const openai = fakeOpenAi({ now: () => now })
    const notices: CredentialNotice[] = []
    const health = new CredentialHealth({
      store: s,
      now: () => now,
      notices: {
        emit: async (n) => {
          notices.push(n)
        },
        resolve: async () => {},
      },
    })
    const pauses: number[] = []
    const keeper = new ChatgptPlanKeeper({
      store: s,
      fetch: openai.fetch,
      now: () => now,
      health,
      sleep: async (ms) => {
        pauses.push(ms)
      },
    })
    /** A signed-in credential whose access token expires `leftMs` from now. */
    const signedIn = async (leftMs: number): Promise<CredentialId> => {
      const id = newCredentialId()
      const set: ChatgptTokenSet = {
        seq: 1,
        clientId: FAKE_CLIENT_ID,
        accessToken: 'FAKE-access-token-original',
        refreshToken: 'FAKE-refresh-token-original',
        idToken: 'FAKE.id.token',
        expiresAt: now + leftMs,
        scopes: ['chatgpt.tokens.use.direct'],
        savedAt: now,
      }
      const sealed = await s.vault.seal(
        { credentialId: id, type: CHATGPT_PLAN_TYPE, version: 1 },
        Buffer.from(JSON.stringify(set)),
      )
      await s.credentials.insertWithSecret(
        { id, ownerUserId: OWNER, label: 'ChatGPT', type: CHATGPT_PLAN_TYPE },
        sealed,
      )
      return id
    }
    const stored = async (id: CredentialId) =>
      await withSecret(s, id, async (secret) => parseTokenSet(secret))
    return {
      store: s,
      openai,
      keeper,
      notices,
      pauses,
      signedIn,
      stored,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  describe('a token for a Codex session: a longer margin, with its expiry (epic Task 15)', () => {
    it('hands out the current token while it has the margin left', async () => {
      const { keeper, openai, signedIn } = await setup()
      const id = await signedIn(50 * MIN)
      expect(await keeper.issue(id, { minLeftMs: 40 * MIN })).toEqual({
        token: 'FAKE-access-token-original',
        expiresAt: T0 + 50 * MIN,
      })
      expect(openai.state.tokenForms).toHaveLength(0)
    })

    it('renews when less than the margin is left, though more than five minutes are', async () => {
      const { keeper, openai, signedIn } = await setup()
      const id = await signedIn(30 * MIN)
      expect(await keeper.issue(id, { minLeftMs: 40 * MIN })).toEqual({
        token: 'FAKE-access-token-1',
        expiresAt: T0 + 3600_000,
      })
      expect(openai.state.tokenForms).toHaveLength(1)
      // A model call in between needs only five minutes: no second renewal.
      expect(await keeper.accessToken(id)).toBe('FAKE-access-token-1')
      expect(openai.state.tokenForms).toHaveLength(1)
    })

    it('two sessions asking at once share one renewal', async () => {
      const { keeper, openai, signedIn } = await setup()
      const id = await signedIn(30 * MIN)
      const [a, b] = await Promise.all([
        keeper.issue(id, { minLeftMs: 40 * MIN }),
        keeper.issue(id, { minLeftMs: 40 * MIN }),
      ])
      expect(a).toEqual(b)
      expect(openai.state.tokenForms).toHaveLength(1)
    })
  })

  describe('acceptance 6: a fresh token, one renewal at a time', () => {
    it('returns a token with at least five minutes left without asking OpenAI', async () => {
      const { keeper, openai, signedIn } = await setup()
      const id = await signedIn(5 * MIN)
      expect(await keeper.accessToken(id)).toBe('FAKE-access-token-original')
      expect(openai.state.tokenForms).toHaveLength(0)
    })

    it('renews when fewer than five minutes are left, and stores the replaced renewal token', async () => {
      const { keeper, openai, signedIn, stored, store } = await setup()
      const id = await signedIn(5 * MIN - 1)
      expect(await keeper.accessToken(id)).toBe('FAKE-access-token-1')
      const form = openai.state.tokenForms[0]
      expect(form?.get('grant_type')).toBe('refresh_token')
      expect(form?.get('client_id')).toBe(FAKE_CLIENT_ID)
      expect(form?.get('refresh_token')).toBe('FAKE-refresh-token-original')
      expect(form?.get('resource')).toBe('https://api.openai.com/v1')
      expect(form?.has('scope')).toBe(false)
      expect(await stored(id)).toMatchObject({
        seq: 2,
        refreshToken: 'FAKE-refresh-token-1',
        expiresAt: T0 + 3600_000,
      })
      expect((await store.credentials.latestSecret(id))?.version).toBe(2)
    })

    it('two renewals started at once make one renewal request and store one token set', async () => {
      const { keeper, openai, signedIn, store } = await setup()
      const id = await signedIn(4 * MIN)
      const [a, b] = await Promise.all([keeper.accessToken(id), keeper.accessToken(id)])
      expect(a).toBe('FAKE-access-token-1')
      expect(b).toBe(a)
      expect(openai.state.tokenForms).toHaveLength(1)
      expect((await store.credentials.latestSecret(id))?.version).toBe(2)
    })

    it('a renewal that loses the version check reads the winner’s tokens', async () => {
      const { keeper, openai, signedIn, stored, store } = await setup()
      const id = await signedIn(4 * MIN)
      const winner: ChatgptTokenSet = {
        ...(await stored(id)),
        seq: 2,
        accessToken: 'FAKE-access-token-winner',
        refreshToken: 'FAKE-refresh-token-winner',
        expiresAt: T0 + 3600_000,
      }
      // Another renewer stores its set while this one waits for OpenAI.
      openai.state.beforeTokenAnswer = async () => {
        openai.state.beforeTokenAnswer = undefined
        const result = await sealCredentialSecret(
          store,
          { id, type: CHATGPT_PLAN_TYPE },
          JSON.stringify(winner),
          1,
        )
        expect(result).toBe(2)
      }
      expect(await keeper.accessToken(id)).toBe('FAKE-access-token-winner')
      expect(openai.state.tokenForms).toHaveLength(1)
      expect((await store.credentials.latestSecret(id))?.version).toBe(2)
      expect((await stored(id)).refreshToken).toBe('FAKE-refresh-token-winner')
    })
  })

  describe('acceptance 7: final and passing renewal errors', () => {
    const finals = [...FINAL_REFRESH_ERRORS].map((code) => ({
      name: `400 ${code}`,
      answer: () =>
        Response.json({ error: code }, { status: code === 'invalid_client' ? 401 : 400 }),
    }))
    finals.push({
      name: 'disconnected grant (refresh_token_invalidated)',
      answer: refreshInvalidated,
    })

    it.each(finals)('$name moves the credential to attention and raises one notice', async ({
      answer,
    }) => {
      const { keeper, openai, signedIn, store, notices } = await setup()
      const id = await signedIn(MIN)
      openai.state.tokenQueue.push(answer, answer)
      await expect(keeper.accessToken(id)).rejects.toBeInstanceOf(CredentialRefusal)
      const record = await store.credentials.get(id)
      expect(record?.status).toBe('attention')
      expect(record?.statusReason).toMatch(/Sign in with ChatGPT again/)
      expect(openai.state.tokenForms).toHaveLength(1) // not retried
      expect(notices.map((n) => n.dedupeKey)).toEqual([attentionNoticeKey(id)])
      // A second failing call raises no second notice.
      await expect(keeper.accessToken(id)).rejects.toBeInstanceOf(CredentialRefusal)
      expect(notices).toHaveLength(1)
    })

    it('a passing error (503) is retried and does not mark the credential', async () => {
      const { keeper, openai, signedIn, store, notices, pauses } = await setup()
      const id = await signedIn(4 * MIN)
      const unavailable = () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
      openai.state.tokenQueue.push(unavailable, unavailable)
      expect(await keeper.accessToken(id)).toBe('FAKE-access-token-1')
      expect(openai.state.tokenForms).toHaveLength(3)
      expect(pauses).toEqual([1_000, 4_000])
      expect((await store.credentials.get(id))?.status).toBe('ok')
      expect(notices).toHaveLength(0)
    })

    it('a passing error that outlasts the retries hands out the still-valid token, then fails without attention', async () => {
      const { keeper, openai, signedIn, store, notices, advance } = await setup()
      const id = await signedIn(4 * MIN)
      const down = () => new Response('bad gateway', { status: 502 })
      openai.state.tokenQueue.push(down, down, down)
      expect(await keeper.accessToken(id)).toBe('FAKE-access-token-original')
      advance(4 * MIN)
      openai.state.tokenQueue.push(down, down, down)
      await expect(keeper.accessToken(id)).rejects.toBeInstanceOf(RenewalUnavailable)
      expect((await store.credentials.get(id))?.status).toBe('ok')
      expect(notices).toHaveLength(0)
    })
  })

  describe('acceptance 9: revocation', () => {
    it('posts the renewal token with its hint and the issued client id; 200 is confirmed', async () => {
      const { keeper, openai, signedIn } = await setup()
      const id = await signedIn(30 * MIN)
      expect(await keeper.revoke(id)).toBe('confirmed')
      const form = openai.state.revokeForms[0]
      expect(form?.get('token')).toBe('FAKE-refresh-token-original')
      expect(form?.get('token_type_hint')).toBe('refresh_token')
      expect(form?.get('client_id')).toBe(FAKE_CLIENT_ID)
    })

    it('a 5xx is not confirmed, after one try: removal never waits on OpenAI', async () => {
      const { keeper, openai, signedIn, pauses } = await setup()
      const id = await signedIn(30 * MIN)
      openai.state.revokeStatus = 500
      expect(await keeper.revoke(id)).toBe('not-confirmed')
      expect(openai.state.revokeForms).toHaveLength(1)
      expect(pauses).toEqual([])
    })

    it('a revocation call that cannot reach OpenAI is not confirmed and does not throw', async () => {
      const { store, signedIn } = await setup()
      const id = await signedIn(30 * MIN)
      const unreachable = new ChatgptPlanKeeper({
        store,
        fetch: async () => {
          throw new TypeError('fetch failed (fake)')
        },
      })
      expect(await unreachable.revoke(id)).toBe('not-confirmed')
    })
  })
})
