import { headerDataLayer } from '@/lib/header-data-layer'
import { useHeaderActions, usePoolHeaderMetrics, usePoolMetricIds, usePoolMetric, usePoolMachine, usePoolHostAggregate, usePoolReclaimCounts, usePoolOfflineMachines, useHeaderOutboxSize } from '@/app/header-data'
import type { HeaderAggregate } from '@podium/client-graph/header-views'
import type { HostMetricsWire, MachineWire } from '@podium/model/browser'
import { memo } from 'react'
import { measureHeader, measureLegacyHeader } from '@podium/client-core/perf'
import { shallowEqual } from '@podium/client-core/store'
import {
  createHostSessionAggregatesSelector,
  hostAgentsViewFromCounts,
  hostDiskView,
  hostLoadView,
  hostMemoryView,
  listReclaimableWorktreesClient,
  occupiedRootsFromKey,
  placeReclaimable,
  RECLAIMABLE_WORKTREE_THRESHOLD,
} from '@podium/client-core/viewmodels'
import type { MachineId } from '@podium/model/browser'
import { isMachineOfflineForLiveTerminal } from '@podium/model/browser'
import { CircleArrowUp, CloudUpload, MemoryStick } from 'lucide-react'
import type { JSX } from 'react'
import { lazy, Suspense, useMemo, useState } from 'react'
import { useHostMetrics, useReplicaIssues, useStoreSelector } from '@/app/store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { throughRestarts } from '@/lib/chunk-recovery'
import { cn } from '@/lib/utils'
import { machineNeedsUpdate, useServerAppVersion } from '@/lib/version-skew'
import { MessageNoticeIndicator } from '../chat/MessageNotices'
import { ConnectionIndicator, describeHealth, useStableConnection } from './ConnectionIndicator'
import { HealthPopover } from './HealthPopover'
import type { HostInfoTab } from './HostMemoryView'
import { headerOfflineMachines } from './header-offline-machines'
import { useHibernationSetting, useHostLifecycleSettings } from './host-lifecycle-settings'
import { OutboxRecoveryIndicator } from './OutboxRecovery'
import { QuotaIndicator } from './QuotaIndicator'
import { SEVERITY, TONE_KEY } from './severity'

// The chips themselves are permanent header chrome, but everything behind them
// opens on demand: the info modal after a click, the load breakdown once the
// popover opens (Base UI mounts popup content only then). Loading those on
// interaction keeps ~40k of panel UI out of the eager bundle the budget prices.
const HostInfoView = lazy(() =>
  throughRestarts(() => import('./HostMemoryView')).then((module) => ({
    default: module.HostInfoView,
  })),
)
const LoadPanel = lazy(() =>
  throughRestarts(() => import('./LoadPanel')).then((module) => ({ default: module.LoadPanel })),
)

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
  const useMetrics = headerDataLayer() === 'pool' ? usePoolHeaderMetrics : useHostMetrics
  const hostMetrics = useMetrics()
  const outboxSize = useHeaderOutboxSize()
  const { health, visible: connVisible } = useStableConnection()
  const hibernation = useHibernationSetting()
  // The open host-info modal, plus which machine it's about. A memory chip opens
  // its own machine; the connection glyph is machine-agnostic (its tab lists all
  // hosts), so it opens without a specific machine.
  const [info, setInfo] = useState<{ tab: HostInfoTab; machineId?: MachineId } | null>(null)
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
      <MessageNoticeIndicator compact={compact} />
      <QuotaIndicator compact={compact} />
      {info && (
        <Suspense fallback={null}>
          <HostInfoView
            initialTab={info.tab}
            machineId={info.machineId}
            onClose={() => setInfo(null)}
          />
        </Suspense>
      )}
    </div>
  )
}

/**
 * Machine health in the 44px desktop header. Memory, load, and agent residency
 * share one chip per machine (POD-563) — host pressure is more of the host
 * instrument, not a third group in the well.
 */
function LegacyHeaderHostIndicators(): JSX.Element {
  const hostMetrics = useHostMetrics()
  const { machines, sessions, trpc } = useStoreSelector(
    (s) => ({
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
  const [info, setInfo] = useState<{ tab: HostInfoTab; machineId?: MachineId } | null>(null)
  const announce =
    health.status === 'ok'
      ? ''
      : (() => {
          const description = describeHealth(health, Date.now())
          return `${description.headline}. ${description.detail}`
        })()

  const afterDays = lifecycle?.worktreeGc.afterDays ?? 14
  // POD-4830: live-terminal presence per machine (online OR daemon). A
  // supervised daemon loss keeps `online` true while the execution plane is
  // gone — the same signal the chat/terminal banners read — so the chip dot
  // must read it too, or a frozen daemon leaves the chip blue with no banner.
  // POD-4965: only machines still in use — a retired row is history, not a chip.
  // `hostMetrics` refreshes on every sample, so the recency clock rides along.
  const offlineWithoutMetrics = useMemo(
    () =>
      headerOfflineMachines(
        machines,
        new Set(hostMetrics.flatMap((h) => (h.machineId ? [h.machineId] : []))),
        Date.now(),
      ),
    [machines, hostMetrics],
  )
  // One scan for every machine, grouped afterwards, rather than one scan per
  // host — and keyed on what the scan can actually see. The sessions slice is
  // replaced on every token count and phase flip; only where live agents STAND
  // can move a checkout in or out of the list, so the memo depends on that key
  // (`occupancyKey`) instead of on the array. `issues` stays a plain dep: its
  // identity already changes only when an issue row does.
  const selectAggregates = useMemo(() => createHostSessionAggregatesSelector(), [])
  const aggregates = measureLegacyHeader(trpc, 'hostAggregates', () => selectAggregates(sessions))
  const occupancyKey = aggregates.occupancyKey
  const soleMachine = hostMetrics.length === 1
  const soleMachineId = hostMetrics[0]?.machineId
  const reclaimByMachine = useMemo(() => {
    const map = new Map<string, number>()
    if (hostMetrics.length === 0) return map
    const candidates = listReclaimableWorktreesClient({
      issues,
      occupiedRoots: occupiedRootsFromKey(occupancyKey),
      afterDays,
    })
    for (const candidate of placeReclaimable(candidates, { soleMachine }).here) {
      // Unattributed rows land on the sole machine; placeReclaimable already
      // refused to place them when there is more than one.
      const id = candidate.machineId ?? soleMachineId
      if (!id) continue
      map.set(id, (map.get(id) ?? 0) + 1)
    }
    return map
  }, [hostMetrics.length, soleMachine, soleMachineId, issues, occupancyKey, afterDays])

  return (
    <div className="topbar-well header-host-indicators">
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
      {hostMetrics.length === 0 && offlineWithoutMetrics.length === 0 && (
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
      {hostMetrics.map((host) => (
        <HeaderMachineChip key={host.machineId ?? host.hostname} host={host}
          machine={machines.find((machine) => machine.id === host.machineId)}
          aggregate={aggregates.forMachine(host.machineId)} lifecycle={lifecycle}
          serverAppVersion={serverAppVersion} healthStatus={health.status}
          reclaimCount={host.machineId ? reclaimByMachine.get(host.machineId) ?? 0 : 0}
          onInfo={setInfo} />
      ))}
      {/* POD-4830: a daemon loss deletes its hostMetrics (hosts service drops
          the sample on `machine.disconnected`), so an offline machine would
          otherwise vanish instead of reading offline. Render it from the
          machines list — destructive dot + name + offline — so the chip follows
          presence offline after the detach and back online on reattach, when
          metrics resume and this row hands back to the live chip above. */}
      {offlineWithoutMetrics.map((machine) => (
        <button
          key={machine.id}
          data-pressable
          type="button"
          className="header-machine-chip"
          aria-label={`${machine.name ?? machine.id}; offline`}
          onClick={() => setInfo({ tab: 'connection', machineId: machine.id as MachineId })}
        >
          <span
            className={cn('size-1.5 flex-none rounded-full', 'bg-destructive')}
            aria-hidden="true"
          />
          <span className="header-machine-name">{machine.name ?? machine.id}</span>
          <span className="header-readout">
            <span className="header-value" data-tone="bad">
              offline
            </span>
          </span>
        </button>
      ))}
      <OutboxRecoveryIndicator compact />
      <MessageNoticeIndicator compact />
      {/* The chamber rule between host pressure and plan quota. Taller and
          given air so the two groups stop reading as one run of meters. */}
      <span className="header-strip-seam" aria-hidden="true" />
      <QuotaIndicator header />
      {info && (
        <Suspense fallback={null}>
          <HostInfoView
            initialTab={info.tab}
            machineId={info.machineId}
            onClose={() => setInfo(null)}
          />
        </Suspense>
      )}
    </div>
  )
}

export function HeaderHostIndicators(): JSX.Element {
  return headerDataLayer() === 'pool' ? <PoolHeaderHostIndicators /> : <LegacyHeaderHostIndicators />
}

type OpenHostInfo = (info: { tab: HostInfoTab; machineId?: MachineId }) => void
interface MachineChipProps {
  host: HostMetricsWire
  machine: MachineWire | undefined
  aggregate: HeaderAggregate
  lifecycle: ReturnType<typeof useHostLifecycleSettings>
  serverAppVersion: ReturnType<typeof useServerAppVersion>
  healthStatus: 'ok' | 'degraded' | 'down'
  reclaimCount: number
  onInfo: OpenHostInfo
}
const HeaderMachineChip = memo(function HeaderMachineChip({ host, machine, aggregate, lifecycle, serverAppVersion, healthStatus, reclaimCount, onInfo }: MachineChipProps): JSX.Element {

        const memory = hostMemoryView(host)
        const disk = host.disk ? hostDiskView(host.disk) : null
        const load = hostLoadView(host, lifecycle?.hibernation.loadPerCore ?? null)
        // A renamed machine should read by its chosen name everywhere, and this
        // chip was the one surface still showing the raw telemetry hostname.
        const displayName = machine?.name ?? host.hostname
        // POD-4830: a supervised daemon loss keeps `online` true while the live
        // terminal is gone. The dot must read live-terminal presence, not just
        // the global socket health, or it stays green/blue with no banner.
        const machineOffline = machine ? isMachineOfflineForLiveTerminal(machine) : false
        const agents = hostAgentsViewFromCounts(
          aggregate.count,
          aggregate.idleSplit.idle,
          lifecycle?.hibernation.maxIdleSessions ?? null,
          displayName,
        )
        const memTone = SEVERITY[memory.severity]
        const loadTone = SEVERITY[load.severity]
        const diskTone = disk ? SEVERITY[disk.severity] : null
        const agentTone = SEVERITY[agents.severity]
        const needsUpdate = machine != null && machineNeedsUpdate(machine, serverAppVersion)
        const updateTargetVersion =
          machine?.targetVersion !== undefined ? machine.targetVersion : serverAppVersion
        const reclaimablePast =
          reclaimCount >= RECLAIMABLE_WORKTREE_THRESHOLD && healthStatus === 'ok'
        const phases = aggregate.phases
        const agentTitleParts = [
          agents.title,
          phases.working > 0 || phases.idle > 0 || phases.waiting > 0
            ? `${phases.working} working, ${phases.idle} idle, ${phases.waiting} waiting on you`
            : null,
        ].filter(Boolean)
        const aria = [
          displayName,
          machineOffline ? 'offline' : null,
          memory.title,
          load.title,
          disk?.title ?? 'disk usage unavailable',
          agentTitleParts.join(' — '),
          reclaimablePast ? `${reclaimCount} reclaimable worktrees` : null,
        ]
          .filter(Boolean)
          .join('; ')
        // The chip carries no `title`. It already opens its panel on hover, and
        // the native tooltip that floated over that panel named only the agents
        // — never the two meters the eye actually lands on. The panel names them
        // now (LoadPanel's header legend); `aria-label` keeps the whole readout
        // in one string for assistive tech.
        return (
          <HealthPopover
            key={host.machineId}
            popupClassName="health-popover-machine"
            trigger={
              <button
                data-pressable
                type="button"
                className="header-machine-chip"
                aria-label={aria}
              >
                <span
                  className={cn(
                    'size-1.5 flex-none rounded-full',
                    machineOffline
                      ? 'bg-destructive'
                      : healthStatus === 'ok'
                        ? reclaimablePast
                          ? 'bg-warning'
                          : 'bg-success'
                        : healthStatus === 'degraded'
                          ? 'bg-warning'
                          : 'bg-destructive',
                  )}
                  aria-hidden="true"
                />
                <span className="header-machine-name">{displayName}</span>
                {machineOffline && (
                  <span className="header-readout">
                    <span className="header-value" data-tone="bad">
                      offline
                    </span>
                  </span>
                )}
                {needsUpdate && (
                  <CircleArrowUp
                    size={12}
                    className="flex-none text-warning"
                    aria-label="Update available"
                  />
                )}
                <span className="header-machine-meters">
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
                  <span className="header-readout">
                    <span className="header-mark">DISK</span>
                    <span className="header-meter" role="presentation">
                      {disk && diskTone && (
                        <span className={cn('block h-full', diskTone.fill)} style={{ width: `${disk.pct}%` }} />
                      )}
                    </span>
                    <span className="header-value" data-tone={disk ? TONE_KEY[disk.severity] : undefined}>
                      {disk ? `${disk.pct}%` : 'N/A'}
                    </span>
                  </span>
                </span>
                <span className="header-readout header-agent-readout">
                  <span className="header-mark">AGT</span>
                  <span className="header-value">{agents.count}</span>
                </span>
                {agents.meterPct != null && agents.idleTarget != null && (
                  <span className="header-readout header-agent-readout">
                    <span className="header-mark">IDLE</span>
                    <span className="header-meter" role="presentation">
                      <span
                        className={cn('block h-full', agentTone.fill)}
                        style={{ width: `${agents.meterPct}%` }}
                      />
                    </span>
                    <span className="header-value" data-tone={TONE_KEY[agents.severity]}>
                      {agents.observedIdleCount}/{agents.idleTarget}
                    </span>
                  </span>
                )}
              </button>
            }
          >
            <Suspense fallback={null}>
              <LoadPanel
                machineId={host.machineId}
                updateNote={
                  needsUpdate ? (
                    <div className="hp-dim-line text-warning">
                      Update available: {machine?.inventory?.podiumVersion} → {updateTargetVersion}{' '}
                      — apply it from Settings → Machines
                    </div>
                  ) : undefined
                }
                onOpenConnection={() => onInfo({ tab: 'connection', machineId: host.machineId })}
                onOpenReclaim={() => onInfo({ tab: 'reclaim', machineId: host.machineId })}
              />
            </Suspense>
          </HealthPopover>
        )

})

const PoolMachineReadout = memo(function PoolMachineReadout({ id, lifecycle, serverAppVersion, healthStatus, reclaimCount, onInfo }: Omit<MachineChipProps, 'host' | 'machine' | 'aggregate'> & { id: string }) {
  const host = usePoolMetric(id)
  const machine = usePoolMachine(host?.machineId)
  const aggregate = usePoolHostAggregate(host?.machineId)
  return measureHeader('pool.metricRow', () => host ? <HeaderMachineChip host={host} machine={machine} aggregate={aggregate} lifecycle={lifecycle}
    serverAppVersion={serverAppVersion} healthStatus={healthStatus} reclaimCount={reclaimCount} onInfo={onInfo} /> : null)
})

function PoolHeaderHostIndicators(): JSX.Element {
  const ids = usePoolMetricIds()
  const offline = usePoolOfflineMachines()
  const { trpc } = useHeaderActions()
  const lifecycle = useHostLifecycleSettings()
  const serverAppVersion = useServerAppVersion(trpc)
  const { health } = useStableConnection()
  const reclaim = usePoolReclaimCounts(lifecycle?.worktreeGc.afterDays ?? 14)
  const [info, setInfo] = useState<{ tab: HostInfoTab; machineId?: MachineId } | null>(null)
  const description = health.status === 'ok' ? '' : (() => { const d = describeHealth(health, Date.now()); return `${d.headline}. ${d.detail}` })()
  return <div className="topbar-well header-host-indicators">
    <span className="sr-only" role="status" aria-live="polite">{description}</span>
    {ids.length === 0 && offline.length === 0 && <button data-pressable type="button" className="header-machine-chip" aria-label="Host connection — click for details" onClick={() => setInfo({ tab: 'connection' })}>
      <span className={cn('size-1.5 flex-none rounded-full', health.status === 'ok' ? 'bg-success' : health.status === 'degraded' ? 'bg-warning' : 'bg-destructive')} aria-hidden="true" /><span>host</span>
    </button>}
    {ids.map((id) => <PoolMachineReadout key={id} id={id} lifecycle={lifecycle} serverAppVersion={serverAppVersion}
      healthStatus={health.status} reclaimCount={reclaim[id] ?? 0} onInfo={setInfo} />)}
    {offline.map((machine) => <button key={machine.id} data-pressable type="button" className="header-machine-chip" aria-label={`${machine.name}; offline`} onClick={() => setInfo({ tab: 'connection', machineId: machine.id })}>
      <span className="size-1.5 flex-none rounded-full bg-destructive" aria-hidden="true" /><span className="header-machine-name">{machine.name}</span>
      <span className="header-readout"><span className="header-value" data-tone="bad">offline</span></span>
    </button>)}
    <OutboxRecoveryIndicator compact /><MessageNoticeIndicator compact />
    <span className="header-strip-seam" aria-hidden="true" /><QuotaIndicator header />
    {info && <Suspense fallback={null}><HostInfoView initialTab={info.tab} machineId={info.machineId} onClose={() => setInfo(null)} /></Suspense>}
  </div>
}
