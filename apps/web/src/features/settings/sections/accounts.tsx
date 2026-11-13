import {
  type MemberRoster,
  type MemberRosterAnswer,
  memberRoster,
} from '@podium/client-graph/member-roster'
import { followVisibleRequest } from '@podium/client-graph/visible-request'
import { SHARED_MACHINE_ACCOUNT_WARNING } from '@podium/model'
import type { HarnessAgent } from '@podium/runtime'
import { KeyRound, Laptop, Users } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { serverConfig } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { memberRequest } from '@/features/setup/member-api'
import { useSettingsSessionPresent } from '../readers'
import { accountKey, useSettingsRecords } from '../record-readers'
import { useSettingsFrame } from '../settings-frame'
import { useSettingsClient, useSettingsTrpc } from '../stable-access'
import { KeySharing, sharingSummary } from './key-sharing'
import {
  type AccountView,
  ConfirmInline,
  EntityRow,
  harnessAgentLabel,
  providerLabel,
  Row,
  SecretRow,
  Section,
  ValueRow,
} from './shared'
import { USE_ON_MY_MACHINES_NOTE, UseOnMyMachinesBox } from './use-on-my-machines'

/** The Claude subscription token from `claude setup-token` — the ONLY OAuth
 *  account the server accepts (accounts.connect rejects kind 'oauth' for any
 *  other provider), so the paste-a-token affordance is offered on this row only. */
const CLAUDE_OAUTH_ID = 'managed:claude-oauth'

type ManagedProvider = 'anthropic' | 'openai' | 'openrouter'

function managedLabel(a: { id: string; provider: string }): string {
  if (a.id.endsWith(':earlier-workspace'))
    return `Earlier workspace key (${providerLabel(a.provider as ManagedProvider)})`
  if (a.id === CLAUDE_OAUTH_ID) return 'Claude subscription token'
  return `${providerLabel(a.provider as ManagedProvider)} API key`
}

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

function usedBy(account: AccountView): string {
  return account.kind === 'oauth'
    ? 'Your Claude coding agents'
    : 'Your coding agents, background and superagent models when selected for this provider'
}

const KeyMachines = observer(function KeyMachines({
  account,
  onChanged,
}: {
  account: AccountView
  onChanged: () => void
}) {
  const trpc = useSettingsTrpc()
  const [sending, setSending] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sent = account.sentTo ?? []
  const machines = [
    ...sent,
    ...(account.sendableTo ?? []).filter(
      (machine) => !sent.some((other) => other.id === machine.id),
    ),
  ]
  const send = async (machineId: string) => {
    await trpc.accounts.send.mutate({ id: account.id, machineId, acknowledgeSharedMachine: true })
    setSending(null)
    onChanged()
    toast('Sent')
  }
  return (
    <Section
      list
      title="Someone else’s machines"
      hint="Your key already runs on machines you look after. On a machine someone else looks after, it runs only if you send it there."
    >
      {machines.length === 0 && (
        <p className="settings-list-note settings-prose">
          You can’t run agents on anyone else’s machine yet.
        </p>
      )}
      {machines.map((machine) => (
        <div key={machine.id}>
          <EntityRow
            leading={<Laptop size={16} aria-hidden="true" />}
            title={machine.name}
            subtitle={
              error ? (
                <span role="alert" className="text-destructive">
                  {error}
                </span>
              ) : undefined
            }
            trailing={
              <Switch
                aria-label={`Send key to ${machine.name}`}
                checked={sent.some((other) => other.id === machine.id)}
                disabled={busy}
                onCheckedChange={(enabled) => {
                  setNote(null)
                  setError(null)
                  if (enabled) {
                    setSending(machine.id)
                    return
                  }
                  setSending(null)
                  setBusy(true)
                  void trpc.accounts.unsend
                    .mutate({ id: account.id, machineId: machine.id })
                    .then((result) => {
                      setNote(result.removed ? result.note : null)
                      onChanged()
                      toast('Key removed from machine')
                    })
                    .catch((error: unknown) =>
                      setError(error instanceof Error ? error.message : String(error)),
                    )
                    .finally(() => setBusy(false))
                }}
              />
            }
          />
          {sending === machine.id && (
            <ConfirmInline
              sentence={SHARED_MACHINE_ACCOUNT_WARNING}
              acknowledgement="I understand we will share this machine’s account. That includes this key."
              actionLabel={`Send to ${machine.name}`}
              onConfirm={() => send(machine.id)}
              onCancel={() => setSending(null)}
            />
          )}
        </div>
      ))}
      {note && (
        <p className="settings-list-note settings-prose" role="status">
          {note}
        </p>
      )}
    </Section>
  )
})

const KeyDetail = observer(function KeyDetail({
  account,
  directory,
  onChanged,
}: {
  account: AccountView
  directory: MemberRoster | null
  onChanged: () => void
}) {
  const trpc = useSettingsTrpc()
  const { closeTakeover } = useSettingsFrame()
  const [removing, setRemoving] = useState(false)
  return (
    <>
      <Section>
        {account.id.endsWith(':earlier-workspace') ? (
          <ValueRow
            label="Key"
            value={account.identity ?? 'Set'}
            description="Your earlier workspace key, kept separately during the upgrade. Add a personal key to replace what your agents use."
          />
        ) : (
          <SecretRow
            label="Key"
            present
            maskedIdentity={account.identity}
            description="Stored on the server. Only its masked identity is shown."
            onSave={async (credential) => {
              await trpc.accounts.connect.mutate({
                provider: account.provider as ManagedProvider,
                kind: account.kind === 'oauth' ? 'oauth' : 'api-key',
                credential,
              })
              onChanged()
            }}
          />
        )}
        <ValueRow label="Used by" value={usedBy(account)} />
      </Section>
      <Section
        title="Who can use it"
        hint="Others use it only when they have no key of their own. Removing someone takes effect at their next agent start."
      >
        <KeySharing
          accountId={account.id}
          label={managedLabel(account)}
          sharing={account.sharing}
          directory={directory}
          currentMemberId={directory?.currentMemberId}
          onChanged={onChanged}
        />
      </Section>
      <KeyMachines account={account} onChanged={onChanged} />
      <Section title="Remove">
        <Row
          label="Remove this key"
          description="Your agents stop using it at their next start. People you shared it with fall back to their own key, or none."
        >
          <Button type="button" size="sm" variant="destructive" onClick={() => setRemoving(true)}>
            Remove
          </Button>
        </Row>
        {removing && (
          <ConfirmInline
            sentence={`Remove ${managedLabel(account)}?`}
            actionLabel="Remove key"
            destructive
            onCancel={() => setRemoving(false)}
            onConfirm={async () => {
              await trpc.accounts.disconnect.mutate({ id: account.id })
              onChanged()
              closeTakeover()
              toast('Key removed')
            }}
          />
        )}
      </Section>
    </>
  )
})

const AddKey = observer(function AddKey({
  accounts,
  initialId,
  onChanged,
}: {
  accounts: readonly AccountView[]
  initialId?: string
  onChanged: () => void
}) {
  const trpc = useSettingsTrpc()
  return (
    <Section
      title="Your keys"
      hint="Keys start private. You can choose who else may use them after adding them."
    >
      {accounts
        .filter(
          (account) =>
            account.credentialSource !== 'stored' && (!initialId || account.id === initialId),
        )
        .map((account) => (
          <SecretRow
            key={account.id}
            label={managedLabel(account)}
            present={false}
            description={
              account.kind === 'oauth'
                ? 'Used by: your Claude coding agents. Run claude setup-token in a terminal and paste the subscription token here.'
                : `Used by: ${usedBy(account)}.`
            }
            onSave={async (credential) => {
              await trpc.accounts.connect.mutate({
                provider: account.provider as ManagedProvider,
                kind: account.kind === 'oauth' ? 'oauth' : 'api-key',
                credential,
              })
              onChanged()
            }}
          />
        ))}
    </Section>
  )
})

const ManagedAccountRow = observer(function ManagedAccountRow({
  account,
  directory,
  onChanged,
  onAdd,
}: {
  account: AccountView
  directory: MemberRoster | null
  onChanged: () => void
  onAdd: () => void
}) {
  const { openTakeover } = useSettingsFrame()
  const shared = account.credentialSource === 'shared'
  return (
    <EntityRow
      leading={shared ? <Users size={16} /> : <KeyRound size={16} />}
      title={managedLabel(account)}
      pills={
        shared ? (
          <span className="settings-micro rounded-full bg-chip px-2 py-0.5">Shared with you</span>
        ) : (
          <span className="settings-micro font-mono">{account.identity ?? 'Set'}</span>
        )
      }
      subtitle={
        shared
          ? `${directory?.nameOf(account.sharedBy) ?? 'Another person'}’s key. Your agents use it because you have no key of your own.`
          : `${sharingSummary(directory, account.sharing)}${account.sentTo?.length ? ` · also runs on ${account.sentTo.map((machine) => machine.name).join(', ')}` : ''}`
      }
      onClick={
        shared
          ? undefined
          : () =>
              openTakeover({
                title: managedLabel(account),
                content: (
                  <KeyDetail account={account} directory={directory} onChanged={onChanged} />
                ),
              })
      }
      trailing={
        shared ? (
          <Button type="button" size="sm" variant="ghost" onClick={onAdd}>
            Add your own
          </Button>
        ) : undefined
      }
    />
  )
})

/**
 * Read active names and roles when Accounts opens, into the pool's shared
 * roster. The admin viewer independently decides whether members' keys appear.
 */
function useKeyPeople(open: boolean): MemberRoster | null {
  const pool = useWorklistPool()
  const directory = pool ? memberRoster(pool) : null
  useEffect(() => {
    if (!open || !directory) return
    const origin = serverConfig(window.location).httpOrigin
    void directory.read(() => memberRequest<MemberRosterAnswer>(origin, 'directory'))
  }, [directory, open])
  return directory
}

/** Personal native logins and managed keys, read from the shared account models. */
export const AccountsSection = observer(function AccountsSection(): JSX.Element {
  const trpc = useSettingsTrpc()
  const { openTakeover } = useSettingsFrame()
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
  const managed = (accounts ?? []).filter((account) => account.source === 'managed')
  const connected = managed.filter((account) => account.status === 'connected')
  const directory = useKeyPeople(accounts !== undefined)
  const add = (initialId?: string) =>
    openTakeover({
      title: 'Add key',
      content: <AddKey accounts={managed} initialId={initialId} onChanged={refresh} />,
    })
  return (
    <>
      <Section
        title="Logins on your machines"
        hint={`CLI logins found on the machines you look after. ${USE_ON_MY_MACHINES_NOTE}`}
        list
      >
        {accounts === undefined && (
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
      <Section
        title="API keys"
        hint="For agents and background jobs that bill per token. A key starts private; you decide who else may use it. Others use a shared key only when they have none of their own."
        list
        action={
          managed.some((account) => account.credentialSource !== 'stored') && (
            <Button type="button" variant="outline" size="sm" onClick={() => add()}>
              Add key
            </Button>
          )
        }
      >
        {connected.map((account) => (
          <ManagedAccountRow
            key={account.id}
            account={account}
            directory={directory}
            onChanged={refresh}
            onAdd={() => add(account.id)}
          />
        ))}
        {accounts !== undefined && connected.length === 0 && (
          <p className="settings-list-note settings-prose">
            No keys yet. Add your own to use it with your agents and background jobs.
          </p>
        )}
      </Section>
    </>
  )
})
