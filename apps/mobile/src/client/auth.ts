/** REST auth client for the server's single-user password gate (/auth/*). */

export interface AuthStatus {
  needsAuth: boolean
  authed: boolean
}

export async function fetchAuthStatus(httpOrigin: string): Promise<AuthStatus> {
  const res = await fetch(httpOrigin + '/auth/status', { credentials: 'include' })
  if (!res.ok) throw new Error('auth status failed: ' + res.status)
  const body = (await res.json()) as Partial<AuthStatus>
  return { needsAuth: body.needsAuth === true, authed: body.authed === true }
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
