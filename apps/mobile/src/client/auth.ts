import { UserId } from '@podium/model'
import { NativeClientLoginResponse } from '@podium/protocol'
import { Platform } from 'react-native'
import { bearerHeaders } from './trpc'
/** REST auth client for the server's single-user password gate (/auth/*). */

export interface AuthStatus {
  needsAuth: boolean
  authed: boolean
  userId: UserId | null
}

export class MobileAuthExpiredError extends Error {
  readonly kind = 'auth-expired' as const

  constructor() {
    super('This phone session has expired.')
    this.name = 'MobileAuthExpiredError'
  }
}

export type LiveAuthCheck =
  | { kind: 'valid'; status: AuthStatus }
  | { kind: 'expired'; status: AuthStatus }
  | { kind: 'unreachable'; cause: unknown }

/**
 * How long the status probe may hang before it counts as a failure (POD-712).
 *
 * `AuthGate` blocks the whole app on this one request and renders `null` while it
 * is outstanding, which the launch boundary shows as the wordmark splash. A
 * `fetch` that never settles — the ordinary shape of a phone on a marginal
 * connection, not an exotic case — therefore parked the app on the splash with
 * no error and no way forward. Failing is recoverable (the gate opens and the
 * connection banner takes over); hanging is not, so this bounds the wait.
 */
const AUTH_STATUS_TIMEOUT_MS = 10_000

/**
 * `AbortSignal.timeout` is Safari 16+. An older phone is exactly the device most
 * likely to be stuck here, so its absence must not turn the safety net into the
 * new failure — an undefined signal simply means the old unbounded behaviour.
 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined
}

export async function fetchAuthStatus(
  httpOrigin: string,
  bearer: string | null = null,
): Promise<AuthStatus> {
  const res = await fetch(httpOrigin + '/auth/status', {
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: bearerHeaders(bearer),
    signal: timeoutSignal(AUTH_STATUS_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error('auth status failed: ' + res.status)
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (
    body === null ||
    typeof body !== 'object' ||
    typeof body.needsAuth !== 'boolean' ||
    typeof body.authed !== 'boolean' ||
    !(
      body.userId === undefined ||
      body.userId === null ||
      (typeof body.userId === 'string' && body.userId.length > 0)
    )
  ) {
    throw new Error('auth status response was invalid')
  }
  return {
    needsAuth: body.needsAuth,
    authed: body.authed,
    userId:
      typeof body.userId === 'string' && body.userId.length > 0 ? UserId.parse(body.userId) : null,
  }
}

/**
 * Resolve a dropped live transport without guessing from a socket error. The
 * unauthenticated status endpoint is the authority for credential expiry; a
 * failed probe stays a network failure and leaves the local replica mounted.
 */
export async function checkLiveAuth(
  httpOrigin: string,
  bearer: string | null,
): Promise<LiveAuthCheck> {
  try {
    const status = await fetchAuthStatus(httpOrigin, bearer)
    return status.needsAuth && !status.authed
      ? { kind: 'expired', status }
      : { kind: 'valid', status }
  } catch (cause) {
    return { kind: 'unreachable', cause }
  }
}

export type LoginResult = { ok: true; bearer: string | null } | { ok: false; error: string }

/** Native asks for a device bearer; web keeps the existing HttpOnly cookie. */
export async function login(
  httpOrigin: string,
  password: string,
  device?: { id: string; name: string },
): Promise<LoginResult> {
  if (Platform.OS !== 'web' && !httpOrigin.startsWith('https://')) {
    return {
      ok: false,
      error: 'Native sign-in requires trusted HTTPS. No password was sent.',
    }
  }
  const res = await fetch(httpOrigin + '/auth/login', {
    method: 'POST',
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      password,
      ...(Platform.OS === 'web'
        ? {}
        : {
            delivery: 'native',
            deviceId: device?.id ?? 'mobile-manual-login',
            deviceName: device?.name ?? `${Platform.OS} phone`,
            platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'unknown',
          }),
    }),
  })
  if (res.ok) {
    if (Platform.OS === 'web') return { ok: true, bearer: null }
    const body = NativeClientLoginResponse.safeParse(await res.json().catch(() => ({})))
    if (!body.success) {
      return { ok: false, error: 'Server did not return a native session. Update the server.' }
    }
    return { ok: true, bearer: body.data.token }
  }
  if (res.status === 401) return { ok: false, error: 'Wrong password.' }
  if (res.status === 429)
    return { ok: false, error: 'Too many attempts — try again in a few minutes.' }
  return { ok: false, error: 'Login failed (' + res.status + ').' }
}

export async function logout(httpOrigin: string, bearer: string | null = null): Promise<void> {
  if (Platform.OS !== 'web' && bearer && !httpOrigin.startsWith('https://')) {
    throw new Error('refusing to send a bearer over cleartext HTTP')
  }
  const response = await fetch(httpOrigin + '/auth/logout', {
    method: 'POST',
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: bearerHeaders(bearer),
  })
  if (!response.ok) throw new Error(`logout failed: ${response.status}`)
}
