import type { UsageBucketWire } from '@podium/protocol'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useStore } from './store'
import { formatTokens, formatUsd, usageSummary } from './usage'

/**
 * Usage & analytics — a full main-content surface (not a modal): rolling 5h + 7d
 * token consumption across the machine's harness transcripts, a per-day bar
 * chart, and a per-model cost table. Reached from the sidebar tools row (desktop)
 * and the picker-sheet actions (mobile).
 */
export function UsageView(): JSX.Element {
  const { trpc, setView } = useStore()
  const [buckets, setBuckets] = useState<UsageBucketWire[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      trpc.usage.summary
        .query()
        .then((r) => {
          if (!cancelled) setBuckets(r.buckets)
        })
        .catch(() => {})
    }
    load()
    const t = setInterval(load, 90_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [trpc])

  return (
    <section
      className="flex min-w-0 flex-1 flex-col overflow-hidden"
      aria-label="Usage & analytics"
    >
      <div className="flex items-center justify-between border-b border-border px-[22px] py-3.5">
        <h2 className="m-0 text-base font-medium text-foreground">Usage & analytics</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Close analytics"
          onClick={() => setView('home')}
        >
          ✕
        </Button>
      </div>
      {buckets === null ? (
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-3.5">
          <div className="p-3 text-xs text-muted-foreground/70">Loading usage…</div>
        </div>
      ) : buckets.length === 0 ? (
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-3.5">
          <div className="p-3 text-xs text-muted-foreground/70">
            No token usage recorded yet.
          </div>
        </div>
      ) : (
        <UsageBody buckets={buckets} />
      )}
    </section>
  )
}

function UsageBody({ buckets }: { buckets: UsageBucketWire[] }): JSX.Element {
  const s = usageSummary(buckets, Date.now())
  const maxDay = Math.max(1, ...s.days.map((d) => d.totalTokens))
  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-3.5">
      <div className="flex gap-2.5">
        <div className="flex-1 rounded-md border border-border px-3 py-2.5">
          <div className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
            Last 5 hours
          </div>
          <div className="my-0.5 text-2xl font-bold text-foreground">
            {formatTokens(s.fiveHour.totalTokens)}
          </div>
          <div className="text-[11px] text-muted-foreground/70">
            {s.fiveHour.messages} replies · {formatUsd(s.fiveHour.estCostUsd)} API-equivalent
          </div>
        </div>
        <div className="flex-1 rounded-md border border-border px-3 py-2.5">
          <div className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
            Last 7 days
          </div>
          <div className="my-0.5 text-2xl font-bold text-foreground">
            {formatTokens(s.week.totalTokens)}
          </div>
          <div className="text-[11px] text-muted-foreground/70">
            {s.week.messages} replies · {formatUsd(s.week.estCostUsd)} API-equivalent
          </div>
        </div>
      </div>
      <div className="flex h-24 items-end gap-2 px-1">
        {s.days.map((d) => (
          <div
            key={d.day}
            className="flex h-full flex-1 flex-col items-center justify-end gap-1"
          >
            <div
              className="w-full max-w-[42px] rounded-t-[3px] bg-primary opacity-85"
              style={{ height: `${Math.max(2, (d.totalTokens / maxDay) * 72)}px` }}
              title={`${d.day}: ${formatTokens(d.totalTokens)} tokens · ${formatUsd(d.estCostUsd)}`}
            />
            <div className="text-[10px] text-muted-foreground/70">{d.day.slice(5)}</div>
          </div>
        ))}
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="border-b border-border px-2 py-1 text-left text-[11px] font-semibold text-muted-foreground">
              Model
            </th>
            <th className="border-b border-border px-2 py-1 text-left text-[11px] font-semibold text-muted-foreground">
              Tokens (7d)
            </th>
            <th className="border-b border-border px-2 py-1 text-left text-[11px] font-semibold text-muted-foreground">
              Replies
            </th>
            <th className="border-b border-border px-2 py-1 text-left text-[11px] font-semibold text-muted-foreground">
              API-equivalent
            </th>
          </tr>
        </thead>
        <tbody>
          {s.models.map((m) => (
            <tr key={m.model}>
              <td className="border-b border-border px-2 py-1 text-foreground">{m.model}</td>
              <td className="border-b border-border px-2 py-1 text-foreground">
                {formatTokens(m.totalTokens)}
              </td>
              <td className="border-b border-border px-2 py-1 text-foreground">{m.messages}</td>
              <td className="border-b border-border px-2 py-1 text-foreground">
                {formatUsd(m.estCostUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 mb-0.5 max-w-[60ch] text-xs text-muted-foreground">
        Harvested from harness transcripts on the dev machine (Claude Code today; Codex when its
        logs join). Cost is the public API list-price equivalent of the same tokens — what this work
        would have cost off-subscription. Windows are rolling.
      </p>
    </div>
  )
}
