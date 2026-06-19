import type { AgentQuotaWire } from '@podium/protocol'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { agentLabel, formatReset, percentTone, statusNote, toneBarClass } from './quota'
import { useStore } from './store'

/**
 * Agent quota — a full main-content surface (not a modal): live plan-quota usage
 * per agent (Claude 5h+weekly, Codex 5h+weekly), read read-only on the daemon
 * host. Distinct from Usage & analytics, which shows transcript-harvested token
 * cost. Reached from the sidebar tools row.
 */
export function QuotaView(): JSX.Element {
  const { trpc, setView } = useStore()
  const [agents, setAgents] = useState<AgentQuotaWire[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      trpc.quota.summary
        .query()
        .then((r) => {
          if (!cancelled) setAgents(r.agents)
        })
        .catch(() => {
          if (!cancelled) setAgents((prev) => prev ?? [])
        })
    }
    load()
    const t = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [trpc])

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Agent quota">
      <div className="flex items-center justify-between border-b border-border px-[22px] py-3.5">
        <h2 className="m-0 text-base font-medium text-foreground">Agent quota</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Close agent quota"
          onClick={() => setView('home')}
        >
          ✕
        </Button>
      </div>
      {agents === null ? (
        <div className="px-4 py-3.5 text-xs text-muted-foreground/70">Loading quota…</div>
      ) : agents.length === 0 ? (
        <div className="px-4 py-3.5 text-xs text-muted-foreground/70">
          No agents reported quota (daemon offline?).
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3.5">
          {agents.map((a) => (
            <AgentQuotaCard key={a.agent} a={a} />
          ))}
          <p className="mt-1 mb-0.5 max-w-[60ch] text-xs text-muted-foreground">
            Read live from each agent's own usage endpoint on the dev machine. Percentages are the
            share of each rolling plan window consumed. Grok is omitted — it exposes no local quota.
          </p>
        </div>
      )}
    </section>
  )
}

function AgentQuotaCard({ a }: { a: AgentQuotaWire }): JSX.Element {
  const now = Date.now()
  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">{agentLabel(a.agent)}</div>
        {a.account?.email ? (
          <div className="text-[11px] text-muted-foreground/70">
            {a.account.email}
            {a.account.plan ? ` · ${a.account.plan}` : ''}
          </div>
        ) : null}
      </div>
      {a.status !== 'ok' ? (
        <div className="mt-1.5 text-xs text-muted-foreground/70">{statusNote(a)}</div>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {a.windows.map((w) => (
            <div key={w.key}>
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{w.label}</span>
                <span className="text-foreground">
                  {Math.round(w.usedPercent)}% · {formatReset(w.resetsAt, now)}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className={`h-full rounded-full ${toneBarClass(percentTone(w.usedPercent))}`}
                  style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
