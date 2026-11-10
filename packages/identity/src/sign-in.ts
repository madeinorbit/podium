/** Password sign-in and sign-out (specification, sections 2.4, 7.2 and 13.4). */
import type { Credentials } from './credentials'
import type { Configuration, Runtime } from './runtime'
import { inGeneratedDomain, normaliseEmail } from './secrets'
import {
  accountByEmail,
  deleteEarlierSignInsOfDevice,
  firstGeneratedPasswordAccounts,
  firstPasswordAccounts,
} from './statements'
import type { ConnectionFacts, IssuedSignIn, SignInOperations, SignInRefusal } from './types'

const MAX_FAILURES = 8
const LOCK_MS = 5 * 60_000
const MAX_TRACKED = 10_000
/** The key of a sign-in that sent no email. No address can equal it. */
const NO_EMAIL_KEY = '\u0000no-email'

/**
 * The per-identifier budget: eight failures lock the identifier for five
 * minutes. In memory, per process; at most 10,000 identifiers are tracked.
 */
export class SignInThrottle {
  private readonly entries = new Map<string, { failures: number; lockedUntil: number }>()

  /** Seconds until the identifier may try again, or 0. */
  lockedFor(key: string, now: number): number {
    const entry = this.entries.get(key)
    if (!entry) return 0
    if (entry.lockedUntil > now) return Math.ceil((entry.lockedUntil - now) / 1000)
    if (entry.lockedUntil !== 0) this.entries.delete(key)
    return 0
  }

  failed(key: string, now: number): void {
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= MAX_TRACKED) this.evict(now)
      entry = { failures: 0, lockedUntil: 0 }
      this.entries.set(key, entry)
    }
    entry.failures += 1
    if (entry.failures >= MAX_FAILURES) entry.lockedUntil = now + LOCK_MS
  }

  succeeded(key: string): void {
    this.entries.delete(key)
  }

  /** Drops locks that ended, then the oldest entry, so the map never grows past its bound. */
  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) this.entries.delete(key)
    }
    if (this.entries.size < MAX_TRACKED) return
    const oldest = this.entries.keys().next().value
    if (oldest !== undefined) this.entries.delete(oldest)
  }
}

/** The session cookie the library set on a response, as the signed value. */
function signedValueOf(response: Response, configuration: Configuration): string | undefined {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0] ?? ''
    const equals = pair.indexOf('=')
    if (equals < 0 || pair.slice(0, equals).trim() !== configuration.cookie.name) continue
    const value = pair.slice(equals + 1).trim()
    return value.includes('%') ? decodeURIComponent(value) : value
  }
  return undefined
}

export function signInOperations(runtime: Runtime, credentials: Credentials): SignInOperations {
  const throttle = new SignInThrottle()

  /** Who a sign-in without an email means (section 7.2), or undefined. */
  async function identifierWithoutEmail(): Promise<string | undefined> {
    const withPassword = await firstPasswordAccounts(runtime.db()).run({})
    if (withPassword.length === 1) return withPassword[0]?.email
    const generated = await firstGeneratedPasswordAccounts(runtime.db()).run({})
    return generated.length === 1 ? generated[0]?.email : undefined
  }

  return {
    async prompt() {
      const withPassword = await firstPasswordAccounts(runtime.db()).run({})
      return withPassword.length === 1 ? 'password' : 'email-password'
    },

    async password(input, facts): Promise<IssuedSignIn | SignInRefusal> {
      const configuration = runtime.configurationFor(facts)
      // A bearer is only ever delivered over HTTPS.
      if (!configuration || (input.delivery === 'bearer' && facts.scheme !== 'https')) {
        return { refused: 'https_required' }
      }
      const typed = input.email === undefined ? undefined : normaliseEmail(input.email)
      const key = typed ?? NO_EMAIL_KEY
      const now = runtime.now().getTime()
      const locked = throttle.lockedFor(key, now)
      if (locked > 0) return { refused: 'throttled', retryAfterSeconds: locked }
      const refuse = (): SignInRefusal => {
        throttle.failed(key, now)
        return { refused: 'invalid' }
      }

      // An address in the reserved domain is never accepted as input.
      if (typed !== undefined && inGeneratedDomain(typed)) return refuse()
      const email = typed ?? (await identifierWithoutEmail())
      if (email === undefined) return refuse()
      if (runtime.signInGate) {
        const [account] = await accountByEmail(runtime.db()).run({ email })
        if (!account || !(await runtime.signInGate(account.id))) return refuse()
      }

      // The library's own handler, so its limiter and its checks run. It
      // verifies the password outside any transaction.
      const { response, created } = await runtime.callLibrary(configuration, {
        method: 'POST',
        path: '/sign-in/email',
        facts,
        body: { email, password: input.password },
        device: input.device,
      })
      if (response.status === 429) {
        const retry = Number(
          response.headers.get('x-retry-after') ?? response.headers.get('retry-after'),
        )
        return {
          refused: 'throttled',
          retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : 10,
        }
      }
      const signed = response.ok ? signedValueOf(response, configuration) : undefined
      if (!response.ok || !created || !signed) {
        if (response.status >= 500) {
          throw new Error(`identity: the sign-in library answered ${response.status}`)
        }
        return refuse()
      }
      throttle.succeeded(key)
      if (input.device.deviceId) {
        await deleteEarlierSignInsOfDevice(runtime.db()).run({
          accountId: created.accountId,
          deviceId: input.device.deviceId,
          except: created.id,
        })
      }
      const headers = new Headers()
      if (input.delivery === 'cookie') {
        for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie)
      }
      return {
        deviceSignInId: created.id,
        accountId: created.accountId,
        expiresAt: created.expiresAt,
        headers,
        bearer: input.delivery === 'bearer' ? signed : null,
      }
    },

    async signOut(request: Request, facts: ConnectionFacts) {
      const headers = new Headers()
      const configuration = runtime.configurationFor(facts)
      if (!configuration) return { deviceSignInId: null, headers }
      const { resolution } = await credentials.inspect(request, facts)
      // The library ends the one sign-in the request carries and clears its cookie.
      const { response } = await runtime.callLibrary(configuration, {
        method: 'POST',
        path: '/sign-out',
        facts,
        caller: request.headers,
        body: {},
      })
      for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie)
      return {
        deviceSignInId: resolution.kind === 'device-sign-in' ? resolution.deviceSignIn.id : null,
        headers,
      }
    },
  }
}
