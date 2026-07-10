import { shallowEqual } from '@podium/client-core/store'
import { CloudUpload, MemoryStick } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { hostMemoryView } from '@/lib/derive'
import { cn } from '@/lib/utils'
import { ConnectionIndicator, describeHealth, useStableConnection } from './ConnectionIndicator'
import { type HostInfoTab, HostInfoView, useHibernationSetting } from './HostMemoryView'
import { QuotaIndicator } from './QuotaIndicator'

// Memory pressure → colors, reproducing the legacy `.mem-*` contract: the bar
// fill is always tinted by severity; the icon stays neutral while `ok` and only
// recolors on warn/critical; the compact (icon-only) chip carries severity on
// the whole glyph (green when fine → warning → destructive).
const SEVERITY = {
  ok: { fill: 'bg-success', icon: '', compact: 'text-success' },
  warn: { fill: 'bg-warning', icon: 'text-warning', compact: 'text-warning' },
  critical: {
    fill: 'bg-destructive',
    icon: 'text-destructive',
    compact: 'text-destructive',
  },
} as const

/**
 * Host health strip. Just two glyphs: a memory icon with a fullness bar (one per
 * daemon machine) and — only while the link is degraded or down — the connection
 * icon beside it. An always-green connection icon and a running GB readout are
 * both noise; the bar conveys pressure at a glance and a click opens the numbers.
 *
 * `compact` (mobile header) drops the bar, leaving the severity-colored icon —
 * header pixels belong to session selection there. Tapping either still opens
 * the per-process breakdown / connection detail.
 */
export function HostIndicators({ compact = false }: { compact?: boolean }): JSX.Element {
  const { hostMetrics, outboxSize } = useStoreSelector(
    (s) => ({ hostMetrics: s.hostMetrics, outboxSize: s.outboxSize }),
    shallowEqual,
  )
  const { health, visible: connVisible } = useStableConnection()
  const hibernation = useHibernationSetting()
  // The open host-info modal, plus which machine it's about. A memory chip opens
  // its own machine; the connection glyph is machine-agnostic (its tab lists all
  // hosts), so it opens without a specific machine.
  const [info, setInfo] = useState<{ tab: HostInfoTab; machineId?: string } | null>(null)
  const showHostname = !compact && hostMetrics.length > 1
  // The visible icon only shows the detail on hover; a persistent polite live
  // region announces degraded/down transitions to assistive tech (empty while
  // healthy, so recovery isn't announced as noise). HostIndicators re-renders
  // only on health change, so the message isn't re-announced every second.
  const announce =
    health.status === 'ok'
      ? ''
      : (() => {
          const d = describeHealth(health, Date.now())
          return `${d.headline}. ${d.detail}`
        })()
  return (
    <div
      className={cn(
        'flex items-center',
        compact
          ? 'gap-0 flex-nowrap'
          : 'mt-auto flex-wrap gap-1.5 border-t border-border bg-card px-3 py-2',
      )}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
      {hostMetrics.map((host) => {
        const mem = hostMemoryView(host)
        const tone = SEVERITY[mem.severity]
        // "X/Y GB (Z%)" — mem.label is already "X/Y GB".
        const summary = `${mem.label} (${mem.pct}%)`
        // Note auto-hibernation only when it's switched on: emphasise that it's
        // actively reclaiming once memory crosses the configured threshold,
        // otherwise just say it's standing by.
        const hibNote = hibernation?.enabled
          ? mem.pct >= hibernation.memoryPct
            ? 'Hibernating stale agents to free memory'
            : 'Auto-hibernation on — idle agents park if memory runs high'
          : null
        return (
          <Tooltip key={host.hostname}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    'group inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-0 bg-transparent p-0 text-[11px] text-muted-foreground',
                    compact && cn('min-w-[30px] justify-center px-1', tone.compact),
                  )}
                  aria-label={`${mem.title} — click for the breakdown`}
                  onClick={() => setInfo({ tab: 'memory', machineId: host.machineId })}
                >
                  {showHostname && (
                    <span className="max-w-[9ch] overflow-hidden text-ellipsis text-muted-foreground/70">
                      {host.hostname}
                    </span>
                  )}
                  <MemoryStick size={14} aria-hidden="true" className={cn(!compact && tone.icon)} />
                  {!compact && (
                    <span
                      className="h-1 w-9 overflow-hidden rounded-sm bg-secondary"
                      role="presentation"
                    >
                      <span
                        className={cn('block h-full', tone.fill)}
                        style={{ width: `${mem.pct}%` }}
                      />
                    </span>
                  )}
                </button>
              }
            />
            <TooltipContent className="max-w-60 flex-col items-start gap-0.5">
              <strong>{hostMetrics.length > 1 ? `${host.hostname} — ${summary}` : summary}</strong>
              {hibNote && <span className="text-background/70">{hibNote}</span>}
              <span className="text-background/70">Click for the breakdown</span>
            </TooltipContent>
          </Tooltip>
        )
      })}
      {connVisible && (
        <ConnectionIndicator health={health} onOpen={() => setInfo({ tab: 'connection' })} />
      )}
      {/* Offline-authored writes waiting in the client outbox. Appears only while
          something is actually pending — a permanent "0 pending" would be noise. */}
      {outboxSize > 0 && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  'inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground',
                  compact && 'min-w-[30px] justify-center px-1',
                )}
              >
                <CloudUpload size={14} aria-hidden="true" />
                {!compact && <span>{outboxSize} pending</span>}
              </span>
            }
          />
          <TooltipContent className="max-w-60 flex-col items-start gap-0.5">
            <strong>
              {outboxSize} pending {outboxSize === 1 ? 'change' : 'changes'}
            </strong>
            <span className="text-background/70">changes queued — will sync when reconnected</span>
          </TooltipContent>
        </Tooltip>
      )}
      <QuotaIndicator compact={compact} />
      {info && (
        <HostInfoView
          initialTab={info.tab}
          machineId={info.machineId}
          onClose={() => setInfo(null)}
        />
      )}
    </div>
  )
}
