import type { AgentQuotaWire } from '@podium/protocol'
import { Gauge } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  agentLabel,
  formatReset,
  percentTone,
  type QuotaTone,
  statusNote,
  toneBarClass,
} from './quota'
import { useStore } from './store'

// Severity → status-strip colors, matching the host memory glyph's contract
// (HostIndicators): the bar fill is always tinted; the icon stays neutral while
// ok and recolors on warn/critical; the compact (icon-only) chip tints the glyph.
const TONE: Record<QuotaTone, { fill: string; icon: string; compact: string }> = {
  ok: { fill: 'bg-success', icon: '', compact: 'text-success' },
  warn: { fill: 'bg-warning', icon: 'text-warning', compact: 'text-warning' },
  crit: { fill: 'bg-destructive', icon: 'text-destructive', compact: 'text-destructive' },
}

/** Highest window utilization across all `ok` agents — the at-a-glance signal. */
function worstPercent(agents: AgentQuotaWire[]): number {
  let worst = 0
  for (const a of agents) {
    if (a.status !== 'ok') continue
    for (const w of a.windows) worst = Math.max(worst, w.usedPercent)
  }
  return worst
}

/**
 * Agent-quota status item. Lives in the host status strip (HostIndicators),
 * beside the memory and connection glyphs — a gauge icon + a severity-tinted
 * fullness bar of the most-consumed plan window across agents. Hover shows the
 * per-agent summary; click opens the full per-window breakdown. Distinct from
 * Usage & analytics (transcript-harvested token cost) — this is plan rate-limit
 * usage read live from each agent's own quota endpoint.
 */
export function QuotaIndicator({ compact = false }: { compact?: boolean }): JSX.Element | null {
  const { trpc } = useStore()
  const [agents, setAgents] = useState<AgentQuotaWire[] | null>(null)
  const [open, setOpen] = useState(false)

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

  // Nothing to show until the first payload arrives, or when no agent reported.
  if (!agents || agents.length === 0) return null

  const worst = worstPercent(agents)
  const tone = TONE[percentTone(worst)]
  const okAgents = agents.filter((a) => a.status === 'ok')

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(
                'group inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-0 bg-transparent p-0 text-[11px] text-muted-foreground',
                compact && cn('min-w-[30px] justify-center px-1', tone.compact),
              )}
              aria-label="Agent quota — click for the breakdown"
              onClick={() => setOpen(true)}
            >
              <Gauge size={14} aria-hidden="true" className={cn(!compact && tone.icon)} />
              {!compact && (
                <span
                  className="h-1 w-9 overflow-hidden rounded-sm bg-secondary"
                  role="presentation"
                >
                  <span className={cn('block h-full', tone.fill)} style={{ width: `${worst}%` }} />
                </span>
              )}
            </button>
          }
        />
        <TooltipContent className="max-w-60 flex-col items-start gap-0.5">
          <strong>Agent quota</strong>
          {okAgents.length === 0 ? (
            <span className="text-background/70">No quota reported — click for detail</span>
          ) : (
            okAgents.map((a) => (
              <span key={a.agent} className="text-background/70">
                {agentLabel(a.agent)} —{' '}
                {a.windows.map((w, i) => (
                  <span key={w.key}>
                    {i > 0 ? ' · ' : ''}
                    {w.label.replace('-hour', 'h').replace('Weekly', 'wk')}{' '}
                    {Math.round(w.usedPercent)}%
                  </span>
                ))}
              </span>
            ))
          )}
          <span className="text-background/70">Click for the breakdown</span>
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" aria-label="Agent quota">
          <DialogTitle>Agent quota</DialogTitle>
          <div className="flex flex-col gap-3">
            {agents.map((a) => (
              <AgentQuotaCard key={a.agent} a={a} />
            ))}
            <p className="mt-0.5 mb-0 max-w-[60ch] text-xs text-muted-foreground">
              Read live from each agent's own usage endpoint on the dev machine. Percentages are the
              share of each rolling plan window consumed. Grok is omitted — it exposes no local
              quota.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
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
