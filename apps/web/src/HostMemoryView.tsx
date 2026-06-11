import type { AgentMemoryWire, HostMemoryWire, ProjectMemoryWire } from '@podium/protocol'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
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

/**
 * "Who owns the used memory" — opened from the memory chip. Agents are the
 * sessions Podium controls (attributed by process tree); projects are other
 * processes whose working directory sits under a controlled repo/worktree
 * (dev servers, watchers); other is the rest of the machine.
 */
export function HostMemoryView({ onClose }: { onClose: () => void }): JSX.Element {
  const { trpc, sessions } = useStore()
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

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="host-memory-modal" role="dialog" aria-modal="true" aria-label="Host memory">
        <div className="host-memory-head">
          <span className="label">MEMORY{data ? ` — ${data.hostname.toUpperCase()}` : ''}</span>
          <button type="button" onClick={onClose}>
            ✕
          </button>
        </div>
        {error && <div className="host-memory-note">Could not load the breakdown: {error}</div>}
        {!error && !data && <div className="host-memory-note">Measuring…</div>}
        {data && <BreakdownBody data={data} sessionLabel={sessionLabel} />}
      </div>
    </div>
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
