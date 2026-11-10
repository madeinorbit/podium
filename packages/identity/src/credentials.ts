/**
 * From a request to the device sign-in and account its credential names
 * (specification, section 2.5, steps 1 to 3 and 6). One statement of the
 * package; the library is never called here.
 */
import {
  type Configuration,
  RENEW_AFTER_SECONDS,
  type Runtime,
  SIGN_IN_LIFE_SECONDS,
} from './runtime'
import { storedTokenForm, verifySignedToken } from './secrets'
import { type SignInRow, signInByToken, touchLastSeen } from './statements'
import type {
  ConnectionFacts,
  CredentialOperations,
  CredentialResolution,
  DeviceKind,
} from './types'

const LAST_SEEN_EVERY_MS = 5 * 60_000

function decoded(value: string): string {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const equals = part.indexOf('=')
    if (equals < 0) continue
    if (part.slice(0, equals).trim() === name) return decoded(part.slice(equals + 1).trim())
  }
  return undefined
}

/**
 * The signed value a request carries, and how. A bearer is read only over
 * HTTPS; a request that carries both a bearer and a cookie uses the bearer.
 */
export function candidateOf(
  request: Request,
  facts: ConnectionFacts,
  configuration: Configuration,
): { signed: string; by: 'bearer' | 'cookie' } | undefined {
  if (facts.scheme === 'https') {
    const authorization = request.headers.get('authorization')
    if (authorization && authorization.slice(0, 7).toLowerCase() === 'bearer ') {
      const value = authorization.slice(7).trim()
      if (value) return { signed: decoded(value), by: 'bearer' }
    }
  }
  const signed = cookieValue(request.headers.get('cookie'), configuration.cookie.name)
  return signed ? { signed, by: 'cookie' } : undefined
}

/** True when the library would renew this sign-in: it was last renewed more than a day ago. */
function renewDue(row: SignInRow, now: Date): boolean {
  if (row.fixedExpiry) return false
  const lastRenewed = row.expiresAt.getTime() - SIGN_IN_LIFE_SECONDS * 1000
  return lastRenewed + RENEW_AFTER_SECONDS * 1000 <= now.getTime()
}

export interface Credentials extends CredentialOperations {
  /** resolve(), with the way the credential arrived, for sign-out and renewal. */
  inspect(
    request: Request,
    facts: ConnectionFacts,
  ): Promise<{ resolution: CredentialResolution; by: 'bearer' | 'cookie' | null; fixed: boolean }>
}

export function credentialOperations(runtime: Runtime): Credentials {
  async function inspect(request: Request, facts: ConnectionFacts) {
    const none = (kind: 'unauthenticated' | 'https_required') => ({
      resolution: { kind } as CredentialResolution,
      by: null,
      fixed: false,
    })
    const configuration = runtime.configurationFor(facts)
    // Plain HTTP that is not same-machine is answered before anything is read.
    if (!configuration) return none('https_required')
    const candidate = candidateOf(request, facts, configuration)
    if (!candidate) return none('unauthenticated')
    // A value whose signature fails is treated as no credential.
    const token = verifySignedToken(candidate.signed, runtime.config.secret)
    if (!token) return none('unauthenticated')
    const now = runtime.now()
    const [row] = await signInByToken(runtime.db()).run({ token: storedTokenForm(token), now })
    if (!row) return none('unauthenticated')
    if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_EVERY_MS) {
      await touchLastSeen(runtime.db()).run({
        id: row.id,
        now,
        stale: new Date(now.getTime() - LAST_SEEN_EVERY_MS),
      })
    }
    const resolution: CredentialResolution = {
      kind: 'device-sign-in',
      accountId: row.accountId,
      deviceSignIn: { id: row.id, kind: row.kind as DeviceKind, expiresAt: row.expiresAt },
      renewDue: renewDue(row, now),
    }
    return { resolution, by: candidate.by, fixed: row.fixedExpiry }
  }

  return {
    inspect,
    async resolve(request, facts) {
      return (await inspect(request, facts)).resolution
    },
    async renew(request, facts) {
      const headers = new Headers()
      const { resolution, by, fixed } = await inspect(request, facts)
      // A sign-in with a fixed expiry is never handed to the library's session read.
      if (resolution.kind !== 'device-sign-in' || !resolution.renewDue || fixed) return headers
      const configuration = runtime.configurationFor(facts)
      if (!configuration) return headers
      const { response } = await runtime.callLibrary(configuration, {
        method: 'GET',
        path: '/get-session',
        facts,
        caller: request.headers,
      })
      // A bearer holder keeps its token; only the expiry moved.
      if (by === 'cookie') {
        for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie)
      }
      return headers
    },
  }
}
