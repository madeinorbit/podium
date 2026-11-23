/**
 * A FAKE OPENAI SIGN-IN SERVER for tests (credential management §11).
 *
 * It answers the token, revocation and JWKS endpoints the way POD-6894
 * measured them, signs ID tokens with a throwaway RSA key, and records every
 * form it was sent. Every token it issues is obviously fake (`FAKE-…`).
 */

import { generateKeyPairSync, sign } from 'node:crypto'
import { OPENAI_AUTH_ISSUER, OPENAI_JWKS_URL, OPENAI_REVOKE_URL, OPENAI_TOKEN_URL } from './openai'

export interface FakeAccount {
  sub: string
  email: string
}

export const FAKE_ACCOUNT: FakeAccount = { sub: 'fake-subject-0001', email: 'person@example.test' }
export const FAKE_CLIENT_ID = 'oaiapp_FAKE0000000000000000000000000'

type Responder = (form: URLSearchParams) => Response | Promise<Response>

export function fakeOpenAi(opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = 'fake-key-1'
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }
  let issued = 0
  const state = {
    /** Every form posted to the token endpoint, in order. */
    tokenForms: [] as URLSearchParams[],
    revokeForms: [] as URLSearchParams[],
    /** The account the next code exchange signs in as. */
    account: FAKE_ACCOUNT,
    /** The nonce the next ID token carries (the test copies it from the authorize address). */
    nonce: '',
    /** Scopes the next answer grants. */
    scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
    expiresInSec: 3600,
    /** Replaces the default answer of the token endpoint once per entry. */
    tokenQueue: [] as Responder[],
    revokeStatus: 200,
    /** Called before the token endpoint answers (lets a test interleave a write). */
    beforeTokenAnswer: undefined as (() => Promise<void>) | undefined,
  }

  function idToken(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString(
      'base64url',
    )
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey)
    return `${header}.${body}.${signature.toString('base64url')}`
  }

  function tokens(clientId: string): Response {
    issued++
    const iat = Math.floor(now() / 1000)
    return Response.json({
      access_token: `FAKE-access-token-${issued}`,
      refresh_token: `FAKE-refresh-token-${issued}`,
      id_token: idToken({
        iss: OPENAI_AUTH_ISSUER,
        aud: clientId,
        sub: state.account.sub,
        email: state.account.email,
        nonce: state.nonce,
        iat,
        exp: iat + 3600,
      }),
      token_type: 'Bearer',
      expires_in: state.expiresInSec,
      earliest_refresh_at: iat + state.expiresInSec - 360,
      scope: state.scope,
    })
  }

  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === OPENAI_JWKS_URL) return Response.json({ keys: [jwk] })
    const form = new URLSearchParams(String(init?.body ?? ''))
    if (url === OPENAI_TOKEN_URL) {
      state.tokenForms.push(form)
      await state.beforeTokenAnswer?.()
      const queued = state.tokenQueue.shift()
      if (queued) return await queued(form)
      return tokens(form.get('client_id') ?? '')
    }
    if (url === OPENAI_REVOKE_URL) {
      state.revokeForms.push(form)
      return new Response('', { status: state.revokeStatus })
    }
    return new Response('not found', { status: 404 })
  }

  return { fetch, state, idToken, issuedCount: () => issued }
}

/** The answer OpenAI gives to a renewal after the person disconnected Podium (POD-6894 §7). */
export const refreshInvalidated = (): Response =>
  Response.json(
    {
      error: 'invalid_grant',
      error_reason: 'refresh_token_invalidated',
      error_description: 'The refresh token has been invalidated. A fresh sign-in is required.',
    },
    { status: 400 },
  )
