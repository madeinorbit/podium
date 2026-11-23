/** Password sign-in and sign-out (specification, sections 2.4, 7.2 and 13.4). */
import type { Credentials } from './credentials'
import type { Configuration, Runtime } from './runtime'
import { inGeneratedDomain, normaliseEmail, sha256Hex } from './secrets'
import {
  accountByEmail,
  deleteEarlierSignInsOfDevice,
  firstGeneratedPasswordAccounts,
  firstPasswordAccounts,
} from './statements'
import type { ConnectionFacts, IssuedSignIn, SignInOperations, SignInRefusal } from './types'

/** The key of a sign-in that sent no email. No address's key can equal it. */
const NO_EMAIL_KEY = '\u0000no-email'

/** What one lockout layer allows before it locks a key, and how much it keeps. */
export interface LockoutLimits {
  /** Failures that lock the key. */
  maxFailures: number
  /** How long a lock lasts. */
  lockMs: number
  /** Failures older than this no longer count; Infinity: they count until cleared. */
  windowMs: number
  /** Keys with failures but no lock. The oldest makes room for a new one. */
  maxCounts: number
  /** Live locks. A live lock is never evicted. */
  maxLocks: number
}

/**
 * Eight failures lock an identifier for five minutes. Every typed address
 * counts the same way, whether or not it belongs to anybody, so the throttle
 * says nothing about who is a member.
 *
 * This layer must hold alone: a source can be unknown, or shared by every
 * client behind a proxy. Each failure it counts has cost one password
 * verification (finding F4), so filling 100,000 locks and then 20,000 holds
 * takes nearly a million verifications inside five minutes, far beyond what a
 * server's hashing can do. Only past that is a new identifier left uncounted
 * until a lock ends; no other identifier is ever refused for it.
 */
export const IDENTIFIER_LIMITS: LockoutLimits = {
  maxFailures: 8,
  lockMs: 5 * 60_000,
  windowMs: Number.POSITIVE_INFINITY,
  maxCounts: 20_000,
  maxLocks: 100_000,
}

/**
 * Thirty failures in five minutes lock a known source address for five
 * minutes, so one source can lock at most three identifiers per window and
 * cannot spend the server's hashing on thousands of addresses. It needs a
 * source that is one client: an unknown source (null) is not budgeted.
 */
export const SOURCE_LIMITS: LockoutLimits = {
  maxFailures: 30,
  lockMs: 5 * 60_000,
  windowMs: 5 * 60_000,
  maxCounts: 10_000,
  maxLocks: 50_000,
}

interface Count {
  failures: number
  since: number
  /** A lock kept in the count while the lock table is full; 0: none. */
  heldUntil: number
}

/**
 * One in-memory lockout layer: failures per key, and locks that end on their
 * own. Locks are kept apart from the failure counts.
 *
 * - A live lock is never evicted, so churn through other keys cannot lift it
 *   (POD-6754 finding F1). Only failure counts make room for new keys.
 * - A full layer never refuses a key it has not locked, so filling it denies
 *   nobody else. When the lock table is full, a key that reaches its limit is
 *   held in its count instead: refused itself, and not evicted while held.
 * - Memory is bounded by `maxCounts` and `maxLocks`. When every count is a live
 *   hold too, a new key is not counted until one ends.
 */
export class Lockouts {
  /** Failures of keys without a lock, oldest first. */
  private readonly counts = new Map<string, Count>()
  /** When each locked key may try again. */
  private readonly locks = new Map<string, number>()

  constructor(private readonly limits: LockoutLimits) {}

  /** Seconds until the key may try again, or 0. */
  lockedFor(key: string, now: number): number {
    const lockedUntil = this.locks.get(key)
    if (lockedUntil !== undefined) {
      if (lockedUntil > now) return secondsUntil(lockedUntil, now)
      this.locks.delete(key)
      return 0
    }
    const heldUntil = this.counts.get(key)?.heldUntil ?? 0
    return heldUntil > now ? secondsUntil(heldUntil, now) : 0
  }

  failed(key: string, now: number): void {
    if (this.lockedFor(key, now) > 0) return
    const current = this.counts.get(key)
    // A hold that ended, like an ended lock, leaves a fresh budget.
    const counted =
      current && current.heldUntil === 0 && now - current.since < this.limits.windowMs
        ? current
        : undefined
    const failures = (counted?.failures ?? 0) + 1
    let heldUntil = 0
    if (failures >= this.limits.maxFailures) {
      this.endLocks(now)
      if (this.locks.size < this.limits.maxLocks) {
        this.counts.delete(key)
        this.locks.set(key, now + this.limits.lockMs)
        return
      }
      heldUntil = now + this.limits.lockMs
    }
    if (!current && this.counts.size >= this.limits.maxCounts && !this.makeRoom(now)) return
    this.counts.set(key, { failures, since: counted?.since ?? now, heldUntil })
  }

  cleared(key: string): void {
    this.counts.delete(key)
    this.locks.delete(key)
  }

  get size(): { counts: number; locks: number } {
    return { counts: this.counts.size, locks: this.locks.size }
  }

  /** Drops the oldest count that is not a live hold. False when every count is one. */
  private makeRoom(now: number): boolean {
    for (const [key, count] of this.counts) {
      if (count.heldUntil > now) continue
      this.counts.delete(key)
      return true
    }
    return false
  }

  /** Drops the locks that ended. Locks are set in time order, so the scan stops at a live one. */
  private endLocks(now: number): void {
    for (const [key, lockedUntil] of this.locks) {
      if (lockedUntil > now) return
      this.locks.delete(key)
    }
  }
}

function secondsUntil(until: number, now: number): number {
  return Math.ceil((until - now) / 1000)
}

/**
 * The key of a source address. An IPv6 client is free to use any address in
 * its /64, so the /64 is the source; IPv4 and anything unreadable count whole.
 */
export function sourceKeyOf(address: string): string {
  const bare = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
  if (!bare.includes(':') || bare.includes('.')) return bare.slice(0, 64)
  const halves = bare.split('::')
  if (halves.length > 2) return bare.slice(0, 64)
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return bare.slice(0, 64)
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail]
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return bare.slice(0, 64)
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`
}

/**
 * The sign-in budget, two layers deep. Each identifier has eight failures,
 * then five minutes' lock. Each known source address has thirty failures in
 * five minutes, which caps how many identifier locks one source can make. A
 * refusal for either layer names only the identifier or source that earned it.
 * In memory, per process.
 */
export class SignInThrottle {
  private readonly identifiers: Lockouts
  private readonly sources: Lockouts

  constructor(
    limits: { identifier?: Partial<LockoutLimits>; source?: Partial<LockoutLimits> } = {},
  ) {
    this.identifiers = new Lockouts({ ...IDENTIFIER_LIMITS, ...limits.identifier })
    this.sources = new Lockouts({ ...SOURCE_LIMITS, ...limits.source })
  }

  /** Seconds until this identifier from this source may try again, or 0. */
  lockedFor(identifier: string, source: string | null, now: number): number {
    const sourceKey = budgetedSource(source)
    const fromSource = sourceKey === undefined ? 0 : this.sources.lockedFor(sourceKey, now)
    return Math.max(fromSource, this.identifiers.lockedFor(identifierKeyOf(identifier), now))
  }

  failed(identifier: string, source: string | null, now: number): void {
    const sourceKey = budgetedSource(source)
    if (sourceKey !== undefined) this.sources.failed(sourceKey, now)
    this.identifiers.failed(identifierKeyOf(identifier), now)
  }

  /** A success clears the identifier, never the source: one good sign-in buys no guesses. */
  succeeded(identifier: string): void {
    this.identifiers.cleared(identifierKeyOf(identifier))
  }

  get size(): {
    identifiers: { counts: number; locks: number }
    sources: { counts: number; locks: number }
  } {
    return { identifiers: this.identifiers.size, sources: this.sources.size }
  }
}

/**
 * The source key a failure is charged to, or undefined for none. A loopback
 * source is not budgeted: behind a reverse proxy on this machine with no
 * trusted hop configured, every client arrives from loopback, and locking that
 * one source would lock everybody out.
 */
function budgetedSource(source: string | null): string | undefined {
  if (source === null) return undefined
  const bare = source
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  const loopback =
    bare.startsWith('127.') ||
    bare.startsWith('::ffff:127.') ||
    bare === '::1' ||
    bare === '0:0:0:0:0:0:0:1'
  return loopback ? undefined : sourceKeyOf(source)
}

/** A fixed-size key (128 bits of a hash), so a long typed address costs no more memory than a short one. */
function identifierKeyOf(identifier: string): string {
  return identifier === NO_EMAIL_KEY ? identifier : sha256Hex(identifier).slice(0, 32)
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

  /**
   * A refusal made before the library is asked costs one password
   * verification, as a wrong password for an active member does. Otherwise
   * the response time would tell an active member's address from any other
   * (POD-6754 finding F4). The hash is made once, on first use.
   */
  let equalWorkHash: Promise<string> | undefined
  async function verifyAgainstNothing(password: string): Promise<void> {
    equalWorkHash ??= runtime.hashPassword('podium: no account has this password')
    try {
      await runtime.verifyPassword(password, await equalWorkHash)
    } catch {
      // Only the time spent matters.
    }
  }

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
      // Older password managers saved the local member ID as the username.
      // Only an unmatched non-address can mean the sole password account;
      // a mistyped address or a server with several accounts stays refused.
      let legacyEmail: string | undefined
      if (typed !== undefined && !typed.includes('@')) {
        const [matched] = await accountByEmail(runtime.db()).run({ email: typed })
        if (!matched) {
          const accounts = await firstPasswordAccounts(runtime.db()).run({})
          if (accounts.length === 1) legacyEmail = accounts[0]?.email
        }
      }
      // All legacy usernames share the password-only budget, including failures.
      const key = legacyEmail === undefined ? (typed ?? NO_EMAIL_KEY) : NO_EMAIL_KEY
      const now = runtime.now().getTime()
      const source = facts.clientAddress
      const locked = throttle.lockedFor(key, source, now)
      if (locked > 0) return { refused: 'throttled', retryAfterSeconds: locked }
      const refuse = (): SignInRefusal => {
        throttle.failed(key, source, now)
        return { refused: 'invalid' }
      }
      /** A refusal before the library, after the same work as a wrong password. */
      const refuseEarly = async (): Promise<SignInRefusal> => {
        await verifyAgainstNothing(input.password)
        return refuse()
      }

      // An address in the reserved domain is never accepted as input.
      if (typed !== undefined && inGeneratedDomain(typed)) return refuseEarly()
      const email = legacyEmail ?? typed ?? (await identifierWithoutEmail())
      if (email === undefined) return refuseEarly()
      if (runtime.signInGate) {
        const [account] = await accountByEmail(runtime.db()).run({ email })
        if (!account || !(await runtime.signInGate(account.id))) return refuseEarly()
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
