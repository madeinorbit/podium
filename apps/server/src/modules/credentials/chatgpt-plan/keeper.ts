/**
 * THE KEEPER OF A CHATGPT PLAN SIGN-IN (credential management §10 rule R3, §11
 * "Keeper"; epic Task 14, review focus 3).
 *
 * Podium's server is the one renewer of each ChatGPT sign-in. OpenAI replaces
 * the renewal token on every use, so two renewals of one sign-in must never
 * race: a renewal runs under a per-credential lock in this process, and the
 * new token set is stored with the vault's version check. A renewal that loses
 * that check (another writer stored first) discards its own answer and reads
 * the winner's tokens.
 *
 * `accessToken` returns a token with at least five minutes left, renewing
 * first when fewer are left. `earliest_refresh_at` is advisory (POD-6894: not
 * enforced), so the five-minute rule is the only one.
 *
 * A renewal error OpenAI lists as final (the grant is gone, e.g. the person
 * disconnected Podium in ChatGPT's settings) moves the credential to "needs
 * attention" and raises one notice through the health service. Anything else
 * (network, 5xx) is passing: retried, and never marks the credential.
 *
 * Every read of the token set goes through `withSecret`; nothing here logs a
 * token.
 */

import { createLogger } from '@podium/logger'
import type { CredentialId } from '@podium/model'
import { ACCESS_REFUSAL_MESSAGES } from '../access'
import { CredentialRefusal } from '../../sessions/launch-config'
import { type SecretDeps, SecretUnavailableError, sealCredentialSecret, withSecret } from '../vault'
import { CHATGPT_PLAN_TYPE } from './authorize'
import {
  type ChatgptTokenSet,
  type FetchLike,
  isFinalRefreshError,
  OpenAiTokenError,
  parseTokenSet,
  refreshTokens,
  revokeRefreshToken,
} from './openai'

const log = createLogger('server:chatgpt-plan')

/** A token handed out has at least this long left (acceptance 6). */
export const RENEW_WHEN_LEFT_MS = 5 * 60_000
/** A passing renewal failure is retried after these pauses. */
export const RENEW_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000]
/** An unrenewed token is still handed out on a passing failure while this much is left. */
const STILL_USABLE_MS = 30_000

/** What the keeper reports to the health service (`CredentialHealth.noteFailure`). */
export interface KeeperHealthPort {
  noteFailure(i: { credentialId: CredentialId; failure: 'rejected'; reason: string }): Promise<void>
}

export interface ChatgptPlanKeeperDeps {
  store: SecretDeps
  fetch?: FetchLike
  now?: () => number
  health?: KeeperHealthPort
  sleep?: (ms: number) => Promise<void>
  retryDelaysMs?: readonly number[]
}

/** Renewal failed for a passing reason and the current token is (nearly) spent. */
export class RenewalUnavailable extends Error {
  override readonly name = 'RenewalUnavailable'
}

export class ChatgptPlanKeeper {
  private readonly inflight = new Map<CredentialId, Promise<string>>()
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly retryDelays: readonly number[]

  constructor(private readonly deps: ChatgptPlanKeeperDeps) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init))
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.retryDelays = deps.retryDelaysMs ?? RENEW_RETRY_DELAYS_MS
  }

  /** The bound health service, set once it exists (the composition root builds it later). */
  set health(port: KeeperHealthPort | undefined) {
    this.deps.health = port
  }

  /**
   * An access token with at least five minutes left. Throws `CredentialRefusal`
   * when the credential cannot be read or its grant is gone, and
   * {@link RenewalUnavailable} when OpenAI could not be reached in time.
   */
  async accessToken(credentialId: CredentialId): Promise<string> {
    const current = await this.read(credentialId)
    if (current.expiresAt - this.now() >= RENEW_WHEN_LEFT_MS) return current.accessToken
    return await this.renew(credentialId)
  }

  /** Renew now unless a renewal of this credential is already running; then share it. */
  renew(credentialId: CredentialId): Promise<string> {
    const running = this.inflight.get(credentialId)
    if (running) return running
    const renewal = this.renewUnderLock(credentialId).finally(() => {
      this.inflight.delete(credentialId)
    })
    this.inflight.set(credentialId, renewal)
    return renewal
  }

  /**
   * End the renewable session at OpenAI. `confirmed` only on its empty 200;
   * a network failure or 5xx is retried, then reported as not confirmed. Never
   * throws: removal goes on either way.
   */
  async revoke(credentialId: CredentialId): Promise<'confirmed' | 'not-confirmed'> {
    let set: ChatgptTokenSet
    try {
      set = await this.read(credentialId)
    } catch {
      return 'not-confirmed'
    }
    for (let attempt = 0; ; attempt++) {
      if (
        await revokeRefreshToken(this.fetchImpl, {
          clientId: set.clientId,
          refreshToken: set.refreshToken,
        })
      ) {
        return 'confirmed'
      }
      const pause = this.retryDelays[attempt]
      if (pause === undefined) return 'not-confirmed'
      await this.sleep(pause)
    }
  }

  private async renewUnderLock(credentialId: CredentialId): Promise<string> {
    // Read again inside the lock: a renewal that just finished made this one moot.
    const set = await this.read(credentialId)
    if (set.expiresAt - this.now() >= RENEW_WHEN_LEFT_MS) return set.accessToken
    const record = { id: credentialId, type: CHATGPT_PLAN_TYPE }
    const answer = await this.refreshWithRetry(credentialId, set)
    if (typeof answer === 'string') return answer
    const savedAt = this.now()
    const next: ChatgptTokenSet = {
      seq: set.seq + 1,
      clientId: set.clientId,
      accessToken: answer.accessToken,
      refreshToken: answer.refreshToken,
      idToken: answer.idToken ?? set.idToken,
      expiresAt: savedAt + answer.expiresInSec * 1000,
      scopes: answer.scopes ?? set.scopes,
      savedAt,
    }
    const stored = await sealCredentialSecret(
      this.deps.store,
      record,
      JSON.stringify(next),
      set.seq,
    )
    if (stored === 'conflict') {
      // Another writer stored a newer set first: it is the one to use.
      return (await this.read(credentialId)).accessToken
    }
    return next.accessToken
  }

  /**
   * The renewal call. A final error marks the credential and refuses; a passing
   * one is retried, and after the last try the current token is handed out if
   * it is still usable (a string), else {@link RenewalUnavailable}.
   */
  private async refreshWithRetry(credentialId: CredentialId, set: ChatgptTokenSet) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await refreshTokens(this.fetchImpl, {
          clientId: set.clientId,
          refreshToken: set.refreshToken,
        })
      } catch (err) {
        if (isFinalRefreshError(err)) {
          const code = err instanceof OpenAiTokenError ? err.code : undefined
          await this.markRejected(
            credentialId,
            `OpenAI no longer accepts this ChatGPT sign-in${code ? ` (${code})` : ''}. Sign in with ChatGPT again.`,
          )
          throw new CredentialRefusal('needs-attention', ACCESS_REFUSAL_MESSAGES['needs-attention'])
        }
        const pause = this.retryDelays[attempt]
        if (pause === undefined) {
          log.warn('ChatGPT sign-in renewal failed for a passing reason', {
            credentialId,
            reason: err instanceof Error ? err.message : String(err),
          })
          if (set.expiresAt - this.now() > STILL_USABLE_MS) return set.accessToken
          throw new RenewalUnavailable(
            'OpenAI could not renew this ChatGPT sign-in just now. Try again in a minute.',
          )
        }
        await this.sleep(pause)
      }
    }
  }

  private async markRejected(credentialId: CredentialId, reason: string): Promise<void> {
    try {
      await this.deps.health?.noteFailure({ credentialId, failure: 'rejected', reason })
    } catch (err) {
      log.warn('could not record a final ChatGPT renewal failure', { err, credentialId })
    }
  }

  private async read(credentialId: CredentialId): Promise<ChatgptTokenSet> {
    try {
      return await withSecret(this.deps.store, credentialId, async (secret) =>
        parseTokenSet(secret),
      )
    } catch (err) {
      if (err instanceof SecretUnavailableError) {
        const refusal =
          err.reason === 'not-found' || err.reason === 'revoked' ? err.reason : 'needs-attention'
        throw new CredentialRefusal(refusal, ACCESS_REFUSAL_MESSAGES[refusal])
      }
      throw err
    }
  }
}
