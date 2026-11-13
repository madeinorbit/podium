/**
 * SUBSCRIPTION LOGINS ON MY MACHINES (credential management §6 way 3, D11).
 * The logins a person made in an agent program on the machines they look
 * after, with the program's own sign-in and the "Use on all my machines"
 * switch. They come from `accounts.list` until found logins become
 * credential rows (epic Task 9), which then show in the list above.
 */

import { followVisibleRequest } from '@podium/client-graph/visible-request'
import type { HarnessAgent } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useSettingsSessionPresent } from '@/features/settings/readers'
import { accountKey, useSettingsRecords } from '@/features/settings/record-readers'
import {
  type AccountView,
  EntityRow,
  harnessAgentLabel,
  Section,
} from '@/features/settings/sections/shared'
import {
  USE_ON_MY_MACHINES_NOTE,
  UseOnMyMachinesBox,
} from '@/features/settings/sections/use-on-my-machines'
import { useSettingsClient, useSettingsTrpc } from '@/features/settings/stable-access'

const NativeAccountRow = observer(function NativeAccountRow({
  account,
  onChanged,
}: {
  account: AccountView
  onChanged: (automatic?: boolean) => void
}): JSX.Element {
  const { trpc, navigateToSession } = useSettingsClient()
  const [machineId, setMachineId] = useState(account.loginMachines?.[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null)
  const sessionPresent = useSettingsSessionPresent(pendingSessionId)
  const attempt = account.loginAttempt
  const selectedMachineId = account.loginMachines?.some((machine) => machine.id === machineId)
    ? machineId
    : account.loginMachines?.[0]?.id

  const attemptStatus = attempt?.status
  useEffect(() => {
    if (attemptStatus !== 'running' && attemptStatus !== 'refreshing') return
    let initial = true
    return followVisibleRequest(
      () => {
        // The opening already requested this directory; subsequent visible ticks refresh it.
        if (initial) {
          initial = false
          return
        }
        onChanged(true)
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
  }, [attemptStatus, onChanged])

  useEffect(() => {
    if (!pendingSessionId || !sessionPresent) return
    navigateToSession(pendingSessionId)
  }, [navigateToSession, pendingSessionId, sessionPresent])

  const login = async (): Promise<void> => {
    if (!account.harness || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await trpc.accounts.login.mutate({
        harness: account.harness as HarnessAgent,
        ...(selectedMachineId ? { machineId: selectedMachineId } : {}),
      })
      onChanged()
      setPendingSessionId(result.sessionId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const status =
    attempt?.status === 'running'
      ? `Login open on ${attempt.machineName}`
      : attempt?.status === 'refreshing'
        ? 'Checking refreshed account status…'
        : attempt?.status === 'succeeded'
          ? 'Login succeeded'
          : attempt?.status === 'failed'
            ? (attempt.error ?? 'Login failed')
            : error

  const label = harnessAgentLabel((account.harness ?? account.provider) as HarnessAgent)
  return (
    <EntityRow
      leading={label.slice(0, 1)}
      title={label}
      pills={
        account.identity && (
          <span className="settings-micro min-w-0 max-w-full break-words font-mono">
            {account.identity}
          </span>
        )
      }
      subtitle={
        <>
          <span>
            on{' '}
            {account.machines?.length
              ? account.machines.join(', ')
              : account.loginMachines?.map((machine) => machine.name).join(', ')}
            {account.status === 'not-configured' ? ' · not signed in' : ''}
          </span>
          {(account.keptOn?.length ?? 0) > 0 && (
            <p className="text-warning">
              Not copied to {account.keptOn?.map((machine) => machine.name).join(', ')}: a different
              login is signed in there, and Podium kept it.
            </p>
          )}
          {status && (
            <p role={error ? 'alert' : 'status'} className={error ? 'text-destructive' : undefined}>
              {status}
            </p>
          )}
        </>
      }
      trailing={
        <>
          {account.identityFingerprint && (
            <UseOnMyMachinesBox account={account} trpc={trpc} onChanged={() => onChanged()} />
          )}
          {account.loginRequired ? (
            <>
              {(account.loginMachines?.length ?? 0) > 1 && (
                <select
                  aria-label={`${label} sign-in machine`}
                  className="h-8 max-w-40 rounded-md border border-border bg-background px-2 settings-prose"
                  value={selectedMachineId ?? ''}
                  onChange={(event) => setMachineId(event.target.value)}
                >
                  {account.loginMachines?.map((machine) => (
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
                disabled={busy || !account.loginMachines?.length}
                onClick={() => void login()}
              >
                {attempt?.status === 'running' ? 'Open sign-in' : busy ? 'Starting…' : 'Sign in'}
              </Button>
            </>
          ) : !account.identityFingerprint ? (
            <span className="settings-micro rounded-full bg-chip px-2 py-0.5">
              {account.status === 'connected' ? 'Ready' : 'Status unavailable'}
            </span>
          ) : null}
        </>
      }
    />
  )
})

/** Logins found on the machines I look after, read from `accounts.list`. */
export const MachineLogins = observer(function MachineLogins(): JSX.Element {
  const trpc = useSettingsTrpc()
  const readAccounts = useCallback(() => trpc.accounts.list.query(), [trpc])
  const { request, reload } = useSettingsRecords('account', readAccounts, accountKey, false)
  const accounts = request?.models
  const refresh = useCallback(
    (automatic = false) => {
      if (!automatic || !request?.loading) void reload()
    },
    [request, reload],
  )
  const native = (accounts ?? []).filter((account) => account.source === 'native')
  const installed = native.filter(
    (account) => account.machines?.length || account.loginMachines?.length,
  )
  const absent = native.filter((account) => !installed.includes(account))
  return (
    <Section
      title="Subscription logins on your machines"
      hint={`Logins made in an agent program on the machines you look after. ${USE_ON_MY_MACHINES_NOTE}`}
      list
    >
      {accounts === undefined && !request?.error && (
        <p className="settings-list-note settings-prose" role="status">
          Loading logins…
        </p>
      )}
      {request?.error && (
        <p className="settings-list-note settings-prose text-destructive" role="alert">
          {request.error}
        </p>
      )}
      {accounts !== undefined && !request?.error && native.length === 0 && (
        <p className="settings-list-note settings-prose">
          No agent logins found. Install an agent on a machine you look after to sign in.
        </p>
      )}
      {installed.map((account) => (
        <NativeAccountRow key={account.id} account={account} onChanged={refresh} />
      ))}
      {absent.length > 0 && (
        <p className="settings-list-note settings-prose">
          {absent
            .map((account) =>
              harnessAgentLabel((account.harness ?? account.provider) as HarnessAgent),
            )
            .join(', ')}{' '}
          are supported too. Install one on a machine you look after and it shows up here.
        </p>
      )}
    </Section>
  )
})
