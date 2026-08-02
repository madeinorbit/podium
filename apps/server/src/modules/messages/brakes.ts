/**
 * Containment brakes 1 and 2 [spec:SP-34d7 containment] — extracted from
 * `MessageDeliveryService` (POD-1397).
 *
 * Two brakes, one owner, because they answer the same question with different
 * clocks: how much agent work may a message cause? Brake 1 rate-limits WAKES
 * (one per sender+target-issue per ten minutes); brake 2 caps message-triggered
 * SPAWNS (per issue, per UTC day). Without both, a pair of agents replying to
 * each other forks PTY sessions until the host dies.
 *
 * WHAT THIS OWNS, and what it deliberately does not:
 *
 *  - It owns `lastWakeAt`, `wakeCooldownTimers` and `spawnCount` outright. No
 *    other module holds a reference to any of them; the timers in particular
 *    never leave, which is why {@link DeliveryBrakes.dispose} can promise the
 *    process is clear of them.
 *  - It does NOT derive brake keys. A wake key is `sender|target-issue`, and
 *    resolving a session target to its issue is the delivery service's job —
 *    it holds the session→issue map. Re-deriving the key here would let the
 *    key the cooldown WRITES drift from the key the send path CHECKS, and the
 *    two are compared: an asymmetric key silently disables the brake instead of
 *    failing. Keys arrive as parameters.
 *  - It does NOT queue deliveries. When a cooldown elapses the targets that
 *    were waiting on it are handed back through `onCooldownElapsed`, and the
 *    scheduler decides what to do with them.
 */

import type { EventsRepository } from '../../store/events'
import type { MessagesRepository } from '../../store/messages'
import { type DeliveryTarget, deliveryTargetKey } from './targets'

/** One wake per (sender, target-issue) per this window (brake 1). */
export const WAKE_COOLDOWN_MS = 10 * 60_000
/** Message-triggered spawns per issue per UTC day (brake 2). */
export const SPAWN_BUDGET_PER_DAY = 10

/**
 * Ports, all narrowed from the real collaborators rather than restated, so a
 * signature here cannot drift from the repository it stands for.
 */
export interface DeliveryBrakeDeps {
  messages: Pick<MessagesRepository, 'getWakeCooldown' | 'recordWakeCooldown'>
  events: Pick<EventsRepository, 'listEventsSince'>
  now(): string
  /** A cooldown expired: these targets were waiting on it and may be retried
   *  now. Called from a timer, so it must not throw. */
  onCooldownElapsed(targets: readonly DeliveryTarget[]): void
}

export class DeliveryBrakes {
  /** Last wake timestamp per sender+resolved-target brake key. This is a
   * write-through cache over message_wake_cooldowns; cold reads are keyed. */
  private readonly lastWakeAt = new Map<string, number>()
  /** One restart-recoverable wake-cooldown timer per sender+target brake key. */
  private readonly wakeCooldownTimers = new Map<
    string,
    {
      deadline: number
      timer: ReturnType<typeof setTimeout>
      targets: Map<string, DeliveryTarget>
    }
  >()
  /** message-triggered spawns per issue for the current UTC day (brake 2) — a
   *  cache over the `message.spawned` event ledger (restart-proof). */
  private readonly spawnCount = new Map<string, { day: string; count: number }>()

  constructor(private readonly deps: DeliveryBrakeDeps) {}

  private nowMs(): number {
    return Date.parse(this.deps.now())
  }

  // ---- brake 1: wake cooldown ----------------------------------------------

  /** True while this key's last wake is inside the cooldown window. Cold reads
   *  fall through to the durable row, so a restart does not reopen the brake. */
  isWakeHot(key: string): boolean {
    const cutoff = this.nowMs() - WAKE_COOLDOWN_MS
    const last = this.lastWakeAt.get(key)
    if (last !== undefined) return last > cutoff
    const attemptedAt = this.deps.messages.getWakeCooldown(key)
    const parsed = attemptedAt ? Date.parse(attemptedAt) : 0
    const derived = Number.isFinite(parsed) ? parsed : 0
    this.lastWakeAt.set(key, derived)
    return derived > cutoff
  }

  /** Arm one timer for every queued target sharing a sender+issue cooldown key.
   *  The deadline comes from lastWakeAt, whose cold-path value is reconstructed
   *  from durable message rows, so reconcileQueued() restores this after restart. */
  scheduleWakeRetry(key: string, target: DeliveryTarget): void {
    const last = this.lastWakeAt.get(key)
    if (last === undefined) return
    const deadline = last + WAKE_COOLDOWN_MS
    const existing = this.wakeCooldownTimers.get(key)
    if (existing && existing.deadline === deadline) {
      existing.targets.set(deliveryTargetKey(target), target)
      return
    }
    if (existing) clearTimeout(existing.timer)
    const targets = existing?.targets ?? new Map<string, DeliveryTarget>()
    targets.set(deliveryTargetKey(target), target)
    const timer = setTimeout(
      () => {
        const pending = this.wakeCooldownTimers.get(key)
        if (!pending || pending.deadline !== deadline) return
        this.wakeCooldownTimers.delete(key)
        this.deps.onCooldownElapsed([...pending.targets.values()])
      },
      Math.max(1, deadline - this.nowMs()),
    )
    timer.unref?.()
    this.wakeCooldownTimers.set(key, { deadline, timer, targets })
  }

  /** Durable write happens before queueText/spawn, so a crash or transport
   * failure cannot erase the cooldown attempt. */
  recordWake(key: string): void {
    const attemptedAt = this.deps.now()
    this.deps.messages.recordWakeCooldown(key, attemptedAt)
    const parsed = Date.parse(attemptedAt)
    this.lastWakeAt.set(key, Number.isFinite(parsed) ? parsed : this.nowMs())
  }

  // ---- brake 2: spawn budget -----------------------------------------------

  /** Today's spawn count for an issue key — in-memory cache over the durable
   *  event ledger (`message.spawned` from the wake seam, plus `agent.spawned`
   *  rows that carry `budgetIssue` — the gate's budgeted agent spawns), so a
   *  restart never resets brake 2. */
  spawnCountFor(key: string, day: string): number {
    const entry = this.spawnCount.get(key)
    if (entry?.day === day) return entry.count
    let count = 0
    try {
      for (const e of this.deps.events.listEventsSince(0, {
        kinds: ['message.spawned', 'agent.spawned'],
        limit: 5000,
      })) {
        const p = e.payload as { spawnIssue?: string; budgetIssue?: string } | null
        // agent.spawned rows only count when budgeted (operator spawns are free).
        const k = e.kind === 'agent.spawned' ? p?.budgetIssue : (p?.spawnIssue ?? 'no-issue')
        if (k !== undefined && e.ts.slice(0, 10) === day && k === key) count++
      }
    } catch {}
    this.spawnCount.set(key, { day, count })
    return count
  }

  /** Record one consumed spawn against today's budget for this key. */
  chargeSpawn(key: string, day: string, count: number): void {
    this.spawnCount.set(key, { day, count })
  }

  /** Brake 2 for DIRECT agent spawns (`podium agent spawn`) — the gate shares
   *  the same per-issue daily budget as the spawn-on-wake seam, or a looping
   *  agent could fork-bomb the host with full PTY sessions the wake budget
   *  never sees [spec:SP-34d7 containment]. Consumes one unit when available. */
  takeSpawnBudget(issueId: string | null): { ok: boolean; count: number } {
    const key = issueId ?? 'no-issue'
    const day = this.deps.now().slice(0, 10)
    const count = this.spawnCountFor(key, day)
    if (count >= SPAWN_BUDGET_PER_DAY) return { ok: false, count }
    this.spawnCount.set(key, { day, count: count + 1 })
    return { ok: true, count: count + 1 }
  }

  /**
   * Every timer this owner armed, cleared. The service's `dispose()` calls
   * this; nothing else can, because nothing else holds the map. A brake timer
   * that outlives the service would call back into a disposed scheduler ten
   * minutes after shutdown — the shape POD-1390 found in session memory.
   */
  dispose(): void {
    for (const pending of this.wakeCooldownTimers.values()) clearTimeout(pending.timer)
    this.wakeCooldownTimers.clear()
  }
}
