import { type JSX, useCallback, useEffect, useState } from 'react'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Section } from './shared'

/** Existing instance policy controls, kept reachable until the Access page lands. */
export function InstanceLoginSection({ trpc }: { trpc: Trpc }): JSX.Element | null {
  const [status, setStatus] = useState<Awaited<ReturnType<Trpc['auth']['status']['query']>> | null>(
    null,
  )
  const [loadError, setLoadError] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)
  const [disableCurrent, setDisableCurrent] = useState('')
  const [disableAck, setDisableAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const load = useCallback(() => {
    setLoadError(false)
    void trpc.auth.status
      .query()
      .then(setStatus)
      .catch(() => setLoadError(true))
  }, [trpc])
  useEffect(load, [load])
  const resetDisable = () => {
    setDisableOpen(false)
    setDisableCurrent('')
    setDisableAck(false)
  }
  const disable = async () => {
    if (busy || !disableCurrent || !disableAck) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const next = await trpc.auth.setLoginRequired.mutate({
        required: false,
        current: disableCurrent,
        acknowledgeNoPassword: true,
      })
      setStatus((value) => (value ? { ...value, loginRequired: next.loginRequired } : value))
      resetDisable()
      setDone('Login disabled — anyone who can reach this server can use it.')
    } catch {
      setError('Couldn’t disable — is the current password correct?')
    } finally {
      setBusy(false)
    }
  }
  if (!status)
    return (
      <Section title="Instance login">
        {loadError ? (
          <>
            <p role="alert" className="settings-prose text-destructive">
              Couldn’t load the instance login policy.
            </p>
            <Button variant="outline" size="sm" onClick={load}>
              Try again
            </Button>
          </>
        ) : (
          <p className="settings-prose">Loading…</p>
        )}
      </Section>
    )
  if (!status.canManageInstance) return null
  const { loginRequired } = status
  const loginForced = status.loginPolicySource === 'file'
  return (
    <Section
      title="Instance login"
      hint={
        loginRequired
          ? 'Everyone signs in with their own password.'
          : 'Login is turned off for this instance — anyone who can reach this server can use it. Your personal password does not change this instance policy.'
      }
    >
      {loginRequired && (
        <Button
          type="button"
          variant="outline"
          disabled={busy || loginForced}
          onClick={() => {
            setError(null)
            setDone(null)
            setDisableOpen(true)
          }}
        >
          Disable login...
        </Button>
      )}
      {loginForced && (
        <p className="settings-prose">
          config.json overrides the instance login policy. Remove the file override to change it
          here.
        </p>
      )}
      {loginRequired && disableOpen && (
        <div className="mt-1 flex flex-col gap-2 rounded-md border border-border bg-muted/25 p-3">
          <div>
            <h4 className="settings-h2">Disable login for this instance</h4>
            <p className="settings-prose">
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
          <Label className="cursor-pointer items-start rounded-md border border-border bg-background px-3 py-2 text-[13px] text-muted-foreground">
            <Checkbox
              checked={disableAck}
              onCheckedChange={(checked) => setDisableAck(checked === true)}
            />
            <span>
              I understand that anyone who can reach this server can use it — as any account — if
              login is disabled.
            </span>
          </Label>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={busy || loginForced || !disableCurrent || !disableAck}
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

      {!loginRequired && (
        <p className="settings-prose">
          Existing passwords were kept, so turning login back on signs everyone in with the password
          they already had.
        </p>
      )}
      {error && (
        <p role="alert" className="settings-prose text-destructive">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="settings-prose">
          {done}
        </p>
      )}
    </Section>
  )
}
