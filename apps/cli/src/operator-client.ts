/**
 * The direct (non-relay) issue client, carrying the operator's credential [POD-1376].
 *
 * Every `podium <verb>` module picks one of two transports: a constrained agent's calls
 * ride its daemon relay (which applies scope), and everything else talks to the local
 * server over tRPC. That second path used to send no credential at all, so on a
 * password-protected instance it failed on every call — reads and writes alike — with
 * "Unable to transform response from server", because the auth guard's 401 body is not a
 * tRPC envelope.
 *
 * One helper rather than eight call sites resolving the token themselves: the credential
 * lookup order (PODIUM_SESSION_TOKEN, then the state-dir cache) has to be identical for
 * `podium issue` and `podium mail` and the rest, or the operator would find some verbs
 * authenticated and others not.
 *
 * No credential is the correct, silent state on an instance with no password: the server's
 * clientAuthGuard passes those requests through untouched.
 */
import { type IssueTrpc, makeIssueClient } from '@podium/issue-client'
import { deviceSignInCookieName, SESSION_COOKIE } from '@podium/protocol'
import { loadConfig, stateDir } from '@podium/runtime/config'
import {
  isOldFormSessionToken,
  readCachedSessionToken,
  readOldFormSessionToken,
  saveCachedSessionToken,
} from '@podium/runtime/session-mint'

export function makeOperatorIssueClient(baseUrl: string): IssueTrpc {
  return makeIssueClient(baseUrl, {
    // Found when the first call is made: an old-form cache is exchanged then, once.
    sessionToken: () => operatorSessionToken(baseUrl),
    workspaceId: loadConfig().workspaceId,
  })
}

export const OLD_ENV_TOKEN_MESSAGE =
  'PODIUM_SESSION_TOKEN holds a session token from before the upgrade to shared sign-in. ' +
  'Such a token is no longer a credential and cannot be exchanged from an environment ' +
  'variable. Mint a new one with `podium auth mint-session`.'

export interface OperatorSessionDeps {
  env?: Record<string, string | undefined>
  /** The state directory that holds `cli-session.json`. */
  at?: string
  now?: () => number
  fetchImpl?: typeof fetch
}

// LEGACY(remove-after: 2027-06): the old-form cache exchange below (`readOldFormSessionToken`, `carryOldSession`, the PODIUM_SESSION_TOKEN refusal); removing it makes the host mint a new session once after an upgrade from before shared sign-in.
/**
 * The operator's credential for `baseUrl`: PODIUM_SESSION_TOKEN, then the cache.
 *
 * An old-form cache (a host session minted before shared sign-in) is exchanged
 * once at the server's status route for a signed device sign-in, and the cache
 * is rewritten in the new form (docs/design/sign-in-carry-over.md, section 6.1).
 */
export async function operatorSessionToken(
  baseUrl: string,
  deps: OperatorSessionDeps = {},
): Promise<string | undefined> {
  const env = deps.env ?? process.env
  const at = deps.at ?? stateDir()
  const now = deps.now ?? Date.now
  const fromEnv = env.PODIUM_SESSION_TOKEN?.trim()
  if (fromEnv) {
    // An old token here cannot be carried: the command has nowhere to keep the result.
    if (isOldFormSessionToken(fromEnv)) throw new Error(OLD_ENV_TOKEN_MESSAGE)
    return fromEnv
  }
  const cached = readCachedSessionToken(at, now)
  if (cached) return cached
  const old = readOldFormSessionToken(at, now)
  if (!old) return undefined
  return await carryOldSession(baseUrl, old, at, now, deps.fetchImpl ?? fetch)
}

/**
 * Asks `GET /auth/status` once with the old token as the old cookie. A server
 * that carries it answers with the cookie of a device sign-in; that value is
 * cached in the new form and returned. Anything else leaves the old file as
 * it is and answers "no credential": the 401 that follows names the fix.
 */
async function carryOldSession(
  baseUrl: string,
  old: { token: string; expiresAt: string },
  at: string,
  now: () => number,
  doFetch: typeof fetch,
): Promise<string | undefined> {
  const origin = new URL(baseUrl)
  // The same rule as for sending a sign-in: never over plain HTTP to another machine.
  const mayCarry =
    origin.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  if (!mayCarry) return undefined
  let response: Response
  try {
    response = await doFetch(new URL('/auth/status', origin), {
      headers: { cookie: `${SESSION_COOKIE}=${old.token}` },
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  const prefix = `${deviceSignInCookieName(origin.protocol)}=`
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(prefix))
  if (!cookie) return undefined
  const [pair = '', ...attributes] = cookie.split(';')
  let token: string
  try {
    token = decodeURIComponent(pair.slice(prefix.length))
  } catch {
    return undefined
  }
  if (!token) return undefined
  const maxAge = attributes
    .map((attribute) => /^\s*max-age=(\d+)\s*$/i.exec(attribute)?.[1])
    .find((seconds) => seconds !== undefined)
  // A carried host session keeps the expiry it had; the cookie's Max-Age says the same.
  const expiresAt =
    maxAge !== undefined ? new Date(now() + Number(maxAge) * 1000).toISOString() : old.expiresAt
  saveCachedSessionToken({ token, expiresAt }, at)
  return token
}
