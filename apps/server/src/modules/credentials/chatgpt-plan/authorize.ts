/**
 * SIGNING IN TO PODIUM WITH A CHATGPT PLAN (credential management §11; epic
 * Task 14; measured in POD-6894).
 *
 * The server runs the whole OAuth flow except the browser step:
 *
 *  - START mints a fresh `state`, `nonce` and PKCE verifier for the attempt and
 *    keeps them here. The command's result is the attempt id and the authorize
 *    address; the verifier never leaves the server.
 *  - The browser returns to `http://127.0.0.1:<port>/auth/callback` on the
 *    person's own computer. A daemon listening there relays the callback's
 *    query fields (`oauthLoopbackCallback`), or the person pastes the address
 *    their browser ended on. Both reach COMPLETE with the same checks: the
 *    attempt is known and the person's own, younger than ten minutes, not
 *    completed before, and the `state` matches.
 *  - COMPLETE exchanges the code here, checks the ID token (signature, issuer,
 *    audience, expiry, nonce), and seals the token set in the vault. The token
 *    set never passes through a daemon or a client.
 *
 * A first sign-in registers Podium for that account (`dynamic_agent_client`,
 * the app name, this server's host id) and the callback returns the issued
 * client id. A later sign-in to the same credential sends the stored client id
 * and the retained ID token as `id_token_hint`; a callback naming another client
 * id is refused. Signing in again with an account that already has a credential
 * updates that credential (same id, next version).
 *
 * WHAT IS KEPT IN MEMORY. An attempt is a few random values that live for ten
 * minutes, not a copy of a table. A server restart loses the attempts in
 * flight; the person starts again.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { type CredentialId, type UserId, asCredentialId } from '@podium/model'
import type { SessionStore } from '../../../store'
import { type CredentialRecord, newCredentialId } from '../../../store/credentials'
import { recordCredentialEvent } from '../events'
import { credentialFingerprint } from '../fingerprint'
import { type SecretDeps, sealCredentialSecret, withSecret } from '../vault'
import {
  CHATGPT_APP_NAME,
  CHATGPT_CALLBACK_PATH,
  CHATGPT_PLAN_SCOPE,
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
  type ChatgptTokenSet,
  DYNAMIC_CLIENT_ID,
  exchangeCode,
  type FetchLike,
  IdTokenError,
  OPENAI_AUTHORIZE_URL,
  OpenAiTokenError,
  parseTokenSet,
  verifyIdToken,
} from './openai'

export const CHATGPT_PLAN_TYPE = 'openai.chatgpt-plan'
/** An attempt older than this is refused (acceptance 2). */
export const CHATGPT_SIGN_IN_TTL_MS = 10 * 60_000
/** A finished attempt's outcome stays readable this long for the screen that waits on it. */
const OUTCOME_KEPT_MS = 10 * 60_000

export const PLAN_NOT_ENABLED_REASON =
  'ChatGPT plan use is not enabled for Podium. Sign in again and allow Podium to use your plan.'

/** The query fields of the address the browser returned to. Never a token. */
export interface ChatgptCallback {
  code?: string | undefined
  state?: string | undefined
  clientId?: string | undefined
  scope?: string | undefined
  error?: string | undefined
  errorDescription?: string | undefined
}

export type ChatgptSignInStatus =
  | { state: 'waiting' }
  | {
      state: 'signed-in'
      credentialId: CredentialId
      label: string
      email?: string
      /** False: signed in, but the person did not allow plan use (§11). */
      planEnabled: boolean
      /** True when an existing credential of the same account was updated. */
      updated: boolean
    }
  | { state: 'failed'; reason: string }

/** Refused before anything was claimed: the attempt is unchanged. */
export class SignInRefused extends Error {
  override readonly name = 'SignInRefused'
}

/** Parse what a person pasted: the whole address their browser ended on. */
export function parseCallbackAddress(pasted: string): ChatgptCallback | { invalid: string } {
  let url: URL
  try {
    url = new URL(pasted.trim())
  } catch {
    return { invalid: 'That is not an address. Paste the whole address from the browser’s bar.' }
  }
  if (url.pathname !== CHATGPT_CALLBACK_PATH || url.searchParams.get('state') === null) {
    return {
      invalid:
        'That is not the address OpenAI sent you back to. It starts with http://127.0.0.1 and contains /auth/callback.',
    }
  }
  const q = url.searchParams
  const field = (name: string) => q.get(name) ?? undefined
  return {
    code: field('code'),
    state: field('state'),
    clientId: field('client_id'),
    scope: field('scope'),
    error: field('error'),
    errorDescription: field('error_description'),
  }
}

export type SignInStore = SecretDeps & Pick<SessionStore, 'secrets' | 'settingsAudit'>

export interface ChatgptSignInDeps {
  store: SignInStore
  /** This server's `ext_agent_host_id` (host-id.ts). */
  hostId: () => Promise<string>
  fetch?: FetchLike
  now?: () => number
  /** After a credential's secret is replaced: notices resolve, sessions restart (Task 13). */
  afterRenew?: (record: CredentialRecord) => Promise<void>
}

interface Attempt {
  id: string
  ownerUserId: UserId
  label: string | undefined
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  createdAt: number
  /** A sign-in again to an existing credential: its stored client id and the account. */
  returning?: { credentialId: CredentialId; clientId: string; fingerprint: string | undefined }
  phase: 'waiting' | 'completing' | 'done'
  outcome?: ChatgptSignInStatus
  doneAt?: number
}

const random = (bytes: number): string => randomBytes(bytes).toString('base64url')
const challengeOf = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url')

export class ChatgptSignIn {
  private readonly attempts = new Map<string, Attempt>()
  private readonly fetchImpl: FetchLike
  private readonly now: () => number

  constructor(private readonly deps: ChatgptSignInDeps) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init))
    this.now = deps.now ?? Date.now
  }

  /**
   * Begin an attempt whose browser step returns to `127.0.0.1:<port>`. With
   * `credentialId`, sign in again to that credential (its owner's, checked by
   * the caller) with its stored client id.
   */
  async start(i: {
    ownerUserId: UserId
    label?: string
    port: number
    credentialId?: CredentialId
  }): Promise<{ attemptId: string; authorizeUrl: string }> {
    this.prune()
    const returning = i.credentialId ? await this.returningOf(i.credentialId) : undefined
    const attempt: Attempt = {
      id: `chatgpt_${randomUUID()}`,
      ownerUserId: i.ownerUserId,
      label: i.label?.trim() || undefined,
      state: random(32),
      nonce: random(32),
      verifier: random(48),
      redirectUri: `http://127.0.0.1:${i.port}${CHATGPT_CALLBACK_PATH}`,
      createdAt: this.now(),
      phase: 'waiting',
      ...(returning ? { returning: returning.attempt } : {}),
    }
    const params = new URLSearchParams()
    params.set('client_id', returning ? returning.attempt.clientId : DYNAMIC_CLIENT_ID)
    if (!returning) params.set('agent_name_hint', CHATGPT_APP_NAME)
    params.set('ext_agent_host_id', await this.deps.hostId())
    if (returning?.idToken) params.set('id_token_hint', returning.idToken)
    params.set('response_type', 'code')
    params.set('redirect_uri', attempt.redirectUri)
    params.set('scope', CHATGPT_SCOPES.join(' '))
    params.set('resource', CHATGPT_RESOURCE)
    params.set('state', attempt.state)
    params.set('nonce', attempt.nonce)
    params.set('code_challenge_method', 'S256')
    params.set('code_challenge', challengeOf(attempt.verifier))
    this.attempts.set(attempt.id, attempt)
    return { attemptId: attempt.id, authorizeUrl: `${OPENAI_AUTHORIZE_URL}?${params.toString()}` }
  }

  /** Where an attempt stands, for its owner; unknown attempts read as failed. */
  status(attemptId: string, ownerUserId: UserId): ChatgptSignInStatus {
    this.prune()
    const attempt = this.attempts.get(attemptId)
    if (!attempt || attempt.ownerUserId !== ownerUserId) {
      return { state: 'failed', reason: 'This sign-in is not known any more. Start again.' }
    }
    if (attempt.outcome) return attempt.outcome
    if (this.now() - attempt.createdAt > CHATGPT_SIGN_IN_TTL_MS) {
      return { state: 'failed', reason: expiredReason }
    }
    return { state: 'waiting' }
  }

  /**
   * Complete an attempt from its callback. Throws {@link SignInRefused}, and
   * changes nothing, when the attempt is unknown, someone else's, expired,
   * already completed, or the `state` does not match. After that the attempt is
   * spent: a failure is its outcome.
   */
  async complete(i: {
    attemptId: string
    callback: ChatgptCallback
    actorUserId: UserId
  }): Promise<ChatgptSignInStatus> {
    const attempt = this.attempts.get(i.attemptId)
    if (!attempt || attempt.ownerUserId !== i.actorUserId) {
      throw new SignInRefused('This sign-in is not known any more. Start again.')
    }
    if (this.now() - attempt.createdAt > CHATGPT_SIGN_IN_TTL_MS) {
      throw new SignInRefused(expiredReason)
    }
    if (attempt.phase !== 'waiting') {
      throw new SignInRefused('This sign-in was completed already.')
    }
    if (!i.callback.state || i.callback.state !== attempt.state) {
      throw new SignInRefused(
        'That address belongs to another sign-in. Paste the address from the sign-in you just finished.',
      )
    }
    // Claimed before the first await: a relay and a paste cannot both complete it.
    attempt.phase = 'completing'
    let outcome: ChatgptSignInStatus
    try {
      outcome = await this.finish(attempt, i.callback)
    } catch (err) {
      outcome = { state: 'failed', reason: failureReason(err) }
    }
    attempt.phase = 'done'
    attempt.outcome = outcome
    attempt.doneAt = this.now()
    return outcome
  }

  private async finish(attempt: Attempt, callback: ChatgptCallback): Promise<ChatgptSignInStatus> {
    if (callback.error) {
      return {
        state: 'failed',
        reason:
          callback.error === 'access_denied'
            ? 'The sign-in was cancelled in the browser. Nothing was stored.'
            : `OpenAI ended the sign-in (${callback.error}). Nothing was stored.`,
      }
    }
    let clientId: string
    if (attempt.returning) {
      if (callback.clientId && callback.clientId !== attempt.returning.clientId) {
        return {
          state: 'failed',
          reason:
            'OpenAI returned a different app registration than this credential’s. Nothing was changed.',
        }
      }
      clientId = attempt.returning.clientId
    } else {
      if (!callback.clientId || callback.clientId === DYNAMIC_CLIENT_ID) {
        return {
          state: 'failed',
          reason: 'OpenAI did not finish registering Podium for this account. Start again.',
        }
      }
      clientId = callback.clientId
    }
    if (!callback.code) {
      return { state: 'failed', reason: 'The address has no sign-in code. Start again.' }
    }
    const tokens = await exchangeCode(this.fetchImpl, {
      clientId,
      code: callback.code,
      verifier: attempt.verifier,
      redirectUri: attempt.redirectUri,
    })
    if (!tokens.idToken) {
      return { state: 'failed', reason: 'OpenAI answered without an ID token. Start again.' }
    }
    const identity = await verifyIdToken(this.fetchImpl, tokens.idToken, {
      clientId,
      nonce: attempt.nonce,
      now: this.now(),
    })
    const fingerprint = credentialFingerprint(
      CHATGPT_PLAN_TYPE,
      identity.subject,
      await this.deps.store.secrets.fingerprintKey(),
    )
    if (attempt.returning?.fingerprint && attempt.returning.fingerprint !== fingerprint) {
      return {
        state: 'failed',
        reason:
          'You signed in with a different ChatGPT account than this credential’s. Nothing was changed.',
      }
    }
    const scopes = tokens.scopes ?? callback.scope?.split(/\s+/).filter(Boolean) ?? []
    const planEnabled = scopes.includes(CHATGPT_PLAN_SCOPE)
    const savedAt = this.now()
    const set = (seq: number): ChatgptTokenSet => ({
      seq,
      clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken as string,
      expiresAt: savedAt + tokens.expiresInSec * 1000,
      scopes,
      savedAt,
    })
    const store = this.deps.store
    const existing = attempt.returning
      ? await store.credentials.get(attempt.returning.credentialId)
      : await store.credentials.findByIdentity({
          ownerUserId: attempt.ownerUserId,
          type: CHATGPT_PLAN_TYPE,
          fingerprint,
        })
    const ident = { fingerprint, ...(identity.email ? { email: identity.email } : {}) }
    if (existing && existing.status !== 'revoked') {
      await this.replaceSecret(existing, set)
      await store.credentials.setIdentity(existing.id, { ...existing.identity, ...ident })
      if (planEnabled) {
        if (existing.status !== 'ok') await store.credentials.setStatus(existing.id, 'ok')
      } else {
        await store.credentials.setStatus(existing.id, 'attention', PLAN_NOT_ENABLED_REASON)
      }
      await store.credentials.markVerified(existing.id, new Date(savedAt).toISOString())
      await recordCredentialEvent(store, {
        kind: 'renew',
        credentialId: existing.id,
        actorUserId: attempt.ownerUserId,
        detail: 'signed in with ChatGPT again',
      })
      if (planEnabled) await this.deps.afterRenew?.(existing)
      return {
        state: 'signed-in',
        credentialId: existing.id,
        label: existing.label,
        ...(identity.email ? { email: identity.email } : {}),
        planEnabled,
        updated: true,
      }
    }
    const id = newCredentialId()
    const label = attempt.label ?? (identity.email ? `ChatGPT (${identity.email})` : 'ChatGPT plan')
    const plaintext = Buffer.from(JSON.stringify(set(1)), 'utf8')
    try {
      const sealed = await store.vault.seal(
        { credentialId: id, type: CHATGPT_PLAN_TYPE, version: 1 },
        plaintext,
      )
      await store.credentials.insertWithSecret(
        { id, ownerUserId: attempt.ownerUserId, label, type: CHATGPT_PLAN_TYPE, identity: ident },
        sealed,
      )
    } finally {
      plaintext.fill(0)
    }
    await store.credentials.markVerified(id, new Date(savedAt).toISOString())
    if (!planEnabled) await store.credentials.markAttention(id, PLAN_NOT_ENABLED_REASON)
    await recordCredentialEvent(store, {
      kind: 'add',
      credentialId: id,
      actorUserId: attempt.ownerUserId,
      detail: CHATGPT_PLAN_TYPE,
    })
    return {
      state: 'signed-in',
      credentialId: id,
      label,
      ...(identity.email ? { email: identity.email } : {}),
      planEnabled,
      updated: false,
    }
  }

  /** Seal the new set as the next version; a concurrent renewal is simply overtaken. */
  private async replaceSecret(
    record: CredentialRecord,
    set: (seq: number) => ChatgptTokenSet,
  ): Promise<void> {
    for (let tries = 0; tries < 3; tries++) {
      const version = (await this.deps.store.credentials.latestSecret(record.id))?.version ?? 0
      const stored = await sealCredentialSecret(
        this.deps.store,
        record,
        JSON.stringify(set(version + 1)),
        version,
      )
      if (stored !== 'conflict') return
    }
    throw new Error('The credential kept changing while it was being signed in again.')
  }

  /** The stored client id, retained ID token and account of a credential to sign in again. */
  private async returningOf(credentialId: CredentialId): Promise<{
    attempt: NonNullable<Attempt['returning']>
    idToken: string | undefined
  }> {
    const record = await this.deps.store.credentials.get(asCredentialId(credentialId))
    if (!record || record.status === 'revoked' || record.type !== CHATGPT_PLAN_TYPE) {
      throw new SignInRefused('This credential is not a ChatGPT sign-in.')
    }
    try {
      return await withSecret(this.deps.store, record.id, async (secret) => {
        const set = parseTokenSet(secret)
        return {
          attempt: {
            credentialId: record.id,
            clientId: set.clientId,
            fingerprint: record.identity.fingerprint,
          },
          idToken: set.idToken,
        }
      })
    } catch {
      // The tokens are gone (vault reset): a new registration for the same account.
      throw new SignInRefused(
        'This sign-in’s stored registration cannot be read. Add the ChatGPT plan again.',
      )
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [id, attempt] of this.attempts) {
      const end = attempt.doneAt ?? attempt.createdAt + CHATGPT_SIGN_IN_TTL_MS
      if (now - end > OUTCOME_KEPT_MS) this.attempts.delete(id)
    }
  }
}

const expiredReason = 'This sign-in started more than ten minutes ago. Start again.'

function failureReason(err: unknown): string {
  if (err instanceof IdTokenError) return `${err.message} Nothing was stored.`
  if (err instanceof OpenAiTokenError) {
    return err.code === 'invalid_grant'
      ? 'OpenAI no longer accepts this sign-in code. Start again.'
      : `${err.message} Nothing was stored; start again.`
  }
  return 'The sign-in could not be finished. Nothing was stored; start again.'
}
