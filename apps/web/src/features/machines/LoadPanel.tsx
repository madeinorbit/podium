import { shallowEqual } from '@podium/client-core/store'
import {
  formatMemBytes,
  hostLoadView,
  hostMemoryView,
  idleSessionSplit,
  listReclaimableWorktreesClient,
  occupiedRootsFromKey,
  panelLabel,
  residentWorktreeKey,
} from '@podium/client-core/viewmodels'
import type { AgentMemoryWire, HostMemoryWire, ProjectMemoryWire, SessionId } from '@podium/model'
import { Loader2 } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import { cn } from '@/lib/utils'
import { HealthPopoverFooter } from './HealthPopover'
import { useHostLifecycleSettings } from './HostMemoryView'

interface Breakdown {
  hostname: string
  sampledAt: string
  supported: boolean
  memory: HostMemoryWire
  agents: AgentMemoryWire[]
  projects: ProjectMemoryWire[]
  otherBytes: number
}

const REFRESH_MS = 5_000

/**
 * The machine-load popover body. Hover tier: hostname + used/total headline and
 * the composition bar (agents / project processes / other) so you see WHAT is
 * eating the machine before deciding to click. Pinned tier: per-session and
 * per-project rows, reclaimable inventory, hibernation + worktree-GC status
 * with settings shortcuts, and a footer jump to connection detail.
 *
 * The per-process breakdown (a /proc walk) is fetched once the panel opens and
 * refreshed every 5s only while it stays open — same cadence the old modal used.
 * Reclaimable inventory is derived client-side (no du probe; count only).
 */
export function LoadPanel({
  machineId,
  pinned,
  updateNote,
  onOpenConnection,
  onOpenReclaim,
}: {
  machineId?: string
  pinned: boolean
  updateNote?: ReactNode
  onOpenConnection: () => void
  onOpenReclaim?: () => void
}): JSX.Element {
  const { trpc, sessions, hostMetrics, setView, setSettingsTab } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      sessions: s.sessions,
      hostMetrics: s.hostMetrics,
      setView: s.setView,
      setSettingsTab: s.setSettingsTab,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const lifecycle = useHostLifecycleSettings()
  const hibernation = lifecycle?.hibernation ?? null
  const worktreeGc = lifecycle?.worktreeGc ?? null
  const [data, setData] = useState<Breakdown | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const refresh = async (): Promise<void> => {
      try {
        const r = await trpc.hosts.memoryBreakdown.mutate(machineId ? { machineId } : undefined)
        if (!alive) return
        setData(r)
        setError(null)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [trpc, machineId])

  // Instant headline from the streamed host metric; the breakdown fills in.
  const metric = hostMetrics.find((h) => h.machineId === machineId) ?? hostMetrics[0]
  const mem = data
    ? hostMemoryView({ hostname: data.hostname, sampledAt: data.sampledAt, memory: data.memory })
    : metric
      ? hostMemoryView(metric)
      : null
  const load = metric ? hostLoadView(metric, hibernation?.loadPerCore ?? null) : null
  const idleSplit = idleSessionSplit(sessions, machineId)
  const afterDays = worktreeGc?.afterDays ?? 14
  // Keyed on live-agent occupancy, not the sessions array — see the same memo in
  // HeaderHostIndicators. The panel refreshes its /proc breakdown every 5s; the
  // candidate scan has no reason to follow that cadence.
  const occupancyKey = residentWorktreeKey(sessions)
  const reclaimable = useMemo(
    () =>
      listReclaimableWorktreesClient({
        issues,
        occupiedRoots: occupiedRootsFromKey(occupancyKey),
        afterDays,
        ...(machineId ? { machineId } : {}),
      }),
    [issues, occupancyKey, afterDays, machineId],
  )

  const total = data?.memory.totalBytes ?? 0
  const agentBytes = data?.agents.reduce((sum, a) => sum + a.bytes, 0) ?? 0
  const projectBytes = data?.projects.reduce((sum, p) => sum + p.bytes, 0) ?? 0
  const seg = (bytes: number): string => `${total > 0 ? (bytes / total) * 100 : 0}%`

  const sessionLabel = (sessionId: SessionId): string => {
    const s = sessions.find((s) => s.sessionId === sessionId)
    if (!s) return sessionId.slice(0, 8)
    return `${panelLabel(s.agentKind)} — ${s.title}`
  }

  const memActive =
    hibernation?.enabled === true && mem !== null && mem.pct >= hibernation.memoryPct
  const loadActive =
    hibernation?.enabled === true &&
    hibernation.loadPerCore != null &&
    load?.perCore != null &&
    load.perCore >= hibernation.loadPerCore
  const hibActive = memActive || loadActive

  const openHibernation = (): void => {
    setSettingsTab('hibernation')
    setView('settings')
  }

  const figures = [
    mem?.label,
    mem != null ? `${mem.pct}%` : null,
    load?.perCore != null ? `load ${load.label}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <div className="hp-header">
        <span className="hp-title">{mem?.hostname ?? '…'}</span>
        {figures && <span className="hp-figures">{figures}</span>}
      </div>
      <div className="hp-section">
        {data ? (
          <>
            <div className="hp-seg" role="presentation">
              <i className="hp-seg-agents" style={{ width: seg(agentBytes) }} />
              <i className="hp-seg-projects" style={{ width: seg(projectBytes) }} />
              <i className="hp-seg-other" style={{ width: seg(data.otherBytes) }} />
            </div>
            <div className="hp-legend">
              <span>
                <i className="hp-seg-agents" /> Agents {formatMemBytes(agentBytes)}
              </span>
              <span>
                <i className="hp-seg-projects" /> Projects {formatMemBytes(projectBytes)}
              </span>
              <span>
                <i className="hp-seg-other" /> Other {formatMemBytes(data.otherBytes)}
              </span>
            </div>
          </>
        ) : error ? (
          <div className="hp-dim-line">Could not load the breakdown: {error}</div>
        ) : (
          <div className="hp-dim-line flex items-center gap-2 py-1.5">
            <Loader2 size={12} className="flex-none animate-spin" aria-hidden="true" />
            <span>Measuring memory per process…</span>
          </div>
        )}
        {updateNote}
        {!pinned && hibernation && (
          <div className="hp-dim-line">
            {hibernation.enabled
              ? hibActive
                ? loadActive && !memActive
                  ? `Load ${load?.label ?? ''} per core — auto-hibernation parks idle agents past ${hibernation.loadPerCore}×`
                  : 'Hibernating stale agents to free resources'
                : hibernation.loadPerCore != null
                  ? `Auto-hibernation standing by at ${hibernation.loadPerCore}× load or ${hibernation.memoryPct}% memory`
                  : `Auto-hibernation standing by — parks idle agents past ${hibernation.memoryPct}%`
              : 'Auto-hibernation off'}
          </div>
        )}
      </div>
      {pinned && data && (
        <div className="hp-section">
          {data.supported ? (
            <>
              <div className="hp-sect-label">Agents &amp; shells</div>
              {data.agents.length > 0 ? (
                data.agents.map((agent) => (
                  <ProcessRow
                    key={agent.sessionId}
                    name={sessionLabel(agent.sessionId)}
                    detail={`${agent.processCount} process${agent.processCount === 1 ? '' : 'es'}`}
                    bytes={agent.bytes}
                  />
                ))
              ) : (
                <div className="hp-dim-line">No sessions running.</div>
              )}
              <div className="hp-sect-label">Project processes</div>
              {data.projects.length > 0 ? (
                data.projects.map((project) => (
                  <ProcessRow
                    key={project.root}
                    name={project.root.split('/').pop() ?? project.root}
                    title={project.root}
                    detail={project.topProcesses.map((p) => p.name).join(', ')}
                    bytes={project.bytes}
                  />
                ))
              ) : (
                <div className="hp-dim-line">Nothing else running in your worktrees.</div>
              )}
              <ProcessRow name="Everything else on this machine" bytes={data.otherBytes} muted />
            </>
          ) : (
            <div className="hp-dim-line">
              This host can&apos;t attribute memory per process (no /proc) — totals only.
            </div>
          )}
        </div>
      )}
      {pinned && (
        <div className="hp-section">
          <div className="hp-sect-label">Reclaimable</div>
          <div className="hp-kv">
            <span className="hp-kv-key">Worktrees</span>
            <span className="hp-kv-value">
              {reclaimable.length} checkout{reclaimable.length === 1 ? '' : 's'}
            </span>
            {onOpenReclaim && reclaimable.length > 0 && (
              <button data-pressable type="button" className="hp-link" onClick={onOpenReclaim}>
                Review
              </button>
            )}
          </div>
          <div className="hp-kv">
            <span className="hp-kv-key">Idle sessions</span>
            <span className="hp-kv-value">
              {idleSplit.parkable} parkable · {idleSplit.protected} protected
              {metric?.idleCapUnmet != null && metric.idleCapUnmet > 0
                ? ` · ${metric.idleCapUnmet} cap unmet`
                : ''}
            </span>
          </div>
          {/* Not a readout — a standing caveat about what Review will and will
              not do. It reports no count, so it must not sit in the key column
              pretending to be one. */}
          <div className="hp-dim-line">
            Nothing is freed from here. Review proposes; you tick what goes.
          </div>
        </div>
      )}
      {pinned && (hibernation || worktreeGc) && (
        <div className="hp-hibernation">
          {hibernation && (
            <>
              {hibernation.enabled
                ? hibActive
                  ? memActive
                    ? `Memory is past ${hibernation.memoryPct}%, so agents idle ${hibernation.idleMinutes} min are hibernating. One click resumes them. `
                    : `Load is past ${hibernation.loadPerCore}× per core, so agents idle ${hibernation.idleMinutes} min are hibernating. One click resumes them. `
                  : hibernation.loadPerCore != null
                    ? `Auto-hibernation on: agents idle ${hibernation.idleMinutes} min park past ${hibernation.loadPerCore}× load or ${hibernation.memoryPct}% memory. `
                    : `Auto-hibernation on: past ${hibernation.memoryPct}% memory, agents idle ${hibernation.idleMinutes} min park themselves. `
                : 'Auto-hibernation is off — idle agents keep their memory until you hibernate them by hand. '}
              <button data-pressable type="button" className="hp-link" onClick={openHibernation}>
                Hibernation settings
              </button>
            </>
          )}
          {worktreeGc && (
            <>
              {hibernation ? <br /> : null}
              {worktreeGc.mode === 'off'
                ? 'Worktree GC is off. '
                : worktreeGc.mode === 'auto'
                  ? `Worktree GC: auto-freeing after ${worktreeGc.afterDays} days. `
                  : `Worktree GC: proposing after ${worktreeGc.afterDays} days. `}
              <button data-pressable type="button" className="hp-link" onClick={openHibernation}>
                GC settings
              </button>
            </>
          )}
        </div>
      )}
      {pinned ? (
        <HealthPopoverFooter
          left="sampled every 5s"
          right={
            <button
              data-pressable
              type="button"
              className="hp-link hp-link-mono"
              onClick={onOpenConnection}
            >
              connection ▸
            </button>
          }
        />
      ) : (
        <HealthPopoverFooter left="click to pin breakdown" right="esc closes" />
      )}
    </>
  )
}

function ProcessRow({
  name,
  detail,
  title,
  bytes,
  muted,
}: {
  name: string
  detail?: string
  title?: string
  bytes: number
  muted?: boolean
}): JSX.Element {
  return (
    <div className={cn('hp-prow', muted && 'hp-prow-muted')} title={title}>
      <span className="hp-prow-name">{name}</span>
      {detail && <span className="hp-prow-detail">{detail}</span>}
      <span className="hp-prow-bytes">{formatMemBytes(bytes)}</span>
    </div>
  )
}
