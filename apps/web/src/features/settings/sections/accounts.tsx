import type { HarnessAgent } from '@podium/runtime'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { type AccountView, harnessAgentLabel, providerLabel, Row, Section } from './shared'

/** Accounts & Keys hub (SP-6454, stream B2): native CLI logins on this machine
 *  (observed read-only) + managed API keys, and where managed credential
 *  injection / oauth rotation will live ("Coming soon"). Read-only for now —
 *  API keys are edited under the API keys tab; native logins are managed by each
 *  CLI's own `login` on the server. */
export function AccountsSection(): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [accounts, setAccounts] = useState<AccountView[] | null>(null)
  useEffect(() => {
    trpc.accounts.list
      .query()
      .then((a) => setAccounts(a as AccountView[]))
      .catch(() => setAccounts([]))
  }, [trpc])

  const native = (accounts ?? []).filter((a) => a.source === 'native')
  const managed = (accounts ?? []).filter((a) => a.source === 'managed')
  const statusPill = (a: AccountView): JSX.Element =>
    a.status === 'connected' ? (
      <span className="flex-none text-[12px] text-success">● {a.identity ?? 'connected'}</span>
    ) : (
      <span className="flex-none text-[12px] text-muted-foreground">not connected</span>
    )

  return (
    <Section
      title="Accounts & Keys"
      hint="How Podium authenticates to LLMs. Native logins are each CLI's own login on this server (managed with their own `login` command); API keys are stored by Podium and edited under API keys."
    >
      <div className="mb-1 text-[12px] font-medium text-muted-foreground">
        Native logins (this machine)
      </div>
      {native.map((a) => (
        <Row key={a.id} label={harnessAgentLabel((a.harness ?? a.provider) as HarnessAgent)}>
          {statusPill(a)}
        </Row>
      ))}
      <div className="mt-4 mb-1 text-[12px] font-medium text-muted-foreground">
        API keys (managed)
      </div>
      {managed.map((a) => (
        <Row key={a.id} label={providerLabel(a.provider as 'openrouter' | 'anthropic' | 'openai')}>
          {statusPill(a)}
        </Row>
      ))}
      <div className="mt-4 flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled>
          Add managed account
        </Button>
        <span className="text-[12px] text-muted-foreground">
          Coming soon — run a harness on a key you provide, or rotate multiple subscription logins.
          Today, harnesses use each CLI's own login on this server.
        </span>
      </div>
    </Section>
  )
}
