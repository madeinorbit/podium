import type { AgentMemoryWire, HostMemoryWire, ProjectMemoryWire } from '@podium/protocol'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { describeHealth, useConnectionHealth } from './ConnectionIndicator'
import { formatMemBytes, hostMemoryView, panelLabel } from './derive'
import { useStore } from './store'

/** Shape of trpc hosts.memoryBreakdown — the daemon's answer minus wire plumbing. */
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

export type HostInfoTab = 'connection' | 'memory'

/**
 * Host info panel: one modal with a Connection tab and a Memory tab, opened from
 * either the connection indicator or the memory chip (mobile and desktop share
 * it). `initialTab` selects which one is shown first based on what was tapped.
 */
export function HostInfoView({
  onClose,
  initialTab = 'memory',
}: {
  onClose: () => void
  initialTab?: HostInfoTab
}): JSX.Element {
  const [tab, setTab] = useState<HostInfoTab>(initialTab)
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="host-info-modal" role="dialog" aria-modal="true" aria-label="Host info">
        <div className="host-info-head">
          <div className="host-info-tabs">
            <button
              type="button"
              aria-pressed={tab === 'connection'}
              className={tab === 'connection' ? 'active' : ''}
              onClick={() => setTab('connection')}
            >
              Connection
            </button>
            <button
              type="button"
              aria-pressed={tab === 'memory'}
              className={tab === 'memory' ? 'active' : ''}
              onClick={() => setTab('memory')}
            >
              Memory
            </button>
          </div>
          <button type="button" className="host-info-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="host-info-body">
          {tab === 'connection' ? <ConnectionPanel /> : <MemoryPanel />}
        </div>
      </div>
    </div>
  )
}

/** Connection tab: live status, latency, and the explanatory detail line. */
function ConnectionPanel(): JSX.Element {
  const { hostMetrics } = useStore()
  const health = useConnectionHealth()
  const [, setTick] = useState(0)
  useEffect(() => {
    if (health.status === 'ok') return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [health.status])
  const { headline, detail } = describeHealth(health, Date.now())
  const ping = health.rttMs !== null ? `${Math.max(1, Math.round(health.rttMs))} ms` : '—'
  return (
    <div className="host-conn">
      <div className={`host-conn-status conn-${health.status}`}>
        <span className="host-conn-dot" />
        <span>{headline}</span>
      </div>
      <p className="host-conn-detail">{detail}</p>
      <div className="host-conn-rows">
        <div className="host-conn-row">
          <span>Latency</span>
          <span>{ping}</span>
        </div>
        {hostMetrics.length > 0 && (
          <div className="host-conn-row">
            <span>{hostMetrics.length === 1 ? 'Host' : 'Hosts'}</span>
            <span>{hostMetrics.map((h) => h.hostname).join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** Memory tab: the headline GB number shows immediately from the host metrics the
 *  store already has; the per-process breakdown (a heavier /proc walk) fills in
 *  underneath once the daemon answers, so the modal never opens on a blank "…". */
function MemoryPanel(): JSX.Element {
  const { trpc, sessions, hostMetrics } = useStore()
  const [data, setData] = useState<Breakdown | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const refresh = async (): Promise<void> => {
      try {
        const r = await trpc.hosts.memoryBreakdown.mutate()
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
  }, [trpc])

  const sessionLabel = (sessionId: string): string => {
    const s = sessions.find((s) => s.sessionId === sessionId)
    if (!s) return sessionId.slice(0, 8)
    return `${panelLabel(s.agentKind)} — ${s.title}`
  }

  // Instant headline from the live host-metrics sample (already streamed to the
  // store), so "12.3/32 GB used" is on screen the moment the modal opens.
  const headline = !data && hostMetrics[0] ? hostMemoryView(hostMetrics[0]) : null

  return (
    <>
      {data && <div className="host-memory-hostname">{data.hostname.toUpperCase()}</div>}
      {headline && (
        <div className="host-memory-body">
          <div className="host-memory-total">
            <span>{headline.label} used</span>
            <span className="host-memory-pct">{headline.pct}%</span>
          </div>
        </div>
      )}
      {error && <div className="host-memory-note">Could not load the breakdown: {error}</div>}
      {!error && !data && (
        <div className="host-memory-note">Loading the per-process breakdown…</div>
      )}
      {data && <BreakdownBody data={data} sessionLabel={sessionLabel} />}
    </>
  )
}

function BreakdownBody({
  data,
  sessionLabel,
}: {
  data: Breakdown
  sessionLabel: (sessionId: string) => string
}): JSX.Element {
  const mem = hostMemoryView({
    hostname: data.hostname,
    sampledAt: data.sampledAt,
    memory: data.memory,
  })
  const total = data.memory.totalBytes
  const agentBytes = data.agents.reduce((sum, a) => sum + a.bytes, 0)
  const projectBytes = data.projects.reduce((sum, p) => sum + p.bytes, 0)
  const seg = (bytes: number): string => `${total > 0 ? (bytes / total) * 100 : 0}%`
  return (
    <div className="host-memory-body">
      <div className="host-memory-total">
        <span>{mem.label} used</span>
        <span className="host-memory-pct">{mem.pct}%</span>
      </div>
      <div className="host-memory-stack" role="presentation">
        <span className="seg seg-agents" style={{ width: seg(agentBytes) }} />
        <span className="seg seg-projects" style={{ width: seg(projectBytes) }} />
        <span className="seg seg-other" style={{ width: seg(data.otherBytes) }} />
      </div>
      {!data.supported && (
        <div className="host-memory-note">
          This host can't attribute memory per process (no /proc) — totals only.
        </div>
      )}
      <Section label="AGENTS & SHELLS" empty="No sessions running." show={data.supported}>
        {data.agents.map((agent) => (
          <Row
            key={agent.sessionId}
            name={sessionLabel(agent.sessionId)}
            detail={`${agent.processCount} process${agent.processCount === 1 ? '' : 'es'}`}
            bytes={agent.bytes}
          />
        ))}
      </Section>
      <Section
        label="PROJECT PROCESSES"
        empty="Nothing else running in your worktrees."
        show={data.supported}
      >
        {data.projects.map((project) => (
          <Row
            key={project.root}
            name={project.root.split('/').pop() ?? project.root}
            title={project.root}
            detail={project.topProcesses.map((p) => p.name).join(', ')}
            bytes={project.bytes}
          />
        ))}
      </Section>
      <div className="host-memory-rows">
        <Row name="Everything else on this machine" bytes={data.otherBytes} muted />
      </div>
    </div>
  )
}

function Section({
  label,
  empty,
  show,
  children,
}: {
  label: string
  empty: string
  show: boolean
  children: JSX.Element[]
}): JSX.Element | null {
  if (!show) return null
  return (
    <div className="host-memory-rows">
      <div className="label">{label}</div>
      {children.length > 0 ? children : <div className="host-memory-note">{empty}</div>}
    </div>
  )
}

function Row({
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
    <div className={muted ? 'host-memory-row muted' : 'host-memory-row'} title={title}>
      <span className="row-name">{name}</span>
      {detail && <span className="row-detail">{detail}</span>}
      <span className="row-bytes">{formatMemBytes(bytes)}</span>
    </div>
  )
}
