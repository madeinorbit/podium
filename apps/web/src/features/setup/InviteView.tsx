import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { memberRequest } from './member-api'

export function InviteView({
  token,
  httpOrigin,
  onDone,
}: {
  token: string
  httpOrigin: string
  onDone: () => void
}) {
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
    memberRequest<{ email: string | null }>(httpOrigin, 'inspect', { token })
      .then((invite) => {
        if (!alive) return
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
      await memberRequest(httpOrigin, 'complete', { token, email, password, displayName: name })
      setDone(true)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to accept invite')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">
          {done ? 'You’re a member' : 'Join this workspace'}
        </h1>
        {done ? (
          <>
            <p>Your password is ready. Sign in with {email}.</p>
            <Button onClick={onDone}>Continue to sign in</Button>
          </>
        ) : (
          <>
            <p>Set your password to accept the invitation.</p>
            {error && <p role="alert">{error}</p>}
            {!ready && error && <Button onClick={onDone}>Go to sign in</Button>}
            {ready && (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  void complete()
                }}
              >
                <label className="block">
                  Name
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={200}
                    autoComplete="name"
                  />
                </label>
                <label className="block">
                  Email
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    readOnly={fixedEmail}
                    required
                    autoComplete="username"
                  />
                </label>
                <label className="block">
                  Password
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    maxLength={1024}
                    autoComplete="new-password"
                  />
                </label>
                <label className="block">
                  Confirm password
                  <Input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </label>
                <Button type="submit" disabled={busy}>
                  {busy ? 'Joining…' : 'Join workspace'}
                </Button>
              </form>
            )}
          </>
        )}
      </section>
    </main>
  )
}
