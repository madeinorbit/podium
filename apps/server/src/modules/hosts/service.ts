import type { PodiumSettings } from '@podium/runtime'
import type {
  AgentRuntimeState,
  ControlMessage,
  DaemonMessage,
  HostMetricsWire,
  LiveServerMessage,
  ServerMessage,
} from '@podium/protocol'
import { LOCAL_PLACEHOLDER } from '../../local-machine'
import type { EventBus } from '../bus'

/** The daemon's memoryBreakdownResult, minus wire plumbing (type/requestId). */
export type MemoryBreakdown = Omit<
  Extract<DaemonMessage, { type: 'memoryBreakdownResult' }>,
  'type' | 'requestId'
>

const MEMORY_BREAKDOWN_TIMEOUT_MS = 10_000

/** The session fields the auto-hibernate candidate scan reads — a structural
 *  projection of Session so the service never touches the registry's map. */
export interface HostSessionView {
  sessionId: string
  machineId: string
  status: string
  resume?: { kind: string; value: string } | undefined
  agentState?: AgentRuntimeState | undefined
  lastActiveAt: string
  lastResumedAtMs: number
  lastInputAtMs: number
  lastOutputAtMs: number
}

export interface HostsDeps {
  getSettings(): PodiumSettings
  /** Connected client fan-out (hostMetricsChanged — live-only, message-class). */
  clients(): Iterable<{ send(msg: LiveServerMessage): void }>
  /** Display name for a machineId — stamps inbound samples. */
  machineName(id: string): string
  /** Live sessions, projected — the auto-hibernate candidate pool. */
  sessions(): Iterable<HostSessionView>
  hibernateSession(input: { sessionId: string }): { ok: boolean; reason?: string }
  /** The registry's shared daemon request/response plumbing (timeout + resolver
   *  registration + control-message routing). `machineId` undefined = default machine. */
  daemonRequest<T>(
    pending: Map<string, (r: T) => void>,
    prefix: string,
    timeoutMs: number,
    onTimeout: () => T,
    buildMsg: (requestId: string) => ControlMessage,
    machineId?: string,
  ): Promise<T>
}

/**
 * Host health: the latest per-machine metrics sample, its client fan-out, the
 * memory-pressure auto-hibernate sweep, and the memory-breakdown daemon RPC
 * (issue #13 Phase 2 — peeled off SessionRegistry).
 */
export class HostsService {
  // Latest health sample per daemon host, keyed by machineId — each connected
  // machine reports its own sample, scoped to it so a detach drops only its row.
  private readonly latestHostMetrics = new Map<string, HostMetricsWire>()
  // At most one hibernation per cooldown window PER MACHINE — memory readings need
  // time to reflect the previous kill before deciding to take down another agent.
  // Each machine has its own memory budget, so the cooldown and the candidate pool
  // are both scoped to the machine whose sample triggered this (sample.machineId).
  private readonly lastAutoHibernateMsByMachine = new Map<string, number>()
  private readonly pendingBreakdowns = new Map<string, (r: MemoryBreakdown | undefined) => void>()

  constructor(
    private readonly deps: HostsDeps,
    bus: EventBus,
  ) {
    // This machine's host sample is only as live as its socket — drop it so a dead
    // machine's numbers never linger as truth. Keyed by machineId, so other machines'
    // samples are untouched.
    bus.on('machine.disconnected', ({ machineId }) => {
      if (this.latestHostMetrics.delete(machineId)) this.broadcastHostMetrics()
    })
  }

  /** Inbound daemon hostMetrics sample: tag it with the reporting machine so clients
   *  can attribute it and the per-machine cooldown/candidate scoping works. */
  onHostMetrics(machineId: string, sample: Omit<HostMetricsWire, 'machineId' | 'name'>): void {
    const tagged: HostMetricsWire = {
      ...sample,
      machineId,
      name: this.deps.machineName(machineId),
    }
    this.latestHostMetrics.set(machineId, tagged)
    this.broadcastHostMetrics()
    this.maybeAutoHibernate(tagged)
  }

  hostMetricsMessage(): LiveServerMessage {
    return { type: 'hostMetricsChanged', hosts: [...this.latestHostMetrics.values()] }
  }

  /** Bootstrap snapshot for a fresh client — sent only when samples exist. */
  snapshotFor(send: (msg: ServerMessage) => void): void {
    if (this.latestHostMetrics.size > 0) send(this.hostMetricsMessage())
  }

  private broadcastHostMetrics(): void {
    const msg = this.hostMetricsMessage()
    for (const c of this.deps.clients()) c.send(msg)
  }

  private maybeAutoHibernate(sample: HostMetricsWire): void {
    const cfg = this.deps.getSettings().hibernation
    if (!cfg.enabled) return
    const machineId = sample.machineId ?? LOCAL_PLACEHOLDER
    const m = sample.memory
    if (m.totalBytes <= 0) return
    const usedPct = ((m.totalBytes - m.availableBytes) / m.totalBytes) * 100
    if (usedPct < cfg.memoryPct) return
    const now = Date.now()
    if (now - (this.lastAutoHibernateMsByMachine.get(machineId) ?? 0) < 60_000) return
    const idleCutoff = now - cfg.idleMinutes * 60_000
    // A foreground turn can end (phase → idle) while a background agent or
    // `&`-spawned task keeps running — and a running agent paints its TUI, so
    // recent PTY output is the giveaway. Require the PTY to have been quiet for a
    // full minute before parking, so we never hibernate work that's still going.
    const OUTPUT_QUIET_MS = 60_000
    const candidates = [...this.deps.sessions()]
      .filter(
        (s) =>
          // Only this machine's sessions are bound by this machine's memory budget.
          s.machineId === machineId &&
          s.status === 'live' &&
          s.resume !== undefined &&
          // Only agents that are demonstrably done/idle. needs_user keeps its
          // pending question; working agents are obviously off-limits.
          (s.agentState?.phase === 'idle' || s.agentState?.phase === 'ended') &&
          // "Idle since" is the latest of genuine agent activity (lastActiveAt),
          // the last resume, and the last user input — any of them resets the idle
          // timer WITHOUT restamping lastActiveAt (which owns recency ordering).
          Math.max(Date.parse(s.lastActiveAt), s.lastResumedAtMs, s.lastInputAtMs) <= idleCutoff &&
          // A running TUI repaints, so recent output means work is still going.
          now - s.lastOutputAtMs >= OUTPUT_QUIET_MS,
      )
      .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt))
    const target = candidates[0]
    if (!target) return
    this.lastAutoHibernateMsByMachine.set(machineId, now)
    console.info(
      `[podium] memory ${usedPct.toFixed(0)}% on ${sample.hostname} ≥ ${cfg.memoryPct}% — hibernating idle session ${target.sessionId}`,
    )
    this.deps.hibernateSession({ sessionId: target.sessionId })
  }

  /** Ask a daemon who owns the used memory. Resolves undefined when no daemon
   *  answers in time. `machineId` targets a specific machine (the one whose chip
   *  was clicked); omitted → the default online machine. */
  memoryBreakdown(roots: string[], machineId?: string): Promise<MemoryBreakdown | undefined> {
    return this.deps.daemonRequest<MemoryBreakdown | undefined>(
      this.pendingBreakdowns,
      'mb',
      MEMORY_BREAKDOWN_TIMEOUT_MS,
      () => undefined,
      (requestId) => ({ type: 'memoryBreakdownRequest', requestId, roots }),
      machineId,
    )
  }

  /** Resolver for the daemon's memoryBreakdownResult reply. */
  onMemoryBreakdownResult(msg: Extract<DaemonMessage, { type: 'memoryBreakdownResult' }>): void {
    const resolve = this.pendingBreakdowns.get(msg.requestId)
    if (resolve) {
      this.pendingBreakdowns.delete(msg.requestId)
      const { type: _type, requestId: _requestId, ...breakdown } = msg
      resolve(breakdown)
    }
  }
}
