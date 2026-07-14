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

function connectedPill(a: AccountView): JSX.Element {
  return <span className="flex-none text-[12px] text-success">● {a.identity ?? 'connected'}</span>
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
  const label = managedLabel(account)

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
      <Row label={label}>
        {connected ? (
          <>
            {connectedPill(account)}
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
        ) : editing ? (
          <>
            <Input
              type="password"
              autoComplete="off"
              autoFocus
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
          </>
        ) : (
          <>
            <span className="flex-none text-[12px] text-muted-foreground">not connected</span>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              Connect
            </Button>
          </>
        )}
      </Row>
      {isOauth && !connected && (
        <p className="mb-1 max-w-[60ch] text-[12px] text-muted-foreground">
          Run <code className="text-[11px]">claude setup-token</code> in a terminal and paste the
          token here. It is a long-lived subscription token (about a year) and is not your API key.
        </p>
      )}
      {error && <p className="mb-1 max-w-[60ch] text-[12px] text-destructive">{error}</p>}
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
      <div className="mb-1 text-[12px] font-medium text-muted-foreground">
        Native logins (this machine)
      </div>
      {native.map((a) => (
        <Row key={a.id} label={harnessAgentLabel((a.harness ?? a.provider) as HarnessAgent)}>
          {a.status === 'connected' ? (
            connectedPill(a)
          ) : (
            <span className="flex-none text-[12px] text-muted-foreground">not connected</span>
          )}
        </Row>
      ))}
      <div className="mt-4 mb-1 text-[12px] font-medium text-muted-foreground">
        Managed accounts (Podium-held)
      </div>
      {managed.map((a) => (
        <ManagedAccountRow key={a.id} account={a} onChanged={refresh} />
      ))}
      <p className="mt-3 max-w-[60ch] text-[12px] text-muted-foreground">
        Coming soon — rotating several subscription logins across agents.
      </p>
    </Section>
  )
}
