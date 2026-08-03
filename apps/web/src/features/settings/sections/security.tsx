import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { serverConfig, type Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Section } from './shared'

/**
 * TWO SECTIONS, BECAUSE THERE ARE TWO DECISIONS (POD-1554).
 *
 * *Your password* is yours: every user can set or change their own credential, and
 * `auth.setPassword` writes the CALLING account's row. *Instance login* is the operator's:
 * turning login off leaves the instance open to anyone who can reach it, so it is
 * admin-only (`canManageInstance`) and it is instance-wide. One user cannot turn login off
 * for everybody, and that is why the old single "Login password" section — where
 * `clearPassword` meant both — could not survive accounts.
 *
 * Turning login off does NOT delete anyone's credential; it writes an instance policy flag.
 * Turning it back on restores every account's existing password rather than making everyone
 * re-enrol, which is what the copy below promises.
 *
 * After a successful set/change we immediately POST /auth/login with the new password so
 * THIS device gets (or refreshes) its session cookie instead of being locked out by the
 * guard it just enabled.
 *
 * `trpc` stays an explicit prop (not the store hook): the unit tests inject a
 * fake client directly, and the section renders outside a StoreProvider there.
 */
export function LoginPasswordSection({ trpc }: { trpc: Trpc }): JSX.Element {
  const httpOrigin = serverConfig(window.location).httpOrigin
  const [status, setStatus] = useState<{
    loginRequired: boolean
    hasOwnCredential: boolean
    canManageInstance: boolean
  } | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [disableOpen, setDisableOpen] = useState(false)
  const [disableCurrent, setDisableCurrent] = useState('')
  const [disableAck, setDisableAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    trpc.auth.status
      .query()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [trpc])

  const resetDisable = (): void => {
    setDisableOpen(false)
    setDisableCurrent('')
    setDisableAck(false)
  }

  const reset = (): void => {
    setCurrent('')
    setNext('')
    setConfirm('')
    resetDisable()
  }

  const save = async (): Promise<void> => {
    setError(null)
    setDone(null)
    if (!next) {
      setError('Enter a password.')
      return
    }
    if (next !== confirm) {
      setError('Passwords don’t match.')
      return
    }
    setBusy(true)
    try {
      await trpc.auth.setPassword.mutate({ current: current || undefined, next })
      // Obtain/refresh this device's cookie so the guard we just enabled doesn't lock us out.
      await fetch(`${httpOrigin}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: next }),
      })
      setStatus((s) => (s ? { ...s, hasOwnCredential: true, loginRequired: true } : s))
      reset()
      setDone('Password saved.')
    } catch {
      setError(
        status?.hasOwnCredential
          ? 'Couldn’t save — is the current password correct?'
          : 'Couldn’t save the password.',
      )
    } finally {
      setBusy(false)
    }
  }

  const disable = async (): Promise<void> => {
    setError(null)
    setDone(null)
    if (!disableCurrent) {
      setError('Enter the current password.')
      return
    }
    if (!disableAck) {
      setError('Confirm running without a login password.')
      return
    }
    setBusy(true)
    try {
      await trpc.auth.setLoginRequired.mutate({
        required: false,
        current: disableCurrent,
        acknowledgeNoPassword: true,
      })
      setStatus((s) => (s ? { ...s, loginRequired: false } : s))
      reset()
      setDone('Login disabled — anyone who can reach this server can use it.')
    } catch {
      setError('Couldn’t disable — is the current password correct?')
    } finally {
      setBusy(false)
    }
  }

  if (status === null) {
    return (
      <Section title="Login password">
        <p className="text-[12px] text-muted-foreground">Loading…</p>
      </Section>
    )
  }

  const { hasOwnCredential, loginRequired, canManageInstance } = status

  return (
    <>
      <Section
        title="Your password"
        hint={
          hasOwnCredential
            ? 'Your password signs you in to this Podium from a browser or the desktop app.'
            : 'You don’t have a password yet. Set one to sign in from a browser or the desktop app.'
        }
      >
        <div className="flex max-w-sm flex-col gap-2">
          {hasOwnCredential && (
            <Input
              type="password"
              autoComplete="current-password"
              placeholder="Current password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          )}
          <Input
            type="password"
            autoComplete="new-password"
            placeholder={hasOwnCredential ? 'New password' : 'Password'}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          )}
          {done && <p className="text-[12px] text-muted-foreground">{done}</p>}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={!next}
              pending={busy}
              pendingLabel="Saving password…"
              onClick={() => void save()}
            >
              {hasOwnCredential ? 'Change password' : 'Set password'}
            </Button>
            {canManageInstance && loginRequired && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setError(null)
                  setDone(null)
                  setDisableOpen(true)
                }}
              >
                Disable login...
              </Button>
            )}
          </div>
          {canManageInstance && loginRequired && disableOpen && (
            <div className="mt-1 flex flex-col gap-2 rounded-md border border-border bg-muted/25 p-3">
              <div>
                <h4 className="font-medium text-[13px] text-foreground">
                  Disable login for this instance
                </h4>
                <p className="text-[12px] text-muted-foreground">
                  This removes the login requirement for everyone. Nobody’s password is deleted —
                  turning login back on restores every account’s existing password.
                </p>
              </div>
              <Input
                type="password"
                autoComplete="current-password"
                placeholder="Current password to disable login"
                value={disableCurrent}
                onChange={(e) => setDisableCurrent(e.target.value)}
              />
              <Label className="cursor-pointer items-start rounded-md border border-border bg-background px-3 py-2 text-[12px] text-muted-foreground">
                <Checkbox
                  checked={disableAck}
                  onCheckedChange={(checked) => setDisableAck(checked === true)}
                />
                <span>
                  I understand that anyone who can reach this server can use it — as any account —
                  if login is disabled.
                </span>
              </Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy || !disableCurrent || !disableAck}
                  onClick={() => void disable()}
                >
                  {busy ? 'Disabling...' : 'Disable login'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    resetDisable()
                    setError(null)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </Section>
      {canManageInstance && !loginRequired && (
        <Section
          title="Instance login"
          hint="Login is turned off for this instance — anyone who can reach this server can use it. Set your password above to require login again."
        >
          <p className="text-[12px] text-muted-foreground">
            Existing passwords were kept, so turning login back on signs everyone in with the
            password they already had.
          </p>
        </Section>
      )}
    </>
  )
}
