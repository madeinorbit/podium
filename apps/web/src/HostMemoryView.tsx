import type { PodiumSettings } from '@podium/core'
import type { AgentMemoryWire, HostMemoryWire, ProjectMemoryWire } from '@podium/protocol'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { cn } from '@/lib/utils'
import { describeHealth, useConnectionHealth } from './ConnectionIndicator'
import { formatMemBytes, hostMemoryView, panelLabel } from './derive'
import { useStore } from './store'

/** The host-memory hibernation knob, lazily fetched from the server. Shared by
 *  the memory chip's tooltip and the memory modal so both reflect the live
 *  setting without either reaching into the (settings-less) store. Returns null
 *  until the first fetch resolves. */
export function useHibernationSetting(): PodiumSettings['hibernation'] | null {
  const { trpc } = useStore()
  const [hibernation, setHibernation] = useState<PodiumSettings['hibernation'] | null>(null)
  useEffect(() => {
    let alive = true
    trpc.settings.get
      .query()
      .then((s) => {
        if (alive) setHibernation(s.hibernation)
      })
      .catch(() => {
        // Best-effort: a failed settings fetch just omits the hibernation note.
      })
    return () => {
      alive = false
    }
  }, [trpc])
  return hibernation
}

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
  const isMobile = useIsMobile()
  return (
    <Dialog
      open
      modal={isMobile ? 'trap-focus' : true}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent
        aria-label="Host info"
        className="flex max-h-[min(640px,calc(100dvh-2rem))] w-[min(440px,100%)] max-w-[min(440px,100%)] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader>
          <DialogTitle className="sr-only">Host info</DialogTitle>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as HostInfoTab)}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="flex items-center justify-between border-b border-border px-2.5 py-2">
            <TabsList className="bg-transparent">
              <TabsTrigger value="connection">Connection</TabsTrigger>
              <TabsTrigger value="memory">Memory</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="connection" className="overflow-y-auto">
            <ConnectionPanel />
          </TabsContent>
          <TabsContent value="memory" className="overflow-y-auto">
            <MemoryPanel onClose={onClose} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
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
    <div className="flex flex-col gap-2.5 p-3.5">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span
          className={cn(
            'size-[9px] rounded-full',
            health.status === 'degraded'
              ? 'bg-warning'
              : health.status === 'down'
                ? 'bg-destructive'
                : 'bg-success',
          )}
        />
        <span>{headline}</span>
      </div>
      <p className="m-0 text-[13px] text-muted-foreground">{detail}</p>
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between gap-3 text-[13px] text-foreground">
          <span>Latency</span>
          <span className="font-medium">{ping}</span>
        </div>
        {hostMetrics.length > 0 && (
          <div className="flex justify-between gap-3 text-[13px] text-foreground">
            <span>{hostMetrics.length === 1 ? 'Host' : 'Hosts'}</span>
            <span className="font-medium">{hostMetrics.map((h) => h.hostname).join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** Memory tab: the headline GB number shows immediately from the host metrics the
 *  store already has; the per-process breakdown (a heavier /proc walk) fills in
 *  underneath once the daemon answers, so the modal never opens on a blank "…". */
function MemoryPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const { trpc, sessions, hostMetrics, setView, setSettingsTab } = useStore()
  const hibernation = useHibernationSetting()
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

  // Current memory pressure for the hibernation explainer — prefer the
  // breakdown's own sample, fall back to the streamed headline metric.
  const memPct = data
    ? hostMemoryView({ hostname: data.hostname, sampledAt: data.sampledAt, memory: data.memory })
        .pct
    : (headline?.pct ?? null)

  const openHibernationSettings = (): void => {
    setSettingsTab('hibernation')
    setView('settings')
    onClose()
  }

  return (
    <>
      {data && (
        <div className="px-3.5 pt-2.5 text-[11px] uppercase tracking-[0.04em] text-muted-foreground/70">
          {data.hostname.toUpperCase()}
        </div>
      )}
      {headline && (
        <div className="flex flex-col gap-3 p-3.5">
          <div className="flex justify-between text-[13px] font-medium text-foreground">
            <span>{headline.label} used</span>
            <span className="text-muted-foreground">{headline.pct}%</span>
          </div>
        </div>
      )}
      {error && (
        <div className="text-xs text-muted-foreground/70">Could not load the breakdown: {error}</div>
      )}
      {!error && !data && (
        <div className="text-xs text-muted-foreground/70">Loading the per-process breakdown…</div>
      )}
      {data && <BreakdownBody data={data} sessionLabel={sessionLabel} />}
      <HibernationNote
        hibernation={hibernation}
        memPct={memPct}
        idleSessionCount={sessions.filter((s) => s.status === 'hibernated').length}
        onOpenSettings={openHibernationSettings}
      />
    </>
  )
}

/** Explains the host's auto-hibernation policy in the memory modal: what it does
 *  and whether it's on, off, or actively reclaiming right now, with a shortcut
 *  to the setting. Hidden until the setting has loaded. */
function HibernationNote({
  hibernation,
  memPct,
  idleSessionCount,
  onOpenSettings,
}: {
  hibernation: PodiumSettings['hibernation'] | null
  memPct: number | null
  idleSessionCount: number
  onOpenSettings: () => void
}): JSX.Element | null {
  if (!hibernation) return null
  const active = memPct !== null && memPct >= hibernation.memoryPct
  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-3.5 py-3 text-xs text-muted-foreground">
      {hibernation.enabled ? (
        <p className="m-0">
          {active ? (
            <>
              Memory is past the {hibernation.memoryPct}% threshold, so agents idle for{' '}
              {hibernation.idleMinutes} min are being hibernated to free memory
              {idleSessionCount > 0
                ? ` (${idleSessionCount} hibernated). `
                : '. '}
              One click resumes them.
            </>
          ) : (
            <>
              Auto-hibernation is on: once memory crosses {hibernation.memoryPct}%, agents idle for{' '}
              {hibernation.idleMinutes} min hibernate to free memory. One click resumes them.
            </>
          )}
        </p>
      ) : (
        <p className="m-0">
          Auto-hibernation is off — idle agents keep their memory until you hibernate them by hand.
        </p>
      )}
      <button
        type="button"
        className="cursor-pointer self-start border-0 bg-transparent p-0 text-left text-primary underline underline-offset-2 hover:no-underline"
        onClick={onOpenSettings}
      >
        Hibernation settings
      </button>
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
    <div className="flex flex-col gap-3 p-3.5">
      <div className="flex justify-between text-[13px] font-medium text-foreground">
        <span>{mem.label} used</span>
        <span className="text-muted-foreground">{mem.pct}%</span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-[3px] bg-secondary" role="presentation">
        <span className="h-full bg-primary" style={{ width: seg(agentBytes) }} />
        <span className="h-full bg-success" style={{ width: seg(projectBytes) }} />
        <span className="h-full bg-border" style={{ width: seg(data.otherBytes) }} />
      </div>
      <div className="-mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <LegendSwatch className="bg-primary" label="Agents" />
        <LegendSwatch className="bg-success" label="Projects" />
        <LegendSwatch className="bg-border" label="Other" />
      </div>
      {!data.supported && (
        <div className="text-xs text-muted-foreground/70">
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
      <div className="flex flex-col gap-1">
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
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
        {label}
      </div>
      {children.length > 0 ? (
        children
      ) : (
        <div className="text-xs text-muted-foreground/70">{empty}</div>
      )}
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
    <div
      className={cn(
        'flex items-baseline gap-2 text-xs',
        muted ? 'text-muted-foreground' : 'text-foreground',
      )}
      title={title}
    >
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{name}</span>
      {detail && (
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-muted-foreground/70">
          {detail}
        </span>
      )}
      <span className="ml-auto whitespace-nowrap text-muted-foreground tabular-nums">
        {formatMemBytes(bytes)}
      </span>
    </div>
  )
}

/** A colour swatch + label for the segmented-bar legend; the swatch class must
 *  match the corresponding bar segment so the colour mapping is unambiguous. */
function LegendSwatch({ className, label }: { className: string; label: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-2 flex-none rounded-[2px]', className)} aria-hidden="true" />
      {label}
    </span>
  )
}
