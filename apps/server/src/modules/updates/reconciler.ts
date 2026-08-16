import { createLogger } from '@podium/logger'
import { asMachineId, type UpdateChannel } from '@podium/model'
import type { UpdateTarget } from '@podium/protocol'
import type { MachineApplyOutcome, UpdatesService } from './service'
import {
  IN_FLIGHT_STATES,
  machineCanTakeDelivery,
  offeredDeliveries,
  TERMINAL_STATES,
  type WaveMachine,
} from './wave'

/**
 * THE STANDING RECONCILIATION (POD-2105, spec §3.6, decision §9.1).
 *
 * The one sentence: an update finishes even when part of the fleet is asleep,
 * and the sleepers converge on their own when they wake — no operation, no
 * second click.
 *
 * The plan already does half of it. `planUpdateOperation` partitions the
 * behind-target machines into CORE (connected, deliverable — they gate the
 * outcome) and EVENTUAL (`deferred`, with an honest note), so the operation can
 * reach `done` while a laptop is shut. This file is the other half: the small,
 * always-on thing that notices the laptop reconnecting and converges it.
 *
 * WHY THIS IS NOT A WAVE, AND MUST NOT BECOME ONE
 * -----------------------------------------------
 * A wave is a decision a human made about a fleet at a moment: it has a canary,
 * a widening rule, concurrency, and an operation counting it. This is background
 * convergence — one machine at a time, spaced, with nobody watching. It reuses
 * the wave's MUSCLE (`authorizeMachine` → `planWave` → the grant protocol) and
 * none of its choreography, which is why it can run with no operation at all.
 *
 * THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 * ----------------------------------------------
 *  1. **It never races an operation.** While an exclusive `lifecycle` operation
 *     is active the operation owns granting, and this is paused ({@link decideReconciliation}
 *     refuses with `operation-active`). It resumes on the operation's TERMINAL
 *     transition and sweeps anyone still behind — which is also how a `failed`
 *     operation gets cleaned up without a human pressing Try again.
 *  2. **It never hot-loops.** A machine that answered `rejected` or `stuck` is
 *     left alone until the target changes or a human applies it by hand. That is
 *     not a nicety: `authorizeMachine` deliberately CLEARS a terminal state
 *     before planning (it is the human retry path), so a reconciler that called
 *     it unconditionally would erase the refusal it should have obeyed and
 *     re-grant on every reconnect, forever.
 *  3. **It says who moved a machine.** {@link UpdateReconciler.convergedBy}
 *     marks the machines this converged, so the fleet payload can label a row
 *     that moved with nobody looking (additive; see the `convergedBy` field).
 *
 * WHAT IT IS DELIBERATELY NOT WIRED TO: publishing a target.
 * -----------------------------------------------------------
 * A new version arriving is an OFFER (§3.2, §6.1) — the thing a human decides
 * about. If this listened for it, every publication would install itself on the
 * whole connected fleet, which is not convergence but auto-update, and nobody
 * asked for it. Its two triggers are a machine RECONNECTING and an operation
 * ENDING, and both inherit a decision that was already made: the first by §9.1
 * ("stragglers converge to the current target without a new human decision"),
 * the second by the click that started the operation.
 */

const log = createLogger('server:updates')

/** Why a machine was NOT converged. Every refusal is named, because a background
 *  process that silently does nothing is indistinguishable from a broken one. */
export type ReconcileRefusal =
  | 'operation-active'
  | 'unknown-machine'
  | 'no-target'
  | 'at-target'
  | 'offline'
  | 'supervised'
  | 'cannot-take-delivery'
  | 'in-flight'
  | 'terminal'
  | 'attempts-exhausted'

export type ReconcileDecision = { converge: true } | { converge: false; because: ReconcileRefusal }

export interface ReconcileFacts {
  /** The live row from the fleet projection, or absent if the machine is gone. */
  machine: WaveMachine | undefined
  /** The target published for THIS machine's channel — never a global default. */
  target: UpdateTarget | undefined
  /** Is an exclusive lifecycle operation running right now? Read per call. */
  operationActive: boolean
  /** How many grants this reconciler has already issued for this exact target. */
  attempts: number
  maxAttempts?: number
}

/**
 * How many times this may grant one machine one target before giving up.
 *
 * Two, not one, because the honest failure this bounds is not a refusal — a
 * refusal lands as `rejected`/`stuck` and is caught by the terminal check above
 * it. This bounds the machine that reconnects still behind having said nothing:
 * a daemon that swapped, crashed and rolled back looks exactly like a daemon
 * that never got the grant, and the difference is only visible in whether a
 * second attempt changes anything. After the second it is a standing fault, and
 * a background process must not keep poking a standing fault.
 */
export const MAX_RECONCILE_ATTEMPTS = 2

/** How long between two grants. Background convergence, not a wave (§3.6). */
const DEFAULT_GRANT_SPACING_MS = 5_000

/**
 * THE DECISION, as a pure function (the whole point of the split).
 *
 * "Should this machine be converged right now?" is a question with nine wrong
 * answers and one right one, and every one of them is a table row rather than a
 * scenario someone has to build a fleet to reproduce.
 *
 * ORDER IS THE SPECIFICATION. `operation-active` is first because it is about
 * the SERVER, not the machine — while an operation holds the group nothing here
 * may act, whatever the machine looks like. `terminal` precedes
 * `attempts-exhausted` because a machine that said no has said something, and
 * the log should quote it rather than a counter.
 */
export function decideReconciliation(facts: ReconcileFacts): ReconcileDecision {
  if (facts.operationActive) return { converge: false, because: 'operation-active' }
  const machine = facts.machine
  if (!machine) return { converge: false, because: 'unknown-machine' }
  if (!facts.target) return { converge: false, because: 'no-target' }
  if (machine.version === facts.target.version) return { converge: false, because: 'at-target' }
  if (!machine.online) return { converge: false, because: 'offline' }
  // A supervised daemon is part of a signed application bundle; the shell
  // updates it, and no fleet path ever may (§4, P5). Named separately from the
  // caps refusal below because it is not a question about delivery methods.
  if (machine.supervised === true) return { converge: false, because: 'supervised' }
  if (!machineCanTakeDelivery(machine, offeredDeliveries(facts.target))) {
    return { converge: false, because: 'cannot-take-delivery' }
  }
  if (IN_FLIGHT_STATES.has(machine.state)) return { converge: false, because: 'in-flight' }
  // THE LOOP GUARD. `authorizeMachine` clears this state as the human retry
  // path; reading it HERE, before calling that, is what keeps the machine's own
  // refusal standing against a process nobody asked.
  if (TERMINAL_STATES.has(machine.state)) return { converge: false, because: 'terminal' }
  if (facts.attempts >= (facts.maxAttempts ?? MAX_RECONCILE_ATTEMPTS)) {
    return { converge: false, because: 'attempts-exhausted' }
  }
  return { converge: true }
}

export interface UpdateReconcilerDeps {
  updates: UpdatesService
  /**
   * Is an exclusive lifecycle operation active? A THUNK, read per decision:
   * the answer changes on every operation transition, and a captured one would
   * make the pause outlive the operation that justified it.
   */
  operationActive: () => boolean
  /** Deferred wake-up. Injected so no test ever sleeps. */
  schedule?: (fn: () => void, ms: number) => void
  /** How long between two grants; also how often an outstanding one is re-read. */
  spacingMs?: number
  maxAttempts?: number
}

function defaultSchedule(fn: () => void, ms: number): void {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
}

/** Ledger key: a machine's attempts are counted PER TARGET, so a new version is
 *  a fresh start and no bookkeeping has to be swept when one is published.
 *  `@` separates because a machine id never contains one and a version may
 *  contain everything else a version label is allowed to contain. */
const attemptKey = (machineId: string, targetVersion: string): string =>
  `${machineId}@${targetVersion}`

export class UpdateReconciler {
  /** Waiting to be considered. Deduped: a flapping daemon must not queue twice. */
  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  /** The grant THIS issued that has not yet reached an outcome (concurrency 1). */
  private outstanding: string | undefined
  private pumping = false
  /** A spacing timer is already armed; see {@link UpdateReconciler.later}. */
  private waiting = false
  private readonly attempts = new Map<string, number>()
  /** machineId → the target version this reconciler drove it to. */
  private readonly converged = new Map<string, string>()

  constructor(private readonly deps: UpdateReconcilerDeps) {}

  /**
   * A daemon reconnected (`machine.connected`). By the time this runs its hello
   * has already been recorded — `recordHelloBuild` precedes `attachDaemon` in
   * the handshake — so the version compared below is the version it just booted
   * with, not the one it had when it went away.
   */
  onMachineConnected(machineId: string): void {
    this.enqueue(machineId)
  }

  /**
   * An exclusive operation reached a terminal state: sweep everyone still
   * behind. This is the line that makes a FAILED operation self-healing — the
   * machines it never reached converge in the background instead of waiting for
   * a human to press Try again (§3.6, plan task 4).
   *
   * EXCEPT A CANCEL, and the exception is the whole reason this takes the
   * outcome rather than nothing. The sweep's licence is decision §9.1: the human
   * decision was made when the operation STARTED, so finishing its remainder in
   * the background needs no second click. A cancel is that decision being
   * withdrawn — sweeping after one would hand out exactly the update the person
   * just stopped, seconds after they stopped it, which is the worst possible
   * moment to be helpful.
   *
   * A later RECONNECT is still converged, and that is not a contradiction: the
   * standing reconciliation is scoped to "any daemon that reconnects behind the
   * current target" (§3.6), not to any one operation. The cancel ended an
   * operation; it did not unpublish the target.
   */
  onOperationSettled(outcome?: string): void {
    if (outcome === 'canceled') return
    for (const machine of this.deps.updates.fleet()) this.enqueue(machine.id)
    this.pump()
  }

  /**
   * An operation is live. Whatever this converged before it started is now that
   * operation's story to tell, so the marks are dropped: `convergedBy` must
   * never label a row the operation is currently driving.
   */
  onOperationStarted(): void {
    this.converged.clear()
  }

  /**
   * Did this reconciler drive this machine to where it is (§3.6 visibility)?
   *
   * Version-checked, not just remembered: a mark for a version that is no longer
   * this machine's target describes a past convergence and must not be shown
   * against the present one.
   *
   * TAKES THE ROW, NOT AN ID, and that is not a convenience. The caller is the
   * fleet read model, which is iterating a projection it has already built; an
   * id would make this look up the fleet AGAIN, once per machine — and
   * `UpdatesService.fleet()` is not a pure read (it continues an authorized wave
   * once a reconnect proves the canary), so a payload of N machines would run
   * that projection N+1 times and drive convergence from a GET.
   */
  convergedBy(machine: WaveMachine): 'reconciler' | undefined {
    const version = this.converged.get(machine.id)
    if (version === undefined) return undefined
    return this.targetFor(machine)?.version === version ? 'reconciler' : undefined
  }

  /** What is waiting to be considered. Tests only — the queue is otherwise private. */
  pending(): string[] {
    return [...this.queue]
  }

  private targetFor(machine: WaveMachine): UpdateTarget | undefined {
    const channel: UpdateChannel = this.deps.updates.channelOf(machine)
    return this.deps.updates.target(channel)
  }

  private enqueue(machineId: string): void {
    if (!this.queued.has(machineId)) {
      this.queued.add(machineId)
      this.queue.push(machineId)
    }
    // Pumped even when it was already waiting: the reason it is still waiting
    // may be exactly the thing that just changed (an operation that ended, a
    // grant that finished), and a queue that only moves on NEW arrivals would
    // strand whoever was already in it.
    this.pump()
  }

  /**
   * ONE MACHINE AT A TIME, GLOBALLY.
   *
   * The loop drains refusals synchronously — a refusal costs nothing and is not
   * worth a timer — and stops the moment it issues a grant. The next
   * consideration is scheduled `spacingMs` later, and if that grant is still in
   * flight then, it waits again. Bounded by construction: the service ages a
   * grant into `stuck` after its own deadline, so an outstanding one cannot
   * hold the queue indefinitely.
   */
  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    let wait = false
    try {
      while (this.queue.length > 0) {
        if (this.outstandingStillRunning()) {
          wait = true
          break
        }
        const machineId = this.queue[0]
        if (machineId === undefined) break
        const disposition = this.consider(machineId)
        // PAUSED LEAVES THE QUEUE STANDING. An operation owns granting while it
        // runs, and everyone waiting is still waiting — draining them here would
        // answer "should this machine converge?" with a fact about the SERVER
        // and then forget the machine ever asked. `onOperationSettled` resumes.
        if (disposition === 'paused') break
        this.queue.shift()
        this.queued.delete(machineId)
        if (disposition === 'granted') {
          wait = true
          break
        }
      }
    } finally {
      // Cleared BEFORE the timer is armed: a caller that injects a synchronous
      // scheduler (a fake clock draining immediately) would otherwise re-enter
      // into its own guard and the queue would stop for good.
      this.pumping = false
    }
    if (wait) this.later()
  }

  /** Is the grant this issued still in flight? Re-read live, never remembered. */
  private outstandingStillRunning(): boolean {
    if (this.outstanding === undefined) return false
    const outstanding = this.outstanding
    const machine = this.deps.updates.fleet().find((candidate) => candidate.id === outstanding)
    if (machine && IN_FLIGHT_STATES.has(machine.state)) return true
    this.outstanding = undefined
    return false
  }

  /**
   * ONE TIMER, NOT ONE PER CALLER. Every reconnect pumps, and a pump that has
   * to wait would otherwise arm its own timer — so a fleet coming back after a
   * power cut would arm one per machine and they would all fire together, which
   * is the burst the spacing exists to prevent.
   */
  private later(): void {
    if (this.waiting) return
    this.waiting = true
    const schedule = this.deps.schedule ?? defaultSchedule
    schedule(() => {
      this.waiting = false
      this.pump()
    }, this.deps.spacingMs ?? DEFAULT_GRANT_SPACING_MS)
  }

  /** Consider one machine. Deliberately does NOT touch the queue — the caller
   *  decides what a disposition means for the machine's place in it. */
  private consider(machineId: string): 'granted' | 'refused' | 'paused' {
    const machine = this.deps.updates.fleet().find((candidate) => candidate.id === machineId)
    const target = machine ? this.targetFor(machine) : undefined
    const key = target ? attemptKey(machineId, target.version) : undefined
    const attempts = key === undefined ? 0 : (this.attempts.get(key) ?? 0)
    const decision = decideReconciliation({
      machine,
      target,
      operationActive: this.deps.operationActive(),
      attempts,
      ...(this.deps.maxAttempts === undefined ? {} : { maxAttempts: this.deps.maxAttempts }),
    })

    if (!decision.converge) {
      if (decision.because === 'operation-active') return 'paused'
      // A machine that arrived where it was going is bookkeeping this no longer
      // owes anything: dropping its counter is what lets a LATER target start
      // from zero even if the version label is one this fleet has seen before.
      if (decision.because === 'at-target' && key !== undefined) this.attempts.delete(key)
      log.debug('reconciler left a machine alone', { machineId, because: decision.because })
      return 'refused'
    }

    const outcome: MachineApplyOutcome = this.deps.updates.authorizeMachine(asMachineId(machineId))
    if (key !== undefined) this.attempts.set(key, attempts + 1)
    if (outcome.result !== 'granted') {
      // `authorizeMachine` re-asks the same questions against the same fleet, so
      // a refusal here is a RACE (the machine dropped between the decision and
      // the grant) rather than a disagreement. Logged, not retried: the next
      // reconnect enqueues it again.
      log.info('reconciler could not grant a reconnected machine', {
        machineId,
        result: outcome.result,
      })
      return 'refused'
    }
    this.outstanding = machineId
    this.converged.set(machineId, outcome.version)
    log.info('reconciler converged a reconnected machine', {
      machineId,
      version: outcome.version,
    })
    return 'granted'
  }
}
