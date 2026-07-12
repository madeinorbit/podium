import type { AgentQuotaWire, MachineQuotaWire } from '@podium/protocol'
import { Gauge } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  type AccountQuotaGroup,
  agentLabel,
  formatReset,
  groupQuotaByAccount,
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

/** Highest window utilization across all `ok` accounts — the at-a-glance signal. */
function worstPercent(groups: AccountQuotaGroup[]): number {
  let worst = 0
  for (const g of groups) {
    if (g.status !== 'ok') continue
    for (const w of g.windows) worst = Math.max(worst, w.usedPercent)
  }
  return worst
}

/** The most-consumed window with its account — drives the inline status-bar label. */
function worstWindow(
  groups: AccountQuotaGroup[],
): { g: AccountQuotaGroup; w: AccountQuotaGroup['windows'][number] } | null {
  let hit: { g: AccountQuotaGroup; w: AccountQuotaGroup['windows'][number] } | null = null
  for (const g of groups) {
    if (g.status !== 'ok') continue
    for (const w of g.windows) {
      if (!hit || w.usedPercent > hit.w.usedPercent) hit = { g, w }
    }
  }
  return hit
}

/**
 * Agent-quota status item. Lives in the host status strip (HostIndicators),
 * beside the memory and connection glyphs — a gauge icon + a severity-tinted
 * fullness bar of the most-consumed plan window across every account.
 * Hover shows the per-account summary; click opens the full per-window breakdown.
 * Rate limits are per-account, so the breakdown is grouped by account (with the
 * machine[s] each is used on) and deduped — never the same limit twice. Distinct
 * from Usage & analytics (transcript-harvested token cost) — this is plan
 * rate-limit usage read live from each agent's own quota endpoint.
 */
export function QuotaIndicator({
  compact = false,
  detail = false,
}: {
  compact?: boolean
  /** Render the worst window as inline text ("Claude Code 68% · resets in 2h 14m"). */
  detail?: boolean
}): JSX.Element | null {
  const trpc = useStoreSelector((s) => s.trpc)
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

  // Nothing to show until the first payload arrives, or when no account is
  // signed in on any machine (unauthenticated agents are dropped by grouping).
  const groups = groupQuotaByAccount(machines ?? [])
  if (!machines || groups.length === 0) return null

  const worst = worstPercent(groups)
  const tone = TONE[percentTone(worst)]
  const worstW = worstWindow(groups)

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
              {!compact && detail && worstW && (
                <span className="whitespace-nowrap text-[#6c6c78]">
                  {agentLabel(worstW.g.agent)} {Math.round(worstW.w.usedPercent)}% ·{' '}
                  {formatReset(worstW.w.resetsAt, Date.now())}
                </span>
              )}
            </button>
          }
        />
        <TooltipContent className="max-w-60 flex-col items-start gap-0.5">
          <strong>Agent quota</strong>
          <QuotaTooltipBody groups={groups} />
          <span className="text-background/70">Click for the breakdown</span>
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" aria-label="Agent quota">
          <DialogTitle>Agent quota</DialogTitle>
          <div className="flex flex-col gap-3">
            {groups.map((g) => (
              <AccountQuotaCard key={g.key} g={g} />
            ))}
            <p className="mt-0.5 mb-0 max-w-[60ch] text-xs text-muted-foreground">
              Read live from each agent's own usage endpoint on each dev machine. Limits are
              per-account, so machines signed into the same account share one entry. Percentages are
              the share of each rolling plan window consumed. Grok is omitted — it exposes no local
              quota.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Tooltip body: one line per account, with its window summary. */
function QuotaTooltipBody({ groups }: { groups: AccountQuotaGroup[] }): JSX.Element {
  const ok = groups.filter((g) => g.status === 'ok')
  if (ok.length === 0) {
    return <span className="text-background/70">No quota reported — click for detail</span>
  }
  return (
    <>
      {ok.map((g) => (
        <span key={g.key} className="text-background/70">
          {agentLabel(g.agent)}
          {g.account?.email ? ` (${g.account.email})` : ''} —{' '}
          {g.windows.map((w, i) => (
            <span key={w.key}>
              {i > 0 ? ' · ' : ''}
              {w.label.replace('-hour', 'h').replace('Weekly', 'wk')} {Math.round(w.usedPercent)}%
            </span>
          ))}
        </span>
      ))}
    </>
  )
}

/** One account card: agent + plan, the account email and the machine(s) it's used
 *  on, then either the per-window bars (ok) or a short status note. */
function AccountQuotaCard({ g }: { g: AccountQuotaGroup }): JSX.Element {
  const now = Date.now()
  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-foreground">
          {agentLabel(g.agent)}
          {g.account?.plan ? (
            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground/70">
              {g.account.plan}
            </span>
          ) : null}
        </div>
        <div className="truncate text-right text-[11px] text-muted-foreground/70">
          {g.machineNames.join(', ')}
        </div>
      </div>
      {g.account?.email ? (
        <div className="truncate text-[11px] text-muted-foreground/70">{g.account.email}</div>
      ) : null}
      {g.status !== 'ok' ? (
        <div className="mt-1.5 text-xs text-muted-foreground/70">{statusNote(g)}</div>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {g.windows.map((w) => (
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
