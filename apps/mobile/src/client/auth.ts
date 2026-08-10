/** REST auth client for the server's single-user password gate (/auth/*). */

export interface AuthStatus {
  needsAuth: boolean
  authed: boolean
  userId: string | null
}

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

export async function fetchAuthStatus(httpOrigin: string): Promise<AuthStatus> {
  const res = await fetch(httpOrigin + '/auth/status', {
    credentials: 'include',
    signal: timeoutSignal(AUTH_STATUS_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error('auth status failed: ' + res.status)
  const body = (await res.json()) as Partial<AuthStatus>
  return {
    needsAuth: body.needsAuth === true,
    authed: body.authed === true,
    userId: typeof body.userId === 'string' && body.userId.length > 0 ? body.userId : null,
  }
}

/** Returns null on success, or a human-readable error message. */
export async function login(httpOrigin: string, password: string): Promise<string | null> {
  const res = await fetch(httpOrigin + '/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (res.ok) return null
  if (res.status === 401) return 'Wrong password.'
  if (res.status === 429) return 'Too many attempts — try again in a few minutes.'
  return 'Login failed (' + res.status + ').'
}

export async function logout(httpOrigin: string): Promise<void> {
  await fetch(httpOrigin + '/auth/logout', { method: 'POST', credentials: 'include' })
}
