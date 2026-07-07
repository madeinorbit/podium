import type { AgentQuotaWire, MachineQuotaWire } from '@podium/protocol'
import { Gauge } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  agentLabel,
  formatReset,
  paceHint,
  paceLabel,
  percentTone,
  type QuotaPace,
  type QuotaTone,
  statusNote,
  toneBarClass,
  windowElapsedPercent,
  windowPace,
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

const PACE: Record<QuotaPace, string> = {
  comfortable: 'text-success',
  'on-pace': 'text-muted-foreground',
  hot: 'text-destructive',
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
 * fullness bar of the most-consumed plan window across every machine's agents.
 * Hover shows the per-agent summary; click opens the full per-window breakdown,
 * grouped by machine (each dev machine runs its agents under its own account).
 * Distinct from Usage & analytics (transcript-harvested token cost) — this is
 * plan rate-limit usage read live from each agent's own quota endpoint.
 */
export function QuotaIndicator({ compact = false }: { compact?: boolean }): JSX.Element | null {
  const { trpc } = useStore()
  const [machines, setMachines] = useState<MachineQuotaWire[] | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      trpc.quota.summary
        .query()
        .then((r) => {
          if (!cancelled) setMachines(r)
        })
        .catch(() => {
          if (!cancelled) setMachines((prev) => prev ?? [])
        })
    }
    load()
    const t = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [trpc])

  // Nothing to show until the first payload arrives, or when no machine reported
  // any agent quota.
  const allAgents = (machines ?? []).flatMap((m) => m.agents)
  if (!machines || allAgents.length === 0) return null

  const multiMachine = machines.filter((m) => m.agents.length > 0).length > 1
  const worst = worstPercent(allAgents)
  const tone = TONE[percentTone(worst)]

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
          <QuotaTooltipBody machines={machines} multiMachine={multiMachine} />
          <span className="text-background/70">Click for the breakdown</span>
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" aria-label="Agent quota">
          <DialogTitle>Agent quota</DialogTitle>
          <div className="flex flex-col gap-3">
            {machines
              .filter((m) => m.agents.length > 0)
              .map((m) => (
                <div key={m.machineId} className="flex flex-col gap-2">
                  {multiMachine && (
                    <div className="text-[11px] uppercase tracking-[0.04em] text-muted-foreground/70">
                      {m.machineName}
                      {m.hostname && m.hostname !== m.machineName ? ` · ${m.hostname}` : ''}
                    </div>
                  )}
                  {m.agents.map((a) => (
                    <AgentQuotaCard key={a.agent} a={a} />
                  ))}
                </div>
              ))}
            <p className="mt-0.5 mb-0 max-w-[60ch] text-xs text-muted-foreground">
              Read live from each agent's own usage endpoint on each dev machine. Percentages are
              the share of each rolling plan window consumed. Grok is omitted — it exposes no local
              quota.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Tooltip body: per-agent window summary, prefixed by machine name when more
 *  than one machine reported quota so two accounts don't blur together. */
function QuotaTooltipBody({
  machines,
  multiMachine,
}: {
  machines: MachineQuotaWire[]
  multiMachine: boolean
}): JSX.Element {
  const withOk = machines
    .map((m) => ({ machine: m, ok: m.agents.filter((a) => a.status === 'ok') }))
    .filter((m) => m.ok.length > 0)
  if (withOk.length === 0) {
    return <span className="text-background/70">No quota reported — click for detail</span>
  }
  return (
    <>
      {withOk.map(({ machine, ok }) => (
        <span key={machine.machineId} className="flex flex-col">
          {multiMachine && (
            <span className="text-background/60 uppercase tracking-[0.04em]">
              {machine.machineName}
            </span>
          )}
          {ok.map((a) => (
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
          ))}
        </span>
      ))}
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
            <QuotaWindowRow key={w.key} w={w} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}

function QuotaWindowRow({
  w,
  now,
}: {
  w: AgentQuotaWire['windows'][number]
  now: number
}): JSX.Element {
  const elapsed = windowElapsedPercent(w.resetsAt, w.windowMinutes, now)
  const pace = windowPace(w, now)
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{w.label}</span>
        <span className="flex items-center gap-1.5 text-foreground">
          {pace ? (
            <span
              className={cn('font-medium', PACE[pace])}
              title={elapsed !== null ? paceHint(pace, w.usedPercent, elapsed) : paceLabel(pace)}
            >
              {paceLabel(pace)}
            </span>
          ) : null}
          <span>
            {Math.round(w.usedPercent)}% · {formatReset(w.resetsAt, now)}
          </span>
        </span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn('h-full rounded-full', toneBarClass(percentTone(w.usedPercent)))}
          style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }}
        />
        {elapsed !== null ? (
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-foreground/35"
            style={{ left: `${Math.min(99, Math.max(1, elapsed))}%` }}
            title={`${Math.round(elapsed)}% of window elapsed`}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  )
}
