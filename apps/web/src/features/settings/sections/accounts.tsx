import { MemberDirectory, type MemberDirectoryAnswer } from '@podium/client-graph/member-directory'
import type { MobxPool } from '@podium/client-graph/pool'
import { useOpeningView } from '@podium/client-graph/react'
import { followVisibleRequest } from '@podium/client-graph/visible-request'
import { SHARED_MACHINE_ACCOUNT_WARNING } from '@podium/model'
import type { HarnessAgent } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { serverConfig } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { memberRequest } from '@/features/setup/member-api'
import { useSettingsSessionPresent } from '../readers'
import { accountKey, useSettingsRecords } from '../record-readers'
import { useSettingsClient, useSettingsTrpc } from '../stable-access'
import { KeySharing, MembersKeys } from './key-sharing'
import { type AccountView, harnessAgentLabel, providerLabel, Row, Section } from './shared'
import { UseOnMyMachinesBox } from './use-on-my-machines'

/** The Claude subscription token from `claude setup-token` — the ONLY OAuth
 *  account the server accepts (accounts.connect rejects kind 'oauth' for any
 *  other provider), so the paste-a-token affordance is offered on this row only. */
const CLAUDE_OAUTH_ID = 'managed:claude-oauth'

type ManagedProvider = 'anthropic' | 'openai' | 'openrouter'

function managedLabel(a: { id: string; provider: string }): string {
  if (a.id === CLAUDE_OAUTH_ID) return 'Claude subscription (setup-token)'
  return `${providerLabel(a.provider as ManagedProvider)} API key`
}

/** Connected: a filled signal dot + the masked identity in machine voice.
 *  Podium's `--success` is calm blue (the "all good" hue — this theme has no
 *  green), so the semantic token keeps the status aligned with the palette. */
function StatusConnected({ identity }: { identity: string }): JSX.Element {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-success/10 py-0.5 pr-2 pl-1.5 text-[12px] text-success">
      <span aria-hidden="true" className="size-1.5 flex-none rounded-full bg-success" />
      <span className="min-w-0 break-words font-mono">{identity}</span>
    </span>
  )
}

/** Not connected: a hollow dot echoes the connected shape at rest, so the two
 *  states read as one on/off column rather than two unrelated treatments. */
function StatusDisconnected(): JSX.Element {
  return (
    <span className="inline-flex flex-none items-center gap-1.5 settings-prose">
      <span
        aria-hidden="true"
        className="size-1.5 flex-none rounded-full ring-1 ring-border-strong ring-inset"
      />
      Not connected
    </span>
  )
}

function StatusUnknown(): JSX.Element {
  return (
    <span className="inline-flex flex-none items-center gap-1.5 settings-prose text-muted-foreground">
      <span aria-hidden="true" className="size-1.5 flex-none rounded-full bg-muted-foreground/50" />
      Status unavailable
    </span>
  )
}

const AccountStatus = observer(function AccountStatus({
  account,
}: {
  account: AccountView
}): JSX.Element {
  if (account.status === 'connected') {
    return <StatusConnected identity={account.identity ?? 'connected'} />
  }
  return account.status === 'unknown' ? <StatusUnknown /> : <StatusDisconnected />
})

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
        ...(machineId ? { machineId } : {}),
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

  return (
    <div>
      <Row
        label={harnessAgentLabel((account.harness ?? account.provider) as HarnessAgent)}
        description={
          account.machines?.length ? `on ${account.machines.join(', ')}` : (status ?? undefined)
        }
      >
        <div className="flex items-center gap-2.5">
          <AccountStatus account={account} />
          {account.loginRequired && (
            <>
              {(account.loginMachines?.length ?? 0) > 1 && (
                <select
                  aria-label={`${account.harness} login machine`}
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                  value={machineId}
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
                {attempt?.status === 'running' ? 'Open login' : busy ? 'Starting…' : 'Log in'}
              </Button>
            </>
          )}
        </div>
      </Row>
      {status && <p className="max-w-[62ch] pb-2.5 settings-prose">{status}</p>}
      <UseOnMyMachinesBox account={account} trpc={trpc} onChanged={() => onChanged()} />
      {account.serverAi?.machineName && (
        <p className="max-w-[62ch] pb-2.5 settings-prose">
          Server AI uses {account.serverAi.machineName}&rsquo;s login.
        </p>
      )}
      {account.serverAi?.lastError && (
        <p className="max-w-[62ch] pb-2.5 settings-prose text-warning">
          Server AI last failed: {account.serverAi.lastError}
        </p>
      )}
    </div>
  )
})

/** A carved panel grouping one class of accounts: a machine-voice mono label over
 *  a bordered Panel-Navy surface whose rows self-divide by hairline seams. Groups
 *  the two account classes far more strongly than the old loose text lines, while
 *  staying carved (tone + seam), never floated. */
function AccountGroup({
  label,
  qualifier,
  children,
}: {
  label: string
  qualifier: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="settings-account-group">
      <div className="mb-2 flex items-baseline gap-2 px-0.5">
        <span className="settings-eyebrow">{label}</span>
        <span className="settings-micro">{qualifier}</span>
      </div>
      <div className="divide-y divide-hairline-soft overflow-hidden rounded-lg border border-border bg-card/50 px-3.5">
        {children}
      </div>
    </div>
  )
}

/**
 * One managed credential (#216): paste a secret to connect it, or drop it again.
 *
 * The secret is write-only from the browser's side — it is typed into a masked
 * field, posted once, and cleared from component state; `accounts.list` only ever
 * hands back the masked `identity`, so there is nothing to round-trip.
 */
const ManagedAccountRow = observer(function ManagedAccountRow({
  account,
  directory,
  onChanged,
}: {
  account: AccountView
  directory: MemberDirectory | null
  onChanged: () => void
}): JSX.Element {
  const trpc = useSettingsTrpc()
  const [editing, setEditing] = useState(false)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const isOauth = account.kind === 'oauth'
  const connected = account.status === 'connected'
  // A legacy key lives in settings.apiKeys, not the accounts table: there is no row
  // for `accounts.disconnect` to delete, so offering a Disconnect here would be a
  // button that reports success and changes nothing. Offer the honest action —
  // replace it with a managed credential (which IS disconnectable), or remove it
  // where it actually lives.
  const legacy = connected && account.credentialSource === 'legacy'
  // Another user's key, shared with this viewer (POD-6360). It is not theirs to
  // disconnect; connecting their own replaces it for their agents.
  const shared = connected && account.credentialSource === 'shared'
  // The viewer's own stored key: theirs to share (POD-6390).
  const own = connected && account.credentialSource === 'stored'
  const sharedByName =
    shared && account.sharedBy
      ? directory?.members.find((member) => member.id === account.sharedBy)?.displayName
      : undefined
  const label = managedLabel(account)

  // The row's own explanation lives under its label (POD-127 F3), never as a
  // detached paragraph between rows. Exactly one applies at a time.
  const note: React.ReactNode =
    isOauth && !connected ? (
      <>
        Run <code>claude setup-token</code> in a terminal and paste the token here. It is a
        long-lived subscription token (about a year), not your API key.
      </>
    ) : legacy && !editing ? (
      <span className="text-warning">
        Set under Settings → API keys, not held as a managed account — Podium does not inject it
        into agent spawns and it cannot be disconnected here. Replace it to store it as a managed
        account, or clear it under API keys.
      </span>
    ) : shared && !editing ? (
      <>
        Shared with you by {sharedByName ?? 'another user'}, and injected into your agents' spawns.
        Connect your own to use it instead.
      </>
    ) : !isOauth && connected && !legacy ? (
      <>
        Injected into agent spawns. The superagent and background LLM roles still read their key
        from Settings → API keys (issue #469), so this account does not power those.
      </>
    ) : undefined

  const connect = async (): Promise<void> => {
    const credential = secret.trim()
    if (!credential || busy) return
    setBusy(true)
    setError(null)
    try {
      await trpc.accounts.connect.mutate({
        provider: account.provider as ManagedProvider,
        kind: isOauth ? 'oauth' : 'api-key',
        credential,
      })
      // Never leave the plaintext credential sitting in the component.
      setSecret('')
      setEditing(false)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // POD-6300: a connection runs on the owner's own machines. To run on someone
  // else's (one the owner was given use of), the owner sends it there, after
  // reading the shared-machine warning, which the server also requires.
  const send = async (machineId: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await trpc.accounts.send.mutate({ id: account.id, machineId, acknowledgeSharedMachine: true })
      setSending(false)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const sentTo = account.sentTo ?? []
  const sendableTo = account.sendableTo ?? []

  const disconnect = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await trpc.accounts.disconnect.mutate({ id: account.id })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Row label={label} description={note}>
        {connected && !editing ? (
          <div className="flex items-center gap-2.5">
            <StatusConnected identity={account.identity ?? 'connected'} />
            {legacy || shared ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                {shared ? 'Use your own' : 'Replace'}
              </Button>
            ) : (
              <>
                {sendableTo.length > 0 && !sending ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setSending(true)}
                  >
                    Send to a shared machine
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </Button>
              </>
            )}
          </div>
        ) : editing ? (
          <div className="flex w-full items-center gap-1.5">
            <Input
              type="password"
              autoComplete="off"
              autoFocus
              className="flex-1"
              aria-label={`${label} secret`}
              placeholder={isOauth ? 'paste setup-token' : 'paste API key'}
              value={secret}
              disabled={busy}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void connect()
                if (e.key === 'Escape') {
                  setSecret('')
                  setEditing(false)
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              disabled={busy || secret.trim().length === 0}
              onClick={() => void connect()}
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSecret('')
                setError(null)
                setEditing(false)
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <StatusDisconnected />
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              Connect
            </Button>
          </div>
        )}
      </Row>
      {own && sentTo.length > 0 ? (
        <p className="max-w-[62ch] pb-2.5 settings-prose">
          Also runs on {sentTo.map((machine) => machine.name).join(', ')}, someone else's{' '}
          {sentTo.length === 1 ? 'machine' : 'machines'} you sent it to.
        </p>
      ) : null}
      {sending ? (
        <div
          role="alertdialog"
          aria-label={`Send ${label} to a shared machine`}
          className="mb-2.5 max-w-[62ch] space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3"
        >
          <p className="settings-prose text-warning">{SHARED_MACHINE_ACCOUNT_WARNING}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {sendableTo.map((machine) => (
              <Button
                key={machine.id}
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void send(machine.id)}
              >
                Send to {machine.name}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setSending(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {own && !editing && (
        <KeySharing
          accountId={account.id}
          label={label}
          sharing={account.sharing}
          directory={directory}
          currentMemberId={directory?.currentMemberId}
          onChanged={onChanged}
        />
      )}
      {error && <p className="max-w-[62ch] pb-2.5 settings-prose text-destructive">{error}</p>}
    </div>
  )
})

const createDirectory = (pool: MobxPool) => new MemberDirectory(pool)

/**
 * The member directory, for naming the people a key is shared with. Only an
 * admin can read it; for a member the read fails and the sharing control offers
 * what needs no names (only you, everyone, removing people already named).
 * Its answer is also what tells this screen the viewer is an admin, for the
 * members' keys list.
 */
function useKeyPeople(open: boolean): MemberDirectory | null {
  const directory = useOpeningView(useWorklistPool(), createDirectory, open)
  useEffect(() => {
    if (!directory) return
    const origin = serverConfig(window.location).httpOrigin
    void directory.read(() => memberRequest<MemberDirectoryAnswer>(origin, 'list'))
  }, [directory])
  return directory
}

/** Accounts & Keys hub (SP-6454 stream B2; managed credentials #216): native CLI
 *  logins on this machine (observed read-only — each CLI's own `login` on the
 *  server owns those) + the managed credentials Podium holds and injects into
 *  agent spawns. Managed rows are connectable here: paste a provider API key, or
 *  a `claude setup-token` subscription token. The credential goes straight to the
 *  server's accounts table; the hub only ever reads back a masked identity. */
export const AccountsSection = observer(function AccountsSection(): JSX.Element {
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

  const native = (accounts ?? []).filter((a) => a.source === 'native')
  const managed = (accounts ?? []).filter((a) => a.source === 'managed')
  const directory = useKeyPeople(accounts !== undefined)

  return (
    <Section
      title="Accounts & Keys"
      hint="How Podium authenticates your agents to LLMs. Native logins are the CLI logins on the machines you look after. Managed accounts start private; you choose who may use a key. Your connections run on your machines, and on someone else's machine only after you send them there."
    >
      <div className="mt-3 space-y-5">
        <AccountGroup label="Native logins" qualifier="your machines">
          {native.map((a) => (
            <NativeAccountRow key={a.id} account={a} onChanged={refresh} />
          ))}
        </AccountGroup>
        <AccountGroup label="Managed accounts" qualifier="Podium-held">
          {managed.map((a) => (
            <ManagedAccountRow key={a.id} account={a} directory={directory} onChanged={refresh} />
          ))}
        </AccountGroup>
        {directory?.answer && (
          <MembersKeys
            directory={directory}
            labelOf={managedLabel}
            group={(children) => (
              <AccountGroup label="Members' keys" qualifier="admin · who may use each">
                {children}
              </AccountGroup>
            )}
          />
        )}
      </div>
      <p className="settings-prose mt-3">
        Coming soon — rotating several subscription logins across agents.
      </p>
    </Section>
  )
})
