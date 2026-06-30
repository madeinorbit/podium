import { type ReactNode, useEffect, useState } from 'react'
import { serverConfig } from './trpc'

type Phase = 'loading' | 'login' | 'ready'

/**
 * Ask the server whether a login is needed. Returns 'login' only when a password is set AND
 * this client isn't authed yet. A non-OK response or an unreachable/garbled backend resolves
 * to 'ready' so we never block the app on auth — a backend without the route can't need it,
 * and SetupGate owns the genuine "unreachable" UX (this gate sits outside it).
 */
async function probeAuth(httpOrigin: string): Promise<'login' | 'ready'> {
  const res = await fetch(`${httpOrigin}/auth/status`, { credentials: 'include' })
  if (!res.ok) return 'ready'
  let data: { needsAuth?: unknown; authed?: unknown }
  try {
    data = (await res.json()) as { needsAuth?: unknown; authed?: unknown }
  } catch {
    return 'ready'
  }
  return data.needsAuth === true && data.authed !== true ? 'login' : 'ready'
}

/** Single-user password prompt. On success the session cookie is set and `onLoggedIn` fires. */
export function LoginView({
  httpOrigin,
  onLoggedIn,
}: {
  httpOrigin: string
  onLoggedIn: () => void
}): ReactNode {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${httpOrigin}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        onLoggedIn()
        return
      }
      setError(
        res.status === 429
          ? 'Too many attempts. Wait a moment, then try again.'
          : 'Incorrect password.',
      )
    } catch {
      setError('Couldn’t reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setup-view">
      <h1>Podium</h1>
      <p>Enter your password to continue.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label htmlFor="podium-password">Password</label>
        <input
          id="podium-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy || !password}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </div>
  )
}

/**
 * Gates the app on the human-client login. Open mode (no password) and already-authed both
 * pass straight through; otherwise the password prompt is shown. Deliberately separate from
 * SetupGate so the two concerns (which deployment mode vs. who are you) stay decoupled — and
 * so this doesn't touch the setup-flow files. Wrap it OUTSIDE SetupGate: authenticate to the
 * server first, then resolve setup state.
 */
export function LoginGate({ children }: { children: ReactNode }): ReactNode {
  const [phase, setPhase] = useState<Phase>('loading')
  const httpOrigin = serverConfig(window.location).httpOrigin

  useEffect(() => {
    let alive = true
    probeAuth(httpOrigin)
      .then((p) => {
        if (alive) setPhase(p)
      })
      .catch(() => {
        if (alive) setPhase('ready')
      })
    return () => {
      alive = false
    }
  }, [httpOrigin])

  if (phase === 'loading') return null
  if (phase === 'login') {
    // Reload after login so the tRPC client + WebSocket re-establish carrying the cookie.
    return <LoginView httpOrigin={httpOrigin} onLoggedIn={() => window.location.reload()} />
  }
  return <>{children}</>
}
