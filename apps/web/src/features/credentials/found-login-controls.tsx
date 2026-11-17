import { followVisibleRequest } from '@podium/client-graph/visible-request'
import type { CredentialView } from '@podium/model'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useSettingsSessionPresent } from '@/features/settings/readers'
import { useSettingsClient } from '@/features/settings/stable-access'
import { identityText } from './credential-facts'
import { type CredentialDeps, errorText } from './credentials-deps'

export const USE_ON_MY_MACHINES_LABEL = 'Use on all my machines'
export const USE_ON_MY_MACHINES_NOTE =
  'Use on all my machines copies a login to every machine you look after, including ones you add later. ' +
  'It never replaces a different login already there, and turning it off stops future copies. Copies already made stay where they are.'

/** The same owner-only choice on a found login and during onboarding. */
export const FoundLoginSwitch = observer(function FoundLoginSwitch({
  view,
  commands,
  reload,
}: {
  view: CredentialView
  commands: Pick<CredentialDeps['commands'], 'useOnMyMachines'>
  reload: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const native = view.nativeLogin
  const fingerprint = view.identity.fingerprint
  if (view.access !== 'owner' || native?.useOnMyMachines === undefined || !fingerprint) return null

  const change = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    setOptimistic(enabled)
    try {
      await commands.useOnMyMachines.mutate({ harness: native.harness, fingerprint, enabled })
      toast('Saved', { action: { label: 'Undo', onClick: () => void change(!enabled) } })
    } catch (e) {
      setError(errorText(e))
    } finally {
      // A refused copy can still have saved the choice; always refresh its authoritative state.
      reload()
      setOptimistic(null)
      setBusy(false)
    }
  }
  return (
    <div>
      <Label className="pointer-events-auto cursor-pointer gap-2 settings-micro">
        <Switch
          checked={optimistic ?? native.useOnMyMachines}
          disabled={busy}
          aria-label={`${USE_ON_MY_MACHINES_LABEL} (${identityText(view) || view.label})`}
          onCheckedChange={(next) => void change(next)}
        />
        <span>{USE_ON_MY_MACHINES_LABEL}</span>
      </Label>
      {error && (
        <p role="alert" className="mt-1 settings-prose text-destructive">
          {error}
        </p>
      )}
    </div>
  )
})

export const FoundLoginStatus = observer(function FoundLoginStatus({
  view,
}: {
  view: CredentialView
}) {
  const native = view.nativeLogin
  if (view.access !== 'owner' || !native) return null
  const attempt = native.attempt
  const status =
    attempt?.status === 'running'
      ? `Login open on ${attempt.machineName}`
      : attempt?.status === 'refreshing'
        ? 'Checking refreshed account status…'
        : attempt?.status === 'succeeded'
          ? 'Login succeeded'
          : attempt?.status === 'failed'
            ? (attempt.error ?? 'Login failed')
            : undefined
  return (
    <>
      {native.required && <p>Machine login needed.</p>}
      {native.keptOn.length > 0 && (
        <p className="text-warning">
          Not copied to {native.keptOn.map((machine) => machine.name).join(', ')}: a different login
          is signed in there, and Podium kept it.
        </p>
      )}
      {status && <p role="status">{status}</p>}
    </>
  )
})

export const FoundLoginActions = observer(function FoundLoginActions({
  view,
  deps,
}: {
  view: CredentialView
  deps: CredentialDeps
}) {
  const { navigateToSession } = useSettingsClient()
  const [machineId, setMachineId] = useState(
    view.nativeLogin?.machines.find((machine) => machine.state === 'out')?.id ??
      view.nativeLogin?.machines[0]?.id ??
      '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null)
  const sessionPresent = useSettingsSessionPresent(pendingSessionId)
  const native = view.nativeLogin
  const attemptStatus = native?.attempt?.status
  useEffect(() => {
    if (attemptStatus !== 'running' && attemptStatus !== 'refreshing') return
    let initial = true
    return followVisibleRequest(
      () => {
        if (initial) {
          initial = false
          return
        }
        deps.reload()
      },
      {
        visible: () => document.visibilityState !== 'hidden',
        subscribe: (changed) => {
          document.addEventListener('visibilitychange', changed)
          return () => document.removeEventListener('visibilitychange', changed)
        },
      },
      1_000,
    )
  }, [attemptStatus, deps.reload])
  useEffect(() => {
    if (pendingSessionId && sessionPresent) navigateToSession(pendingSessionId)
  }, [navigateToSession, pendingSessionId, sessionPresent])
  if (view.access !== 'owner' || !native) return null
  const selectedMachineId = native.machines.some((machine) => machine.id === machineId)
    ? machineId
    : native.machines[0]?.id
  const active = attemptStatus === 'running' || attemptStatus === 'refreshing'
  const login = async () => {
    if (busy || (!selectedMachineId && !active)) return
    setBusy(true)
    setError(null)
    try {
      const result = await deps.commands.login.mutate({
        harness: native.harness,
        ...(selectedMachineId ? { machineId: selectedMachineId } : {}),
      })
      deps.reload()
      setPendingSessionId(result.sessionId)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="credential-login-actions flex max-w-full flex-wrap items-center gap-2">
      <FoundLoginSwitch view={view} commands={deps.commands} reload={deps.reload} />
      {(native.required || active) && (
        <>
          {native.machines.length > 1 && (
            <select
              aria-label={`${view.label} login machine`}
              className="h-8 max-w-40 rounded-md border border-border bg-background px-2 settings-prose"
              value={selectedMachineId ?? ''}
              disabled={busy || active}
              onChange={(event) => setMachineId(event.target.value)}
            >
              {native.machines.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.name}
                </option>
              ))}
            </select>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || (!selectedMachineId && !active)}
            onClick={() => void login()}
          >
            {busy ? 'Starting…' : active ? 'Open sign-in' : 'Log in'}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="settings-prose text-destructive">
          {error}
        </p>
      )}
    </div>
  )
})
