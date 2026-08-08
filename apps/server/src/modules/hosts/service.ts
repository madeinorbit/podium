import type { AgentRuntimeState, HostMetricsWire, MachineId, SessionId } from '@podium/model'
import type { DaemonMessage, LiveServerMessage, ServerMessage } from '@podium/protocol'
import type { PodiumSettings } from '@podium/runtime'
import type { EventBus } from '../bus'
import { type DaemonRequestPort, daemonRequestKind } from '../daemon-request'

/** The daemon's memoryBreakdownResult, minus wire plumbing (type/requestId). */
export type MemoryBreakdown = Omit<
  Extract<DaemonMessage, { type: 'memoryBreakdownResult' }>,
  'type' | 'requestId'
>

const MEMORY_BREAKDOWN_TIMEOUT_MS = 10_000

/** The host memory-probe request family (POD-318) — `undefined` is the timeout
 *  answer, so the result type is deliberately nullable. */
const MEMORY_BREAKDOWN = daemonRequestKind<MemoryBreakdown | undefined>('mb')
const MEMORY_HIBERNATE_COOLDOWN_MS = 60_000
const OUTPUT_QUIET_MS = 60_000
// Four immediately, then four/minute: conservative enough to avoid a kill
// cascade, but a 49-session overage converges in about 12 minutes rather than an hour.
const COUNT_HIBERNATE_BURST = 4
const COUNT_HIBERNATE_REFILL_MS = 15_000
/** Floor on the quiet window before an unobserved session counts toward the
 *  idle-live cap and may become parkable (POD-565). 4 h is long on purpose:
 *  absence of a phase signal means we genuinely do not know, and the cost of
 *  being wrong is killing a working agent. */
const UNKNOWN_PHASE_MIN_QUIET_MS = 4 * 60 * 60_000

interface CountHibernateBudget {
  tokens: number
  lastRefillMs: number
}

/** The session fields the auto-hibernate candidate scan reads — a structural
 *  projection of Session so the service never touches the registry's map. */
export interface HostSessionView {
  sessionId: SessionId
  machineId: string
  status: string
  /** Distinguishes shells (no observer, no resume) from harness agents. */
  agentKind: string
  resume?: { kind: string; value: string } | undefined
  agentState?: AgentRuntimeState | undefined
  lastActiveAt: string
  lastResumedAtMs: number
  lastInputAtMs: number
  lastOutputAtMs: number
  /**
   * Whether this session's issue is finished — done stage, an explicit close
   * reason, or deleted. Absent when the session has no issue at all.
   *
   * ORDERING ONLY. See {@link HostsService.lifecycleTier} for why it can never
   * become a gate.
   */
  issueClosed?: boolean | undefined
}

export interface HostsDeps {
  getSettings(): PodiumSettings
  /** Connected client fan-out (hostMetricsChanged — live-only, message-class). */
  clients(): Iterable<{ send(msg: LiveServerMessage): void }>
  /** Display name for a machineId — stamps inbound samples. */
  machineName(id: string): string
  /** Live sessions, projected — the auto-hibernate candidate pool. */
  sessions(): Iterable<HostSessionView>
  hibernateSession(input: { sessionId: SessionId; requireTerminalProof?: boolean }): {
    ok: boolean
    reason?: string
  }
  /**
   * Park a live shell for the idle-shell policy: kill the process, keep the
   * row inspectable. Shells need no resume ref (a fresh spawn is recovery).
   * Does not free worktrees — that stays an explicit stop.
   */
  parkShellSession(input: { sessionId: SessionId }): { ok: boolean; reason?: string }
  /** Server-authoritative, atomically revalidated two-pass terminal proof. */
  hasValidTerminalProof(sessionId: SessionId): boolean
  /** Distinguish mixed-version/no-proof terminals from a present but stale proof. */
  terminalProofMissing(sessionId: SessionId): boolean
  /**
   * The ONE daemon-RPC correlator (POD-318), taken as the broker's own exported
   * port instead of a locally re-declared function type.
   *
   * The six-argument `daemonRequest` this replaces was a structural copy of the
   * identical declaration in `conversations/service.ts` — and because it could
   * only hand a resolver back, this service had to own `pendingBreakdowns` to
   * receive it. The port owns the registry, the timeout and the
   * answering-machine check (POD-1175); `machineId` undefined still means the
   * default machine, resolved by the broker at send time.
   */
  daemonRequest: DaemonRequestPort
}

/**
 * Host health: the latest per-machine metrics sample, its client fan-out, the
 * memory/load/count auto-hibernate sweep, and the memory-breakdown daemon RPC
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
  /** Dedup key for the unobserved-quiet log line (POD-565 step 1). */
  private readonly lastUnobservedCountByMachine = new Map<string, number>()
  private readonly missingProofLogged = new Set<string>()

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
  onHostMetrics(machineId: MachineId, sample: Omit<HostMetricsWire, 'machineId' | 'name'>): void {
    const tagged: HostMetricsWire = {
      ...sample,
      machineId,
      name: this.deps.machineName(machineId),
    }
    const idleCapUnmet = this.maybeAutoHibernate(machineId, tagged)
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

  /** Apply memory, load, and idle-count pressure independently [spec:SP-c29e].
   *
   *  Memory and load share one per-machine cooldown map (one resource park per
   *  cooldown window); count pressure keeps its own token bucket. Each branch
   *  parks at most one session per sample over the same candidate pool and
   *  safety gates — N independent pressure sources, not a redesign.
   *
   *  `machineId` is a PARAMETER, not `sample.machineId`: the reporting machine is a
   *  fact of the authenticated frame this sample arrived on, and the wire field is
   *  optional (a daemon does not name itself per sample — the socket does). Reading it
   *  off the payload meant a `?? '__local__'` fallback on all three of these methods,
   *  i.e. a scope that silently collapsed to a placeholder if the tag were ever
   *  dropped. Passing it down cannot. */
  private maybeAutoHibernate(machineId: string, sample: HostMetricsWire): number | undefined {
    const cfg = this.deps.getSettings().hibernation
    if (!cfg.enabled) {
      this.lastCapUnmetByMachine.delete(machineId)
      this.lastUnobservedCountByMachine.delete(machineId)
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
        const target = this.eligibleCandidates(
          machineId,
          cfg.idleMinutes,
          now,
          failed,
          cfg.idleShellHours,
        )[0]
        if (!target) break
        if (!this.tryHibernateCandidate(target, failed)) continue
        this.lastAutoHibernateMsByMachine.set(machineId, now)
        console.info(
          `[podium] memory ${usedPct.toFixed(0)}% on ${sample.hostname} ≥ ${cfg.memoryPct}% — hibernating idle session ${target.sessionId}`,
        )
        break
      }
    }

    // Load uses load1 (not load5): a day-long pin leaves load5 high long after
    // the fleet drains and would over-park during recovery. loadPerCore null = off.
    // Re-read the shared cooldown after the memory branch so dual pressure parks once.
    const load = sample.load
    const loadPerCore =
      load && load.cpuCount > 0 ? load.one / load.cpuCount : undefined
    const loadReady =
      cfg.loadPerCore !== null &&
      loadPerCore !== undefined &&
      loadPerCore >= cfg.loadPerCore &&
      now - (this.lastAutoHibernateMsByMachine.get(machineId) ?? 0) >= MEMORY_HIBERNATE_COOLDOWN_MS

    if (loadReady) {
      while (true) {
        const target = this.eligibleCandidates(
          machineId,
          cfg.idleMinutes,
          now,
          failed,
          cfg.idleShellHours,
        )[0]
        if (!target) break
        if (!this.tryHibernateCandidate(target, failed)) continue
        this.lastAutoHibernateMsByMachine.set(machineId, now)
        console.info(
          `[podium] load ${loadPerCore.toFixed(2)}×/core on ${sample.hostname} ≥ ${cfg.loadPerCore}× — hibernating idle session ${target.sessionId}`,
        )
        break
      }
    }

    // Shells never enter hibernateSession (no resume ref). Explicit opt-in.
    if (cfg.idleShellHours !== null) {
      this.applyShellIdlePressure(machineId, cfg.idleShellHours, now, failed)
    }

    // Unobserved quiet sessions are IN the idle-live cap when some active policy
    // could park them, and named in the log either way. Log stays so first
    // deploy after step 2 is still inspectable.
    this.reportUnobservedCounted(machineId, cfg.idleMinutes, now, cfg.idleShellHours)

    if (cfg.maxIdleSessions === null) {
      this.lastCapUnmetByMachine.delete(machineId)
      return
    }
    return this.applyCountPressure(
      machineId,
      cfg.idleMinutes,
      cfg.maxIdleSessions,
      now,
      failed,
      cfg.idleShellHours,
    )
  }

  /** Hibernation refuses without a resume ref. Unobserved agents that have one
   *  skip terminal proof — no observer ran, so the long quiet window is the
   *  safety gate. */
  private tryHibernateCandidate(target: HostSessionView, failed: Set<string>): boolean {
    if (!target.resume) {
      failed.add(target.sessionId)
      return false
    }
    const unobserved = this.isUnobservedPhase(target)
    const result = this.deps.hibernateSession({
      sessionId: target.sessionId,
      requireTerminalProof: !unobserved,
    })
    if (!result.ok) {
      failed.add(target.sessionId)
      return false
    }
    return true
  }

  private applyCountPressure(
    machineId: string,
    idleMinutes: number,
    targetCount: number,
    now: number,
    failed: Set<string>,
    idleShellHours: number | null,
  ): number | undefined {
    const budget = this.countBudgetFor(machineId, now)

    while (true) {
      // Re-read after every success: hibernateSession synchronously changes the
      // session status, and the target is convergence rather than a snapshot batch.
      const idleLive = this.idleLiveSessions(machineId, idleMinutes, now, idleShellHours)
      const overage = idleLive.length - targetCount
      if (overage <= 0) {
        this.lastCapUnmetByMachine.delete(machineId)
        return
      }

      const candidates = this.eligibleCandidates(
        machineId,
        idleMinutes,
        now,
        failed,
        idleShellHours,
      )
      if (candidates.length === 0) {
        this.reportCapUnmet(machineId, targetCount, overage)
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
      if (!this.tryHibernateCandidate(target, failed)) continue
      budget.tokens -= 1
      console.info(
        `[podium] idle-session target ${targetCount} on ${this.deps.machineName(machineId)} — hibernating idle session ${target.sessionId}`,
      )
    }
  }

  /**
   * Park the oldest quiet live shell when idleShellHours is set. One per sample
   * (same one-park discipline as memory/load), oldest quiet first.
   */
  private applyShellIdlePressure(
    machineId: string,
    idleShellHours: number,
    now: number,
    failed: Set<string>,
  ): void {
    const cutoff = now - idleShellHours * 60 * 60_000
    const target = [...this.deps.sessions()]
      .filter((session) => {
        if (session.machineId !== machineId || session.status !== 'live') return false
        if (session.agentKind !== 'shell') return false
        if (failed.has(session.sessionId)) return false
        return this.fullyQuietSinceMs(session) <= cutoff
      })
      .sort((a, b) => this.fullyQuietSinceMs(a) - this.fullyQuietSinceMs(b))[0]
    if (!target) return
    const result = this.deps.parkShellSession({ sessionId: target.sessionId })
    if (!result.ok) {
      failed.add(target.sessionId)
      return
    }
    console.info(
      `[podium] idle-shell ${idleShellHours}h on ${this.deps.machineName(machineId)} — parking shell session ${target.sessionId}`,
    )
  }

  /**
   * Idle-live set for the maxIdleSessions convergence target.
   *
   * Observed: phase ∈ {idle, ended, needs_user}.
   * Unobserved (phase unknown / no agentState): counted after max(idleMinutes, 4h)
   * fully quiet — same predicate as the step-1 log, now folded into the cap so
   * they pay their own overage when eligible (POD-565 step 2).
   *
   * COUNT ONLY WHAT AN ACTIVE POLICY COULD PARK. The overage drives how many
   * sessions get hibernated, so an unobserved session that nothing can ever park
   * would make OBSERVED agents pay a debt that never retires, and the loop would
   * then sit in `reportCapUnmet` permanently. Two such classes are excluded:
   *
   *  - a SHELL while `idleShellHours` is null, because `applyShellIdlePressure`
   *    is the only thing that can park one and it is switched off;
   *  - an unobserved session with NO resume ref, because `hibernateSession`
   *    refuses without one.
   *
   * The predicate follows the POLICY, not a constant: turn `idleShellHours` on
   * and shells become parkable, so they start counting in the same breath.
   *
   * `needs_user` is deliberately NOT treated this way. It stays counted and
   * protected — a handful of sessions a human is expected to return to, which is
   * the established stance here; this exclusion is about an unbounded class that
   * no policy is acting on at all.
   *
   * Excluded from the CAP is not excluded from SIGHT: `reportUnobservedCounted`
   * still names every unobserved quiet session, which is the whole point of
   * POD-565.
   */
  private idleLiveSessions(
    machineId: string,
    idleMinutes: number,
    now: number,
    idleShellHours: number | null,
  ): HostSessionView[] {
    const unknownQuietMs = this.unknownQuietWindowMs(idleMinutes)
    return [...this.deps.sessions()].filter((session) => {
      if (session.machineId !== machineId || session.status !== 'live') return false
      const phase = session.agentState?.phase
      // needs_user is idle fleet load too, but deliberately protected from parking.
      if (phase === 'idle' || phase === 'ended' || phase === 'needs_user') return true
      if (!this.isUnobservedPhase(session)) return false
      if (!this.isFullyQuietFor(session, unknownQuietMs, now)) return false
      return this.unobservedIsParkable(session, idleShellHours)
    })
  }

  /** Whether some policy that is currently ON could park this unobserved session. */
  private unobservedIsParkable(
    session: HostSessionView,
    idleShellHours: number | null,
  ): boolean {
    if (session.agentKind === 'shell') return idleShellHours !== null
    return session.resume !== undefined
  }

  private eligibleCandidates(
    machineId: string,
    idleMinutes: number,
    now: number,
    excluded: ReadonlySet<string>,
    idleShellHours: number | null,
  ): HostSessionView[] {
    const idleCutoff = now - idleMinutes * 60_000
    const unknownQuietMs = this.unknownQuietWindowMs(idleMinutes)
    return this.idleLiveSessions(machineId, idleMinutes, now, idleShellHours)
      .filter((session) => {
        if (excluded.has(session.sessionId)) return false
        // Shells never go through hibernateSession — idleShellHours owns them.
        if (session.agentKind === 'shell') return false
        // No resume ref → hibernateSession would refuse. Counted, never eligible.
        if (session.resume === undefined) return false

        const phase = session.agentState?.phase
        if (phase === 'idle' || phase === 'ended') {
          const phaseEligible =
            this.effectiveIdleSinceMs(session) <= idleCutoff &&
            // A foreground turn can end while a background task keeps painting its
            // TUI. A full quiet minute keeps that work protected.
            now - session.lastOutputAtMs >= OUTPUT_QUIET_MS
          if (!phaseEligible) return false
          if (this.deps.hasValidTerminalProof(session.sessionId)) {
            this.missingProofLogged.delete(session.sessionId)
            return true
          }
          if (
            this.deps.terminalProofMissing(session.sessionId) &&
            !this.missingProofLogged.has(session.sessionId)
          ) {
            this.missingProofLogged.add(session.sessionId)
            console.warn(
              '[podium] auto-hibernate skipped terminal candidate ' +
                session.sessionId +
                ': missing durable terminal proof (possible mixed-version observer)',
            )
          }
          return false
        }

        // Unobserved harness agent with a resume ref: long quiet substitutes for
        // terminal proof — no observer ever ran.
        if (
          this.isUnobservedPhase(session) &&
          this.isFullyQuietFor(session, unknownQuietMs, now)
        ) {
          return true
        }
        return false
      })
      .sort(
        (a, b) =>
          this.lifecycleTier(a) - this.lifecycleTier(b) ||
          this.effectiveIdleSinceMs(a) - this.effectiveIdleSinceMs(b),
      )
  }

  /**
   * Reap finished work first (POD-568). Lower tier parks sooner:
   *
   *   0  the session's issue is closed
   *   1  the session has no issue
   *   2  the session's issue is open
   *
   * STAGE ORDERS, IT NEVER AUTHORIZES. This runs on the output of the filter
   * above, so a session reaches the sort only after passing every safety gate
   * independently — resume ref present, phase idle/ended (or unobserved after
   * the long quiet window), idle past `idleMinutes`, output quiet (or the
   * unobserved quiet floor), and a revalidated terminal proof (skipped only
   * when no observer ever ran). A closed issue therefore buys a session no less
   * protection than an open one; it only loses its place in a queue it already
   * qualified for.
   *
   * That distinction is the whole reason this is a comparator and not a
   * predicate. `done` is an agent-writable claim, agents mark it while still
   * writing, and it also means "waiting for merge" — so it cannot be trusted to
   * decide anything. It can be trusted to break a tie, because the tie is
   * between two sessions both already judged safe to park.
   */
  private lifecycleTier(session: HostSessionView): number {
    if (session.issueClosed === true) return 0
    if (session.issueClosed === undefined) return 1
    return 2
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

  private reportCapUnmet(machineId: string, targetCount: number, overage: number): void {
    const signature = `${targetCount}:${overage}`
    if (this.lastCapUnmetByMachine.get(machineId) === signature) return
    this.lastCapUnmetByMachine.set(machineId, signature)
    console.info(
      `[podium] idle-session cap unmet: ${overage} protected/ineligible on ${this.deps.machineName(machineId)} (target ${targetCount})`,
    )
  }

  /**
   * Deduped log of how many quiet unobserved sessions the idle-live set now
   * includes (POD-565). After step 2 they are in the cap; the log remains so a
   * deploy is still inspectable.
   */
  /**
   * Name every unobserved quiet session, and say which of them the cap can
   * actually act on.
   *
   * The two numbers differ on purpose: {@link idleLiveSessions} counts only what
   * an active policy could park, so a host full of shells with `idleShellHours`
   * off reports "3 counted, 19 seen". Reporting only the counted number would
   * re-hide exactly the tail POD-565 exists to expose, and reporting only the
   * total would claim a cap pressure that is not being applied.
   */
  private reportUnobservedCounted(
    machineId: string,
    idleMinutes: number,
    now: number,
    idleShellHours: number | null,
  ): void {
    const unknownQuietMs = this.unknownQuietWindowMs(idleMinutes)
    const quiet = [...this.deps.sessions()].filter(
      (session) =>
        session.machineId === machineId &&
        session.status === 'live' &&
        this.isUnobservedPhase(session) &&
        this.isFullyQuietFor(session, unknownQuietMs, now),
    )
    const counted = quiet.filter((session) =>
      this.unobservedIsParkable(session, idleShellHours),
    ).length
    if (this.lastUnobservedCountByMachine.get(machineId) === quiet.length) return
    this.lastUnobservedCountByMachine.set(machineId, quiet.length)
    if (quiet.length === 0) return
    const quietHours = unknownQuietMs / 3_600_000
    const unparkable = quiet.length - counted
    const tail =
      unparkable > 0
        ? ` — ${unparkable} of them cannot be parked by any policy that is on (shells need idleShellHours; agents need a resume ref), so they are NOT in the cap`
        : ''
    console.info(
      `[podium] idle-session cap counting ${counted} of ${quiet.length} unobserved quiet session(s) on ${this.deps.machineName(machineId)} (≥${quietHours}h quiet, phase unknown)${tail}`,
    )
  }

  private isUnobservedPhase(session: HostSessionView): boolean {
    const phase = session.agentState?.phase
    return phase === undefined || phase === 'unknown'
  }

  private unknownQuietWindowMs(idleMinutes: number): number {
    return Math.max(idleMinutes * 60_000, UNKNOWN_PHASE_MIN_QUIET_MS)
  }

  private isFullyQuietFor(session: HostSessionView, windowMs: number, now: number): boolean {
    const since = this.fullyQuietSinceMs(session)
    return Number.isFinite(since) && now - since >= windowMs
  }

  private fullyQuietSinceMs(session: HostSessionView): number {
    const stamps = [
      Date.parse(session.lastActiveAt),
      session.lastResumedAtMs,
      session.lastInputAtMs,
      session.lastOutputAtMs,
    ]
    return stamps.every(Number.isFinite) ? Math.max(...stamps) : Number.POSITIVE_INFINITY
  }

  /** Ask a daemon who owns the used memory. Resolves undefined when no daemon
   *  answers in time. `machineId` targets a specific machine (the one whose chip
   *  was clicked); omitted → the default online machine. */
  memoryBreakdown(roots: string[], machineId?: string): Promise<MemoryBreakdown | undefined> {
    return this.deps.daemonRequest.request({
      kind: MEMORY_BREAKDOWN,
      timeoutMs: MEMORY_BREAKDOWN_TIMEOUT_MS,
      onTimeout: () => undefined,
      build: (requestId) => ({ type: 'memoryBreakdownRequest', requestId, roots }),
      machineId,
    })
  }

  /** The daemon's memoryBreakdownResult reply, settled through the one
   *  correlator. `machineId` is who ANSWERED — a probe answered by a machine
   *  other than the one it was sent to is dropped by the broker (POD-1175),
   *  which matters here because a breakdown IS that machine's process list. */
  onMemoryBreakdownResult(
    machineId: string,
    msg: Extract<DaemonMessage, { type: 'memoryBreakdownResult' }>,
  ): void {
    const { type: _type, requestId: _requestId, ...breakdown } = msg
    this.deps.daemonRequest.settle(MEMORY_BREAKDOWN, msg.requestId, machineId, breakdown)
  }
}
