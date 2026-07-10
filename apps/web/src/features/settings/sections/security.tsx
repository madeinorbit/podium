import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { serverConfig, type Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Section } from './shared'

/**
 * Set / change / disable the human-client login password from an already-configured
 * instance (the setup screen only appears on first run). The auth.* tRPC procedures run
 * behind the /trpc guard and require the current password to change/disable, so this is
 * safe to expose here. After a successful set/change we immediately POST /auth/login with
 * the new password so THIS device gets (or refreshes) its session cookie instead of being
 * locked out by the guard it just enabled.
 *
 * `trpc` stays an explicit prop (not the store hook): the unit tests inject a
 * fake client directly, and the section renders outside a StoreProvider there.
 */
export function LoginPasswordSection({ trpc }: { trpc: Trpc }): JSX.Element {
  const httpOrigin = serverConfig(window.location).httpOrigin
  const [enabled, setEnabled] = useState<boolean | null>(null)
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
      .then((s) => setEnabled(s.enabled))
      .catch(() => setEnabled(null))
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
      setEnabled(true)
      reset()
      setDone('Password saved.')
    } catch {
      setError(
        enabled
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
      await trpc.auth.clearPassword.mutate({
        current: disableCurrent,
        acknowledgeNoPassword: true,
      })
      setEnabled(false)
      reset()
      setDone('Login disabled — anyone who can reach this server can use it.')
    } catch {
      setError('Couldn’t disable — is the current password correct?')
    } finally {
      setBusy(false)
    }
  }

  if (enabled === null) {
    return (
      <Section title="Login password">
        <p className="text-[12px] text-muted-foreground">Loading…</p>
      </Section>
    )
  }

  return (
    <Section
      title="Login password"
      hint={
        enabled
          ? 'A password is required to use this Podium from a browser or the desktop app.'
          : 'No password set — anyone who can reach this server can use it. Set one to require login.'
      }
    >
      <div className="flex max-w-sm flex-col gap-2">
        {enabled && (
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
          placeholder={enabled ? 'New password' : 'Password'}
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
          <Button type="button" disabled={busy || !next} onClick={() => void save()}>
            {busy ? 'Saving…' : enabled ? 'Change password' : 'Set password'}
          </Button>
          {enabled && (
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
        {enabled && disableOpen && (
          <div className="mt-1 flex flex-col gap-2 rounded-md border border-border bg-muted/25 p-3">
            <div>
              <h4 className="font-medium text-[13px] text-foreground">Disable login</h4>
              <p className="text-[12px] text-muted-foreground">
                This removes the password requirement for browsers and desktop apps.
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
                I understand that anyone who can reach this server can use it if login is disabled.
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
  )
}
