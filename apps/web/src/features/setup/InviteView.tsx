import { type AuthCapabilities, accountPageUrl } from '@podium/client-core/accounts'
import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { webAuth } from '@/lib/accounts'
import { memberRequest } from './member-api'

export function InviteView({
  token,
  httpOrigin,
  onDone,
}: {
  token: string
  httpOrigin: string
  onDone: (completed?: boolean) => void | Promise<void>
}) {
  const formId = useId()
  const [capabilities, setCapabilities] = useState<AuthCapabilities>()
  const [kind, setKind] = useState<'invitation' | 'password-reset'>('invitation')
  const reset = kind === 'password-reset'
  const [email, setEmail] = useState('')
  const [fixedEmail, setFixedEmail] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    Promise.all([
      memberRequest<{ kind: 'invitation' | 'password-reset'; email: string | null }>(
        httpOrigin,
        'inspect',
        { token },
      ),
      webAuth.fetchAuthStatus(httpOrigin),
    ])
      .then(([invite, status]) => {
        if (!alive) return
        if (!status.capabilities) throw new Error('Sign-in options unavailable')
        setCapabilities(status.capabilities)
        setKind(invite.kind)
        setEmail(invite.email ?? '')
        setFixedEmail(Boolean(invite.email))
        setReady(true)
      })
      .catch(() => {
        if (alive) setError('This invite has expired, was revoked, or has already been used.')
      })
    return () => {
      alive = false
    }
  }, [httpOrigin, token])
  async function complete() {
    if (busy) return
    if (password !== confirm) {
      setError('Passwords don’t match.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await memberRequest(
        httpOrigin,
        'complete',
        reset ? { token, password } : { token, email, password, displayName: name },
      )
      setDone(true)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to accept invite')
    } finally {
      setBusy(false)
    }
  }
  if (ready && capabilities?.accountUrl)
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-sm space-y-4">
          <h1 className="text-xl font-semibold">
            {reset ? 'Reset your password' : 'Join this workspace'}
          </h1>
          <p>
            {reset
              ? 'Request a password reset email from your account.'
              : `Continue with your account to accept${email ? ` the invitation for ${email}` : ' this invitation'}.`}
          </p>
          <a
            className="underline"
            referrerPolicy="no-referrer"
            href={accountPageUrl(
              capabilities,
              reset ? 'forgot-password' : 'sign-in',
              window.location.pathname + window.location.search + window.location.hash,
            )}
          >
            {reset ? 'Reset password by email' : 'Continue to accept invitation'}
          </a>
        </section>
      </main>
    )
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">
          {done
            ? reset
              ? 'Password updated'
              : 'You’re a member'
            : reset
              ? 'Reset your password'
              : 'Join this workspace'}
        </h1>
        {done ? (
          <>
            <p>
              {reset
                ? 'Your password has changed. Your other devices are signed out.'
                : `Your password is ready. Sign in with ${email}.`}
            </p>
            {error && <p role="alert">{error}</p>}
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true)
                setError('')
                void Promise.resolve(onDone(true))
                  .catch(() => setError('Could not switch accounts. Try again.'))
                  .finally(() => setBusy(false))
              }}
            >
              Continue to sign in
            </Button>
          </>
        ) : (
          <>
            <p>
              {reset
                ? 'Choose a new password. This link works once.'
                : 'Set your password to accept the invitation.'}
            </p>
            {error && <p role="alert">{error}</p>}
            {!ready && error && <Button onClick={() => void onDone(false)}>Go to sign in</Button>}
            {ready && capabilities?.passwordSignIn && (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  void complete()
                }}
              >
                {!reset && (
                  <>
                    <label className="block" htmlFor={`${formId}-name`}>
                      Name
                      <Input
                        id={`${formId}-name`}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        maxLength={200}
                        autoComplete="name"
                      />
                    </label>
                    <label className="block" htmlFor={`${formId}-email`}>
                      Email
                      <Input
                        id={`${formId}-email`}
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        readOnly={fixedEmail}
                        required
                        autoComplete="username"
                      />
                    </label>
                  </>
                )}
                <label className="block" htmlFor={`${formId}-password`}>
                  Password
                  <Input
                    id={`${formId}-password`}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    maxLength={1024}
                    autoComplete="new-password"
                  />
                </label>
                <label className="block" htmlFor={`${formId}-confirm`}>
                  Confirm password
                  <Input
                    id={`${formId}-confirm`}
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </label>
                <Button type="submit" disabled={busy}>
                  {busy
                    ? reset
                      ? 'Saving…'
                      : 'Joining…'
                    : reset
                      ? 'Save password'
                      : 'Join workspace'}
                </Button>
              </form>
            )}
          </>
        )}
      </section>
    </main>
  )
}
