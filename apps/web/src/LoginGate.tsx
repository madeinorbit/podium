import { Loader2, LockKeyhole } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

/** The host you're signing in to, shown for reassurance on a self-hosted install. */
function originHost(httpOrigin: string): string {
  try {
    return new URL(httpOrigin).host
  } catch {
    return ''
  }
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
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the field on mount (login is the only thing on screen), lint-cleanly (no autoFocus).
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

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

  const host = originHost(httpOrigin)

  return (
    <div className="relative flex min-h-svh w-full items-center justify-center overflow-hidden bg-background p-6">
      {/* Atmosphere: a single soft focused glow behind the card + a faint top wash. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="-translate-x-1/2 -translate-y-[58%] absolute top-1/2 left-1/2 size-[34rem] rounded-full bg-primary/[0.06] blur-[110px]" />
        <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-muted/40 to-transparent" />
      </div>

      <Card className="fade-in-0 slide-in-from-bottom-2 relative w-full max-w-sm animate-in overflow-hidden border-border/70 pt-8 shadow-2xl shadow-black/20 duration-500">
        {/* Hairline highlight along the top edge for a bit of depth. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-border to-transparent"
        />
        <CardHeader className="justify-items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-muted/40 text-foreground shadow-sm">
            <LockKeyhole className="size-5" strokeWidth={1.75} />
          </div>
          <div className="grid gap-1.5">
            <CardTitle className="font-heading text-lg tracking-tight">Welcome back</CardTitle>
            <CardDescription>Enter your password to continue.</CardDescription>
          </div>
        </CardHeader>

        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="podium-password" className="text-muted-foreground text-xs">
                Password
              </Label>
              <Input
                ref={inputRef}
                id="podium-password"
                type="password"
                autoComplete="current-password"
                className="h-10"
                aria-invalid={error ? true : undefined}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  if (error) setError(null)
                }}
              />
            </div>
            {error && (
              <p
                role="alert"
                className="fade-in-0 slide-in-from-top-1 animate-in text-[13px] text-destructive duration-200"
              >
                {error}
              </p>
            )}
            <Button
              type="submit"
              size="lg"
              className="mt-1 h-10 w-full"
              disabled={busy || !password}
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Signing in…
                </>
              ) : (
                'Log in'
              )}
            </Button>
          </form>
        </CardContent>

        {host && (
          <CardFooter className="justify-center border-border/60 border-t bg-muted/20 py-3.5">
            <p className="text-[11px] text-muted-foreground">
              Signing in to <span className="font-medium text-foreground/80">{host}</span>
            </p>
          </CardFooter>
        )}
      </Card>
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
