import { shallowEqual } from '@podium/client-core/store'
import {
  hostAgentsView,
  hostLoadView,
  hostMemoryView,
  listReclaimableWorktreesClient,
  RECLAIMABLE_WORKTREE_THRESHOLD,
  residencyBreakdown,
} from '@podium/client-core/viewmodels'
import { CircleArrowUp, CloudUpload, MemoryStick } from 'lucide-react'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { machineNeedsUpdate, useServerAppVersion } from '@/lib/version-skew'
import { ConnectionIndicator, describeHealth, useStableConnection } from './ConnectionIndicator'
import { HealthPopover } from './HealthPopover'
import {
  type HostInfoTab,
  HostInfoView,
  useHibernationSetting,
  useHostLifecycleSettings,
} from './HostMemoryView'
import { LoadPanel } from './LoadPanel'
import { OutboxRecoveryIndicator } from './OutboxRecovery'
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

/** Memory severity → the `data-tone` the header readout colours itself by. */
const TONE_KEY = { ok: 'ok', warn: 'warn', critical: 'crit' } as const

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
                  data-pressable
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
      <OutboxRecoveryIndicator compact={compact} />
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

/**
 * Machine health in the 44px desktop header. Memory, load, and agent residency
 * share one chip per machine (POD-563) — host pressure is more of the host
 * instrument, not a third group in the well.
 */
export function HeaderHostIndicators(): JSX.Element {
  const { hostMetrics, machines, sessions, trpc } = useStoreSelector(
    (s) => ({
      hostMetrics: s.hostMetrics,
      machines: s.machines,
      sessions: s.sessions,
      trpc: s.trpc,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const lifecycle = useHostLifecycleSettings()
  // POD-838: a daemon whose build trails the server silently loses additive protocol
  // features, so skew earns a spot in the 44px header, not just Settings → Machines.
  const serverAppVersion = useServerAppVersion(trpc)
  const { health } = useStableConnection()
  const [info, setInfo] = useState<{ tab: HostInfoTab; machineId?: string } | null>(null)
  const announce =
    health.status === 'ok'
      ? ''
      : (() => {
          const description = describeHealth(health, Date.now())
          return `${description.headline}. ${description.detail}`
        })()

  const afterDays = lifecycle?.worktreeGc.afterDays ?? 14
  const reclaimByMachine = useMemo(() => {
    const map = new Map<string, number>()
    for (const host of hostMetrics) {
      const id = host.machineId
      if (!id) continue
      map.set(
        id,
        listReclaimableWorktreesClient({
          issues,
          sessions,
          afterDays,
          machineId: id,
        }).length,
      )
    }
    return map
  }, [hostMetrics, issues, sessions, afterDays])

  return (
    <div className="topbar-well header-host-indicators">
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
      {hostMetrics.length === 0 && (
        <button
          data-pressable
          type="button"
          className="header-machine-chip"
          aria-label="Host connection — click for details"
          onClick={() => setInfo({ tab: 'connection' })}
        >
          <span
            className={cn(
              'size-1.5 flex-none rounded-full',
              health.status === 'ok'
                ? 'bg-success'
                : health.status === 'degraded'
                  ? 'bg-warning'
                  : 'bg-destructive',
            )}
            aria-hidden="true"
          />
          <span>host</span>
        </button>
      )}
      {hostMetrics.map((host) => {
        const memory = hostMemoryView(host)
        const load = hostLoadView(host, lifecycle?.hibernation.loadPerCore ?? null)
        const agents = hostAgentsView(
          sessions,
          host.machineId,
          lifecycle?.hibernation.maxIdleSessions ?? null,
          host.hostname,
        )
        const memTone = SEVERITY[memory.severity]
        const loadTone = SEVERITY[load.severity]
        const agentTone = SEVERITY[agents.severity]
        const machine = machines.find((m) => m.id === host.machineId)
        const needsUpdate = machine != null && machineNeedsUpdate(machine, serverAppVersion)
        const reclaimCount = host.machineId ? (reclaimByMachine.get(host.machineId) ?? 0) : 0
        const reclaimablePast =
          reclaimCount >= RECLAIMABLE_WORKTREE_THRESHOLD && health.status === 'ok'
        const phases = residencyBreakdown(sessions, host.machineId)
        const agentTitleParts = [
          agents.title,
          phases.working > 0 || phases.idle > 0 || phases.waiting > 0
            ? `${phases.working} working, ${phases.idle} idle, ${phases.waiting} waiting on you`
            : null,
        ].filter(Boolean)
        const aria = [
          host.hostname,
          memory.title,
          load.title,
          agentTitleParts.join(' — '),
          reclaimablePast ? `${reclaimCount} reclaimable worktrees` : null,
        ]
          .filter(Boolean)
          .join('; ')
        return (
          <HealthPopover
            key={host.machineId}
            trigger={
              <button
                data-pressable
                type="button"
                className="header-machine-chip"
                aria-label={aria}
                title={agentTitleParts.join(' — ')}
              >
                <span
                  className={cn(
                    'size-1.5 flex-none rounded-full',
                    health.status === 'ok'
                      ? reclaimablePast
                        ? 'bg-warning'
                        : 'bg-success'
                      : health.status === 'degraded'
                        ? 'bg-warning'
                        : 'bg-destructive',
                  )}
                  aria-hidden="true"
                />
                <span className="header-machine-name">{host.hostname}</span>
                {needsUpdate && (
                  <CircleArrowUp
                    size={12}
                    className="flex-none text-warning"
                    aria-label="Update available"
                  />
                )}
                <span className="header-readout">
                  <span className="header-mark">MEM</span>
                  <span className="header-meter" role="presentation">
                    <span
                      className={cn('block h-full', memTone.fill)}
                      style={{ width: `${memory.pct}%` }}
                    />
                  </span>
                  <span className="header-value" data-tone={TONE_KEY[memory.severity]}>
                    {memory.pct}%
                  </span>
                </span>
                <span className="header-readout">
                  <span className="header-mark">LOAD</span>
                  <span className="header-meter" role="presentation">
                    <span
                      className={cn('block h-full', loadTone.fill)}
                      style={{ width: `${load.meterPct}%` }}
                    />
                  </span>
                  <span className="header-value" data-tone={TONE_KEY[load.severity]}>
                    {load.label}
                  </span>
                </span>
                <span className="header-readout header-agent-readout">
                  <span className="header-mark">AGT</span>
                  {agents.meterPct != null && (
                    <span className="header-meter" role="presentation">
                      <span
                        className={cn('block h-full', agentTone.fill)}
                        style={{ width: `${agents.meterPct}%` }}
                      />
                    </span>
                  )}
                  <span className="header-value" data-tone={TONE_KEY[agents.severity]}>
                    {agents.count}
                  </span>
                </span>
              </button>
            }
          >
            {(pinned) => (
              <LoadPanel
                machineId={host.machineId}
                pinned={pinned}
                updateNote={
                  needsUpdate ? (
                    <div className="hp-dim-line text-warning">
                      Update available: {machine?.inventory?.podiumVersion} → {serverAppVersion} —
                      run podium update on this machine
                    </div>
                  ) : undefined
                }
                onOpenConnection={() => setInfo({ tab: 'connection', machineId: host.machineId })}
                onOpenReclaim={() => setInfo({ tab: 'reclaim', machineId: host.machineId })}
              />
            )}
          </HealthPopover>
        )
      })}
      <OutboxRecoveryIndicator compact />
      {/* POD-318/POD-365 — the hairline that divides the host group from the
          quota group INSIDE the instrument well. Grouping by hairline is how
          every other section of the shell divides; a wider gap alone read as one
          undifferentiated run. */}
      <span className="header-strip-seam" aria-hidden="true" />
      <QuotaIndicator header />
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
