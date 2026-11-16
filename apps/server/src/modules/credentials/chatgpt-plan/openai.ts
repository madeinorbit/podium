/**
 * OPENAI'S SIGN IN WITH CHATGPT, AS PODIUM CALLS IT (credential management §11;
 * measured end to end in POD-6894).
 *
 * The endpoints, the token set Podium keeps, and the three token-endpoint
 * calls: exchanging a code, renewing, revoking. Also the ID token check
 * (RS256 against OpenAI's published keys, issuer, audience, expiry, nonce).
 *
 * Nothing here logs or throws a token. Errors name OpenAI's error code, which
 * is no secret.
 */

import { createPublicKey, verify as verifySignature } from 'node:crypto'

export const OPENAI_AUTH_ISSUER = 'https://auth.openai.com'
export const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize'
export const OPENAI_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
export const OPENAI_REVOKE_URL = 'https://auth.openai.com/api/accounts/oauth/revoke'
export const OPENAI_JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json'
/** Where a person reviews what each app used of their plan, and its limits. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

/** The `resource` of every authorize, exchange and renewal. */
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'
/** Identity scopes, then plan use scopes (§11), exactly as sent. */
export const CHATGPT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct',
] as const
/** Without it the sign-in is kept and the plan is not usable for inference. */
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct'
/** The client id of a first registration. Never stored. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
/**
 * The app name sent at registration (`agent_name_hint`). Codex's
 * `initialize.clientInfo.name` must equal it (epic Task 15).
 */
export const CHATGPT_APP_NAME = 'Podium'
export const CHATGPT_CALLBACK_PATH = '/auth/callback'
/** The port OpenAI's documentation and the measurement used. */
export const CHATGPT_DEFAULT_PORT = 1455

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** What Podium seals in the vault for one ChatGPT plan credential. */
export interface ChatgptTokenSet {
  /** The vault version this set was sealed as, so a reader knows it without a second read. */
  seq: number
  /** The issued client id (`oaiapp_…`). */
  clientId: string
  accessToken: string
  refreshToken: string
  /** Retained for `id_token_hint` on a later sign-in. */
  idToken: string
  /** Epoch ms when the access token expires. */
  expiresAt: number
  scopes: string[]
  /** Epoch ms when this set was received. */
  savedAt: number
}

export function parseTokenSet(raw: string): ChatgptTokenSet {
  const value = JSON.parse(raw) as Partial<ChatgptTokenSet>
  if (
    typeof value.seq !== 'number' ||
    typeof value.clientId !== 'string' ||
    typeof value.accessToken !== 'string' ||
    typeof value.refreshToken !== 'string' ||
    typeof value.idToken !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    !Array.isArray(value.scopes) ||
    typeof value.savedAt !== 'number'
  ) {
    throw new Error('the stored ChatGPT sign-in is damaged')
  }
  return value as ChatgptTokenSet
}

/** A token endpoint answer, before it becomes a token set. */
export interface TokenAnswer {
  accessToken: string
  refreshToken: string
  idToken: string | undefined
  expiresInSec: number
  scopes: string[] | undefined
}

/** The token endpoint refused, with OpenAI's code; `status` 0 means it was not reached. */
export class OpenAiTokenError extends Error {
  override readonly name = 'OpenAiTokenError'
  constructor(
    readonly status: number,
    /** `error_reason` when present, else `error`; undefined when the body had none. */
    readonly code: string | undefined,
    /** `error` itself (`invalid_grant` alongside a reason). */
    readonly error: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

const TOKEN_TIMEOUT_MS = 20_000
/** Removal never waits on OpenAI longer than this (it goes on either way). */
export const REVOKE_TIMEOUT_MS = 5_000

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  form: Record<string, string>,
  timeoutMs = TOKEN_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const why = err instanceof Error ? err.name : 'network error'
    throw new OpenAiTokenError(0, undefined, undefined, `OpenAI could not be reached (${why}).`)
  }
}

async function tokenAnswer(res: Response): Promise<TokenAnswer> {
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    // An answer that is not JSON is judged by its status alone.
  }
  if (!res.ok) {
    const error = typeof body.error === 'string' ? body.error : undefined
    const reason = typeof body.error_reason === 'string' ? body.error_reason : undefined
    const code = reason ?? error
    throw new OpenAiTokenError(
      res.status,
      code,
      error,
      `OpenAI refused (HTTP ${res.status}${code ? `, ${code}` : ''}).`,
    )
  }
  const access = body.access_token
  const refresh = body.refresh_token
  if (typeof access !== 'string' || typeof refresh !== 'string') {
    throw new OpenAiTokenError(res.status, undefined, undefined, 'OpenAI answered without tokens.')
  }
  return {
    accessToken: access,
    refreshToken: refresh,
    idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
    expiresInSec: typeof body.expires_in === 'number' ? body.expires_in : 3600,
    scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : undefined,
  }
}

export async function exchangeCode(
  fetchImpl: FetchLike,
  i: { clientId: string; code: string; verifier: string; redirectUri: string },
): Promise<TokenAnswer> {
  return await tokenAnswer(
    await postForm(fetchImpl, OPENAI_TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: i.clientId,
      code: i.code,
      code_verifier: i.verifier,
      redirect_uri: i.redirectUri,
      resource: CHATGPT_RESOURCE,
    }),
  )
}

/** Renewal; `scope` is omitted so the grant keeps its scopes. */
export async function refreshTokens(
  fetchImpl: FetchLike,
  i: { clientId: string; refreshToken: string },
): Promise<TokenAnswer> {
  return await tokenAnswer(
    await postForm(fetchImpl, OPENAI_TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: i.clientId,
      refresh_token: i.refreshToken,
      resource: CHATGPT_RESOURCE,
    }),
  )
}

/**
 * Ends the renewable session. An empty 200 is success, also for a token that
 * was already invalid, so it proves nothing about the grant. Anything else,
 * including a network failure or no answer within five seconds, is "not
 * confirmed".
 */
export async function revokeRefreshToken(
  fetchImpl: FetchLike,
  i: { clientId: string; refreshToken: string },
): Promise<boolean> {
  try {
    const res = await postForm(
      fetchImpl,
      OPENAI_REVOKE_URL,
      { token: i.refreshToken, token_type_hint: 'refresh_token', client_id: i.clientId },
      REVOKE_TIMEOUT_MS,
    )
    return res.status === 200
  } catch {
    return false
  }
}

/** The renewal errors OpenAI lists as final: a fresh sign-in is required (§11). */
export const FINAL_REFRESH_ERRORS: ReadonlySet<string> = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
  'invalid_client',
])

/** Whether a renewal failure means the grant is gone (not worth retrying). */
export function isFinalRefreshError(err: unknown): boolean {
  if (!(err instanceof OpenAiTokenError)) return false
  return (
    (err.code !== undefined && FINAL_REFRESH_ERRORS.has(err.code)) ||
    (err.error !== undefined && FINAL_REFRESH_ERRORS.has(err.error))
  )
}

// ---------------------------------------------------------------------------
// The ID token
// ---------------------------------------------------------------------------

/** What a verified ID token says about the account. */
export interface ChatgptIdentity {
  subject: string
  email: string | undefined
  name: string | undefined
}

export class IdTokenError extends Error {
  override readonly name = 'IdTokenError'
}

interface Jwk {
  kid?: string
  kty?: string
  n?: string
  e?: string
  alg?: string
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new IdTokenError('The ID token from OpenAI is malformed.')
  }
}

/**
 * Check an ID token: RS256 signature by a key in OpenAI's JWKS, issuer,
 * audience = the issued client id, not expired, and the attempt's nonce.
 */
export async function verifyIdToken(
  fetchImpl: FetchLike,
  token: string,
  expect: { clientId: string; nonce: string; now: number },
): Promise<ChatgptIdentity> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new IdTokenError('The ID token from OpenAI is malformed.')
  const [h, p, s] = parts as [string, string, string]
  const header = decodeSegment(h)
  const claims = decodeSegment(p)
  if (header.alg !== 'RS256') throw new IdTokenError('The ID token is not signed with RS256.')
  let keys: Jwk[] = []
  try {
    const res = await fetchImpl(OPENAI_JWKS_URL, { signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) })
    if (res.ok) keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? []
  } catch {
    throw new IdTokenError('OpenAI’s signing keys could not be read. Try again.')
  }
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === 'RSA')
  if (!jwk) throw new IdTokenError('The ID token is signed with a key OpenAI does not publish.')
  const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })
  const valid = verifySignature(
    'RSA-SHA256',
    Buffer.from(`${h}.${p}`, 'utf8'),
    key,
    Buffer.from(s, 'base64url'),
  )
  if (!valid) throw new IdTokenError('The ID token signature does not verify.')
  if (claims.iss !== OPENAI_AUTH_ISSUER) throw new IdTokenError('The ID token has another issuer.')
  const aud = claims.aud
  const audiences = Array.isArray(aud) ? aud : [aud]
  if (!audiences.includes(expect.clientId)) {
    throw new IdTokenError('The ID token was issued to another client.')
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= expect.now) {
    throw new IdTokenError('The ID token has expired.')
  }
  if (claims.nonce !== expect.nonce) {
    throw new IdTokenError('The ID token does not belong to this sign-in.')
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new IdTokenError('The ID token names no account.')
  }
  return {
    subject: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    name: typeof claims.name === 'string' ? claims.name : undefined,
  }
}
