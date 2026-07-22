import { shallowEqual } from '@podium/client-core/store'
import { Loader2 } from 'lucide-react'
import type { AgentMemoryWire, HostMemoryWire, ProjectMemoryWire } from '@podium/protocol'
import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { formatMemBytes, hostMemoryView, panelLabel } from '@/lib/derive'
import { cn } from '@/lib/utils'
import { HealthPopoverFooter } from './HealthPopover'
import { useHibernationSetting } from './HostMemoryView'

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
 * per-project rows, the hibernation status with a settings shortcut, and a
 * footer jump to connection detail.
 *
 * The per-process breakdown (a /proc walk) is fetched once the panel opens and
 * refreshed every 5s only while it stays open — same cadence the old modal used.
 */
export function LoadPanel({
  machineId,
  pinned,
  updateNote,
  onOpenConnection,
}: {
  machineId?: string
  pinned: boolean
  updateNote?: ReactNode
  onOpenConnection: () => void
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
  const hibernation = useHibernationSetting()
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

  const total = data?.memory.totalBytes ?? 0
  const agentBytes = data?.agents.reduce((sum, a) => sum + a.bytes, 0) ?? 0
  const projectBytes = data?.projects.reduce((sum, p) => sum + p.bytes, 0) ?? 0
  const seg = (bytes: number): string => `${total > 0 ? (bytes / total) * 100 : 0}%`

  const sessionLabel = (sessionId: string): string => {
    const s = sessions.find((s) => s.sessionId === sessionId)
    if (!s) return sessionId.slice(0, 8)
    return `${panelLabel(s.agentKind)} — ${s.title}`
  }

  const hibActive =
    hibernation?.enabled === true && mem !== null && mem.pct >= hibernation.memoryPct

  return (
    <>
      <div className="hp-header">
        <span className="hp-title">{mem?.hostname ?? '…'}</span>
        {mem && (
          <span className="hp-figures">
            {mem.label} · {mem.pct}%
          </span>
        )}
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
                ? 'Hibernating stale agents to free memory'
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
              This host can't attribute memory per process (no /proc) — totals only.
            </div>
          )}
          {hibernation && (
            <div className="hp-hibernation">
              {hibernation.enabled
                ? hibActive
                  ? `Memory is past ${hibernation.memoryPct}%, so agents idle ${hibernation.idleMinutes} min are hibernating to free memory. One click resumes them. `
                  : `Auto-hibernation on: past ${hibernation.memoryPct}% memory, agents idle ${hibernation.idleMinutes} min park themselves. `
                : 'Auto-hibernation is off — idle agents keep their memory until you hibernate them by hand. '}
              <button
                type="button"
                className="hp-link"
                onClick={() => {
                  setSettingsTab('hibernation')
                  setView('settings')
                }}
              >
                Hibernation settings
              </button>
            </div>
          )}
        </div>
      )}
      {pinned ? (
        <HealthPopoverFooter
          left="sampled every 5s"
          right={
            <button type="button" className="hp-link hp-link-mono" onClick={onOpenConnection}>
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
