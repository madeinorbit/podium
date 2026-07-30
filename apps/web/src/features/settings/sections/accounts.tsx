import type { HarnessAgent } from '@podium/runtime'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type AccountView, harnessAgentLabel, providerLabel, Row, Section } from './shared'

/** The Claude subscription token from `claude setup-token` — the ONLY OAuth
 *  account the server accepts (accounts.connect rejects kind 'oauth' for any
 *  other provider), so the paste-a-token affordance is offered on this row only. */
const CLAUDE_OAUTH_ID = 'managed:claude-oauth'

type ManagedProvider = 'anthropic' | 'openai' | 'openrouter'

function managedLabel(a: AccountView): string {
  if (a.id === CLAUDE_OAUTH_ID) return 'Claude subscription (setup-token)'
  return `${providerLabel(a.provider as ManagedProvider)} API key`
}

/** Connected: a filled signal dot + the masked identity in machine voice. In the
 *  Superade theme `--success` is calm blue (the "all good" hue — this theme has no
 *  green); other themes map it to their own success color. Kept as the semantic
 *  token so it stays on-brand per theme. */
function StatusConnected({ identity }: { identity: string }): JSX.Element {
  return (
    <span className="inline-flex flex-none items-center gap-1.5 rounded-full bg-success/10 py-0.5 pr-2 pl-1.5 text-[11px] text-success">
      <span aria-hidden="true" className="size-1.5 flex-none rounded-full bg-success" />
      <span className="max-w-[170px] truncate font-mono">{identity}</span>
    </span>
  )
}

/** Not connected: a hollow dot echoes the connected shape at rest, so the two
 *  states read as one on/off column rather than two unrelated treatments. */
function StatusDisconnected(): JSX.Element {
  return (
    <span className="inline-flex flex-none items-center gap-1.5 text-[11.5px] text-muted-foreground">
      <span aria-hidden="true" className="size-1.5 flex-none rounded-full ring-1 ring-border-strong ring-inset" />
      Not connected
    </span>
  )
}

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
    <div>
      <div className="mb-1.5 flex items-baseline gap-2 px-0.5">
        <span className="font-mono text-[8.5px] text-label uppercase tracking-[0.12em]">{label}</span>
        <span className="text-[10.5px] text-text-dim">{qualifier}</span>
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
function ManagedAccountRow({
  account,
  onChanged,
}: {
  account: AccountView
  onChanged: () => void
}): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [editing, setEditing] = useState(false)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isOauth = account.kind === 'oauth'
  const connected = account.status === 'connected'
  // A legacy key lives in settings.apiKeys, not the accounts table: there is no row
  // for `accounts.disconnect` to delete, so offering a Disconnect here would be a
  // button that reports success and changes nothing. Offer the honest action —
  // replace it with a managed credential (which IS disconnectable), or remove it
  // where it actually lives.
  const legacy = connected && account.credentialSource === 'legacy'
  const label = managedLabel(account)

  // The row's own explanation lives under its label (POD-127 F3), never as a
  // detached paragraph between rows. Exactly one applies at a time.
  const note: React.ReactNode =
    isOauth && !connected ? (
      <>
        Run <code className="text-[11px]">claude setup-token</code> in a terminal and paste the token
        here. It is a long-lived subscription token (about a year), not your API key.
      </>
    ) : legacy && !editing ? (
      <span className="text-warning">
        Set under Settings → API keys, not held as a managed account — Podium does not inject it into
        agent spawns and it cannot be disconnected here. Replace it to store it as a managed account,
        or clear it under API keys.
      </span>
    ) : !isOauth && connected && !legacy ? (
      <>
        Injected into agent spawns. The superagent and background LLM roles still read their key from
        Settings → API keys (issue #469), so this account does not power those.
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
            {legacy ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                Replace
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void disconnect()}
              >
                Disconnect
              </Button>
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
      {error && (
        <p className="max-w-[60ch] pb-2.5 text-[11px] text-destructive">{error}</p>
      )}
    </div>
  )
}

/** Accounts & Keys hub (SP-6454 stream B2; managed credentials #216): native CLI
 *  logins on this machine (observed read-only — each CLI's own `login` on the
 *  server owns those) + the managed credentials Podium holds and injects into
 *  agent spawns. Managed rows are connectable here: paste a provider API key, or
 *  a `claude setup-token` subscription token. The credential goes straight to the
 *  server's accounts table; the hub only ever reads back a masked identity. */
export function AccountsSection(): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [accounts, setAccounts] = useState<AccountView[] | null>(null)

  // The one loader: connect/disconnect refetch through this, so a row flips state
  // only once the server has confirmed it (no optimistic local truth for secrets).
  const refresh = useCallback(() => {
    trpc.accounts.list
      .query()
      .then((a) => setAccounts(a as AccountView[]))
      .catch(() => setAccounts([]))
  }, [trpc])
  useEffect(() => refresh(), [refresh])

  const native = (accounts ?? []).filter((a) => a.source === 'native')
  const managed = (accounts ?? []).filter((a) => a.source === 'managed')

  return (
    <Section
      title="Accounts & Keys"
      hint="How Podium authenticates to LLMs. Native logins are each CLI's own login on this server (managed with their own `login` command). Managed accounts are credentials Podium stores and injects into an agent's environment when it spawns — so any connected machine can run on them."
    >
      <div className="mt-3 space-y-5">
        <AccountGroup label="Native logins" qualifier="this machine">
          {native.map((a) => (
            <Row key={a.id} label={harnessAgentLabel((a.harness ?? a.provider) as HarnessAgent)}>
              {a.status === 'connected' ? (
                <StatusConnected identity={a.identity ?? 'connected'} />
              ) : (
                <StatusDisconnected />
              )}
            </Row>
          ))}
        </AccountGroup>
        <AccountGroup label="Managed accounts" qualifier="Podium-held">
          {managed.map((a) => (
            <ManagedAccountRow key={a.id} account={a} onChanged={refresh} />
          ))}
        </AccountGroup>
      </div>
      <p className="mt-3 max-w-[60ch] text-[11px] text-text-dim">
        Coming soon — rotating several subscription logins across agents.
      </p>
    </Section>
  )
}
