import type {
  AgentRuntimeState,
  ControlMessage,
  DaemonMessage,
  HostMetricsWire,
  LiveServerMessage,
  ServerMessage,
} from '@podium/protocol'
import type { PodiumSettings } from '@podium/runtime'
import { LOCAL_PLACEHOLDER } from '../../local-machine'
import type { EventBus } from '../bus'

/** The daemon's memoryBreakdownResult, minus wire plumbing (type/requestId). */
export type MemoryBreakdown = Omit<
  Extract<DaemonMessage, { type: 'memoryBreakdownResult' }>,
  'type' | 'requestId'
>

const MEMORY_BREAKDOWN_TIMEOUT_MS = 10_000
const MEMORY_HIBERNATE_COOLDOWN_MS = 60_000
const OUTPUT_QUIET_MS = 60_000
// Four immediately, then four/minute: conservative enough to avoid a kill
// cascade, but a 49-session overage converges in about 12 minutes rather than an hour.
const COUNT_HIBERNATE_BURST = 4
const COUNT_HIBERNATE_REFILL_MS = 15_000

interface CountHibernateBudget {
  tokens: number
  lastRefillMs: number
}

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
  hibernateSession(input: { sessionId: string; requireTerminalProof?: boolean }): {
    ok: boolean
    reason?: string
  }
  /** Server-authoritative, atomically revalidated two-pass terminal proof. */
  hasValidTerminalProof(sessionId: string): boolean
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
  private readonly countHibernateBudgetByMachine = new Map<string, CountHibernateBudget>()
  private readonly lastCapUnmetByMachine = new Map<string, string>()
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
    const idleCapUnmet = this.maybeAutoHibernate(tagged)
    this.latestHostMetrics.set(machineId, { ...tagged, idleCapUnmet })
    this.broadcastHostMetrics()
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

  /** Apply memory and idle-count pressure independently [spec:SP-c29e]. */
  private maybeAutoHibernate(sample: HostMetricsWire): number | undefined {
    const cfg = this.deps.getSettings().hibernation
    const machineId = sample.machineId ?? LOCAL_PLACEHOLDER
    if (!cfg.enabled) {
      this.lastCapUnmetByMachine.delete(machineId)
      return
    }

    const now = Date.now()
    const failed = new Set<string>()
    const m = sample.memory
    const usedPct =
      m.totalBytes > 0 ? ((m.totalBytes - m.availableBytes) / m.totalBytes) * 100 : undefined
    const memoryReady =
      usedPct !== undefined &&
      usedPct >= cfg.memoryPct &&
      now - (this.lastAutoHibernateMsByMachine.get(machineId) ?? 0) >= MEMORY_HIBERNATE_COOLDOWN_MS

    if (memoryReady) {
      // A raced/refused candidate must not spend the cooldown or block the next
      // safely parkable session. Re-read the live projection after every attempt.
      while (true) {
        const target = this.eligibleCandidates(machineId, cfg.idleMinutes, now, failed)[0]
        if (!target) break
        const result = this.deps.hibernateSession({
          sessionId: target.sessionId,
          requireTerminalProof: true,
        })
        if (!result.ok) {
          failed.add(target.sessionId)
          continue
        }
        this.lastAutoHibernateMsByMachine.set(machineId, now)
        console.info(
          `[podium] memory ${usedPct.toFixed(0)}% on ${sample.hostname} ≥ ${cfg.memoryPct}% — hibernating idle session ${target.sessionId}`,
        )
        break
      }
    }

    if (cfg.maxIdleSessions === null) {
      this.lastCapUnmetByMachine.delete(machineId)
      return
    }
    return this.applyCountPressure(sample, cfg.idleMinutes, cfg.maxIdleSessions, now, failed)
  }

  private applyCountPressure(
    sample: HostMetricsWire,
    idleMinutes: number,
    targetCount: number,
    now: number,
    failed: Set<string>,
  ): number | undefined {
    const machineId = sample.machineId ?? LOCAL_PLACEHOLDER
    const budget = this.countBudgetFor(machineId, now)

    while (true) {
      // Re-read after every success: hibernateSession synchronously changes the
      // session status, and the target is convergence rather than a snapshot batch.
      const idleLive = this.idleLiveSessions(machineId)
      const overage = idleLive.length - targetCount
      if (overage <= 0) {
        this.lastCapUnmetByMachine.delete(machineId)
        return
      }

      const candidates = this.eligibleCandidates(machineId, idleMinutes, now, failed)
      if (candidates.length === 0) {
        this.reportCapUnmet(sample, targetCount, overage)
        return overage
      }

      // Eligible work remains, so the target is merely rate-limited rather than
      // blocked by protected sessions. A later host tick continues convergence.
      if (budget.tokens === 0) {
        this.lastCapUnmetByMachine.delete(machineId)
        return
      }

      const target = candidates[0]
      if (!target) return undefined
      const result = this.deps.hibernateSession({
        sessionId: target.sessionId,
        requireTerminalProof: true,
      })
      if (!result.ok) {
        failed.add(target.sessionId)
        continue
      }
      budget.tokens -= 1
      console.info(
        `[podium] idle-session target ${targetCount} on ${sample.hostname} — hibernating idle session ${target.sessionId}`,
      )
    }
  }

  private idleLiveSessions(machineId: string): HostSessionView[] {
    return [...this.deps.sessions()].filter((session) => {
      if (session.machineId !== machineId || session.status !== 'live') return false
      const phase = session.agentState?.phase
      // needs_user is idle fleet load too, but deliberately protected from parking.
      return phase === 'idle' || phase === 'ended' || phase === 'needs_user'
    })
  }

  private eligibleCandidates(
    machineId: string,
    idleMinutes: number,
    now: number,
    excluded: ReadonlySet<string>,
  ): HostSessionView[] {
    const idleCutoff = now - idleMinutes * 60_000
    return this.idleLiveSessions(machineId)
      .filter((session) => {
        const phase = session.agentState?.phase
        return (
          !excluded.has(session.sessionId) &&
          this.deps.hasValidTerminalProof(session.sessionId) &&
          session.resume !== undefined &&
          (phase === 'idle' || phase === 'ended') &&
          this.effectiveIdleSinceMs(session) <= idleCutoff &&
          // A foreground turn can end while a background task keeps painting its
          // TUI. A full quiet minute keeps that work protected.
          now - session.lastOutputAtMs >= OUTPUT_QUIET_MS
        )
      })
      .sort((a, b) => this.effectiveIdleSinceMs(a) - this.effectiveIdleSinceMs(b))
  }

  private effectiveIdleSinceMs(session: HostSessionView): number {
    // Any malformed timestamp is protected rather than accidentally treated as
    // ancient. Session normally sanitizes these before the structural projection.
    const timestamps = [
      Date.parse(session.lastActiveAt),
      session.lastResumedAtMs,
      session.lastInputAtMs,
    ]
    return timestamps.every(Number.isFinite) ? Math.max(...timestamps) : Number.POSITIVE_INFINITY
  }

  private countBudgetFor(machineId: string, now: number): CountHibernateBudget {
    let budget = this.countHibernateBudgetByMachine.get(machineId)
    if (!budget) {
      budget = { tokens: COUNT_HIBERNATE_BURST, lastRefillMs: now }
      this.countHibernateBudgetByMachine.set(machineId, budget)
      return budget
    }

    const refillCount = Math.max(
      0,
      Math.floor((now - budget.lastRefillMs) / COUNT_HIBERNATE_REFILL_MS),
    )
    if (refillCount > 0) {
      budget.tokens = Math.min(COUNT_HIBERNATE_BURST, budget.tokens + refillCount)
      budget.lastRefillMs += refillCount * COUNT_HIBERNATE_REFILL_MS
    }
    return budget
  }

  private reportCapUnmet(sample: HostMetricsWire, targetCount: number, overage: number): void {
    const machineId = sample.machineId ?? LOCAL_PLACEHOLDER
    const signature = `${targetCount}:${overage}`
    if (this.lastCapUnmetByMachine.get(machineId) === signature) return
    this.lastCapUnmetByMachine.set(machineId, signature)
    console.info(
      `[podium] idle-session cap unmet: ${overage} protected/ineligible on ${sample.hostname} (target ${targetCount})`,
    )
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
