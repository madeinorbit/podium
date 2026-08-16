import { randomUUID } from 'node:crypto'
import {
  isTerminalOperationState,
  type Operation,
  type OperationError,
  type OperationStep,
} from '@podium/protocol'
import type {
  AnyOperationKindDefinition,
  OperationKindRegistry,
  OperationPlan,
  StepDeadlines,
  StepOutcome,
  StepProgressPatch,
} from './kinds'
import type { OperationRow, OperationStore, PersistedOperation } from './store'
import {
  applyStepPatch,
  deadlineBreach,
  deadlineDue,
  inFlightStep,
  isStepFinished,
  nextStep,
  withPersistenceFacts,
} from './transitions'

/**
 * THE ENGINE (POD-2097, spec §3.2–§3.4) — the generic half of every long-running
 * lifecycle process Podium runs. It owns identity, single-flight, sequencing,
 * liveness and adoption; it owns no knowledge whatsoever of what a step does.
 *
 * Three properties are worth stating outright, because each is a fix for a
 * named defect in today's updater:
 *
 *  - **Timer-driven, not poll-driven.** A deadline fires because time passed,
 *    not because someone read a status endpoint. Today's grant deadline only
 *    ages when `fleet()` is called, so nobody watching means nothing expiring.
 *  - **Persisted before anything observable happens.** The process being
 *    updated includes this one. Every transition is written before it is
 *    announced, so the successor can adopt it (P3).
 *  - **Reality over memory.** A runner's job is `ensure()`, and adoption asks
 *    the kind to re-derive the operation from observable facts rather than
 *    trusting what the dead process believed.
 */

/** An opaque timer handle — the fake clock in tests hands back whatever it likes. */
export type OperationTimerHandle = unknown

export interface OperationClock {
  now(): number
  setTimeout(fn: () => void, ms: number): OperationTimerHandle
  clearTimeout(handle: OperationTimerHandle): void
}

/** Production wiring, one line, at the composition root. */
export const systemOperationClock: OperationClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    // A pending deadline must not be the reason the process stays alive.
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface OperationEngineDeps {
  store: OperationStore
  registry: OperationKindRegistry
  clock: OperationClock
  /** Injectable so a test can name its operations; production mints `op_<uuid>`. */
  newId?: () => string
  /** Called after every persisted transition, for whoever pushes state to clients. */
  onChanged?: (row: OperationRow) => void
}

export type StartResult =
  | { started: true; operation: Operation }
  | { started: false; alreadyRunning: string }
  | { started: false; refused: 'unknown-kind' }

export type CancelResult =
  | { canceled: true; operation: Operation }
  | { canceled: false; refused: 'not-found' | 'already-finished' | 'irreversible'; step?: string }

/** The one error code the framework itself contributes to the taxonomy (§7). */
export const STALLED_ERROR_CODE = 'stalled'
/** An operation whose kind this binary does not register — see {@link OperationEngine.adoptOnBoot}. */
export const UNKNOWN_KIND_ERROR_CODE = 'unknown-operation-kind'
/** Adoption asked the kind to re-derive an operation and the kind threw (POD-2147). */
export const ADOPTION_FAILED_ERROR_CODE = 'operation-adoption-failed'
/** The engine's own loop threw while advancing an operation nobody is awaiting (POD-2151). */
export const DRIVE_FAILED_ERROR_CODE = 'operation-drive-failed'

/**
 * How long a `waiting` operation is held open for asks only a surface can
 * satisfy, before it completes anyway (§3.5, POD-2149).
 *
 * The spec asks for "a short grace" and its state diagram names `expired` as an
 * exit; what it does NOT say is a number, because the right one is a property of
 * the ask. Ten minutes is the framework's answer for a kind that names none:
 * comfortably longer than a desktop app takes to download, install and come
 * back, and far shorter than the failure this bounds — a laptop whose lid stays
 * shut holding the `lifecycle` group, and with it every future update, until
 * someone finds the machine.
 *
 * Expiry completes the operation rather than failing it: the shared steps all
 * succeeded, and the ask that went unanswered stays listed in `awaiting` as the
 * honest record of what did not happen.
 */
export const DEFAULT_WAITING_GRACE_MS = 10 * 60_000

/** `ensure()` outstayed its step's budget — see `invokeWithin`. */
const OVERDUE = Symbol('operation-step-overdue')

export class OperationEngine {
  private readonly deps: OperationEngineDeps
  /** One deadline timer per operation — §3.3's "a single scheduler". */
  private readonly timers = new Map<string, OperationTimerHandle>()
  /** Per-operation promise chain: progress and driving must never interleave. */
  private readonly chains = new Map<string, Promise<void>>()
  /**
   * The kind's context, held for as long as this process drives the operation.
   * It is NOT persisted and must not be: a context is live plumbing (services,
   * handles), and the successor process assembles its own in `adoptOnBoot`.
   */
  private readonly contexts = new Map<string, unknown>()
  /**
   * The timers `invokeWithin` arms. They belong to a CALL rather than to an
   * operation, so the per-operation map cannot hold them and `stop()` could not
   * see them (POD-2148).
   */
  private readonly budgetTimers = new Set<OperationTimerHandle>()
  /** Set by `stop()`. The store is about to close, so nothing may write again. */
  private stopped = false

  constructor(deps: OperationEngineDeps) {
    this.deps = deps
  }

  /**
   * Create and begin one operation of `kind`, or say who is already holding the
   * group (P6). The caller gets an id either way, so a second tab renders the
   * same operation instead of being told "no".
   *
   * SINGLE-FLIGHT'S ONLY WINDOW is `plan()`, which is async. So the group is
   * checked again in the same synchronous block as the insert, and that block
   * contains no `await` — which is the whole of the guarantee, on a server that
   * is the single writer of this table. The alternative, a partial unique index
   * over the live states, would bake the state list into the schema of the OLD
   * binary and make a predecessor refuse a successor's writes.
   */
  async start(
    kind: string,
    context?: unknown,
    opts: { createdBy?: string } = {},
  ): Promise<StartResult> {
    const def = this.deps.registry.get(kind)
    if (!def) return { started: false, refused: 'unknown-kind' }

    const held = this.deps.store.activeByGroup(def.exclusionGroup)
    if (held) return { started: false, alreadyRunning: held.id }

    const plan = await (def.plan as (c: unknown) => OperationPlan | Promise<OperationPlan>)(context)

    const contended = this.deps.store.activeByGroup(def.exclusionGroup)
    if (contended) return { started: false, alreadyRunning: contended.id }

    const at = this.now()
    const operation: PersistedOperation = {
      id: this.mintId(),
      kind: def.kind,
      exclusionGroup: def.exclusionGroup,
      state: 'running',
      createdBy: opts.createdBy,
      createdAt: at,
      startedAt: at,
      updatedAt: at,
      steps: plan.steps.map((step) => ({ ...step, state: step.state ?? 'pending' })),
      details: plan.details,
      ...(plan.retryOf ? { retryOf: plan.retryOf } : {}),
      awaiting: plan.awaiting ?? [],
      deferred: plan.deferred ?? [],
      error: null,
    }
    this.deps.store.insert(operation)
    this.contexts.set(operation.id, context)
    this.announce(operation.id)

    // START CREATES THE OPERATION; IT DOES NOT RUN IT TO COMPLETION. The caller
    // is a button press, and what it needs back is an identity to render — the
    // operation object is the source of truth from here on (P2). Awaiting the
    // drive would tie the response time of `start` to the behaviour of the
    // first runner, which is how today's updater ends up holding a spinner for
    // five silent minutes; a runner that wedges must cost the operation its
    // deadline, never the click its answer.
    //
    // NOT AWAITING IT MEANS NOBODY IS WATCHING IT, so the throw has to be
    // caught here — see `containDriveFailure` (POD-2151).
    void this.drive(operation.id).catch((err) => this.containDriveFailure(operation.id, err))
    return { started: true, operation }
  }

  /**
   * Accept a progress report for a step: stamp the heartbeat, persist, and — if
   * the report finished the step — carry on with the plan.
   *
   * This is also how a step that went `stalled` comes back: progress arriving
   * for a stalled step returns it to `running` and leaves the stall counted,
   * because "it hung for two minutes and then recovered" is a fact about the
   * update the user lived through (§3.3).
   */
  async recordProgress(
    operationId: string,
    stepId: string,
    patch: StepProgressPatch,
  ): Promise<void> {
    await this.enqueue(operationId, async () => {
      const operation = this.deps.store.get(operationId)?.operation
      if (!operation || isTerminalOperationState(operation.state)) return
      const step = (operation.steps ?? []).find((s) => s.id === stepId)
      if (!step || isStepFinished(step.state)) return

      const at = this.now()
      const next = this.applyPatch(
        operation,
        stepId,
        { ...patch, state: patch.state ?? 'running' },
        at,
        (s) => ({ ...s, startedAt: s.startedAt ?? at }),
      )
      this.persist(next, at)

      const reported = next.steps?.find((s) => s.id === stepId)?.state ?? 'running'
      if (reported === 'failed') {
        // A failure REPORTED is a failure, exactly as one RETURNED by `ensure()`
        // is. Falling through to `driveLocked` here would be worse than losing
        // the report: `isStepFinished` counts a failed step as finished, so the
        // plan would step over it and the operation could reach `done` with a
        // failed step in its own step list.
        this.fail(next, stepId, patch.error ?? { code: 'step-failed' })
        return
      }
      if (isStepFinished(reported)) {
        await this.driveLocked(operationId)
        return
      }
      this.armDeadline(operationId)
    })
  }

  /**
   * A DEFERRED PLACE BECAME REACHABLE while the step that would have carried it
   * is still running (spec §3.6, POD-2105).
   *
   * `deferred` is the operation's honest note about places it is NOT waiting for
   * — "2 machines will follow when they reconnect". One of them arriving before
   * the step finished is the one case where that note stops being true, and it
   * has to stop being true ATOMICALLY: a place that is in neither list is
   * invisible, and a place that is in both is counted twice by anyone reading
   * the operation. So the removal and the step patch are one chained unit here
   * rather than two calls a reader has to know are related.
   *
   * Generic on purpose. The engine does not learn what a machine is; it learns
   * that a deferred place can join a running step, which is a fact about the
   * shape of an operation and will read the same for a server move.
   *
   * The report is always `running`: admission ADDS work, so it can never be the
   * thing that finishes a step, and forcing it here means this can never take
   * the plan-advancing path that `recordProgress` owns.
   */
  async admitDeferred(
    operationId: string,
    stepId: string,
    placeIds: readonly string[],
    patch: StepProgressPatch,
  ): Promise<void> {
    await this.enqueue(operationId, async () => {
      const operation = this.deps.store.get(operationId)?.operation
      if (!operation || isTerminalOperationState(operation.state)) return
      const step = (operation.steps ?? []).find((s) => s.id === stepId)
      if (!step || isStepFinished(step.state)) return
      const admitting = new Set(placeIds)
      const before = operation.deferred ?? []
      const deferred = before.filter((place) => !admitting.has(place.id))
      if (deferred.length === before.length) return

      const at = this.now()
      const next = this.applyPatch(
        { ...operation, deferred },
        stepId,
        { ...patch, state: 'running' },
        at,
      )
      this.persist(next, at)
      this.armDeadline(operationId)
    })
  }

  /**
   * §3.2: cancel is allowed only while the step in flight declares itself
   * reversible. Everything else gets a typed refusal rather than an exception,
   * because "this can't be canceled now, it will finish or fail" is a sentence
   * the panel has to be able to say.
   */
  cancel(operationId: string): CancelResult {
    const row = this.deps.store.get(operationId)
    if (!row) return { canceled: false, refused: 'not-found' }
    if (isTerminalOperationState(row.state)) return { canceled: false, refused: 'already-finished' }
    const operation = row.operation
    // Unreadable bytes cannot be shown to be safe, and cancel is the one verb
    // that must never proceed on an assumption.
    if (!operation) return { canceled: false, refused: 'irreversible' }

    const def = this.deps.registry.get(operation.kind)
    const inFlight = inFlightStep(operation)
    if (inFlight && def?.runners[inFlight.id]?.reversible !== true) {
      return { canceled: false, refused: 'irreversible', step: inFlight.id }
    }

    const canceled = this.finish(this.persistable(operation), 'canceled', this.now())
    return { canceled: true, operation: canceled }
  }

  /**
   * ADOPTION (§3.4). For every live operation: ask its kind to re-derive it from
   * observable facts, persist that, then resume driving from the reconciled
   * state. Memory is never trusted over facts, because the memory belonged to a
   * process that no longer exists.
   *
   * An operation this binary cannot drive — an unregistered kind, or a payload
   * it cannot parse — is FAILED here rather than left alone. Leaving it would
   * wedge its exclusion group forever behind something nothing will ever
   * advance, and a downgrade that quietly disables updating is worse than one
   * that says so.
   *
   * NOTHING A KIND DOES HERE MAY REACH THE CALLER (POD-2147). `startServer`
   * awaits this before it binds, so an exception escaping the loop would abort
   * startup — on the server that has to apply the update that fixes it — and
   * strand every operation behind the one that threw. A kind that cannot
   * re-derive its operation gets exactly the policy an unknown kind already
   * gets: the operation is failed, the group is freed, boot carries on.
   */
  async adoptOnBoot(
    realityFor: (row: OperationRow) => unknown | Promise<unknown>,
    contextFor: (row: OperationRow) => unknown = () => undefined,
  ): Promise<Operation[]> {
    const adopted: Operation[] = []
    let live: OperationRow[]
    try {
      live = this.deps.store.active()
    } catch {
      // Even the SWEEP is inside the guarantee. If the store cannot list its
      // live rows there is nothing to adopt and nothing that could be recorded
      // — and the one thing that must not happen is the caller, which is
      // `startServer` before it binds, learning about it by rejecting.
      return adopted
    }
    for (const row of live) {
      const outcome = await this.adoptRow(row, realityFor, contextFor).catch((err) =>
        this.abandonSafely(row, {
          code: ADOPTION_FAILED_ERROR_CODE,
          message: `This server could not resume a '${row.kind}' operation.`,
          detail: err instanceof Error ? err.message : String(err),
        }),
      )
      if (outcome) adopted.push(outcome)
    }
    return adopted
  }

  /** One row's adoption. Every throw it can produce is caught by its caller. */
  private async adoptRow(
    row: OperationRow,
    realityFor: (row: OperationRow) => unknown | Promise<unknown>,
    contextFor: (row: OperationRow) => unknown,
  ): Promise<Operation> {
    const def = this.deps.registry.get(row.kind)
    if (!def || !row.operation) return this.abandon(row)

    this.contexts.set(row.id, contextFor(row))
    const reality = await realityFor(row)
    const reconciled = await (
      def.reconcile as (op: Operation, r: unknown) => Operation | Promise<Operation>
    )(row.operation, reality)

    const adoptedOperation = this.persist(
      this.persistable(this.resumeStalled(reconciled), def),
      this.now(),
    )
    await this.drive(row.id)
    // THE ROW MAY LEGITIMATELY BE GONE. Driving it to an outcome sweeps its
    // kind's retention, and an operation older than the newest twenty finished
    // ones is deleted by its own completion — so requiring it here turned a
    // successful adoption into a thrown boot (POD-2147).
    return this.deps.store.get(row.id)?.operation ?? adoptedOperation
  }

  /**
   * Bring a step the dead process left `stalled` back to `running` (POD-2145).
   *
   * `driveLocked` leaves a stalled step alone because it is "waiting on its own
   * retry or its deadline, not on us". That is true inside one process and
   * false across a restart: the retry belonged to the process that died, and
   * adoption arms no timer. The step is then waiting on a retry that will never
   * be issued and a deadline that was never armed — and `activeByGroup` keeps
   * answering with it, so the exclusion group is held for as long as the row
   * exists. For the `update` kind that means Podium can no longer update
   * itself, on the machine whose updater is the broken thing, repairable only
   * by hand-editing the database. The window is not exotic: the plan contains a
   * step that restarts this server, between the `stalled` write and the retry.
   *
   * THE STALL ITSELF IS KEPT. A restart does not buy a fresh budget — the step
   * has used its one stall and the next silence still fails it (§3.3).
   *
   * Applied AFTER `reconcile`, so a kind that consulted reality and concluded
   * the step is finished wins over this.
   */
  private resumeStalled(operation: Operation): Operation {
    const steps = operation.steps ?? []
    if (!steps.some((s) => s.state === 'stalled')) return operation
    return {
      ...operation,
      steps: steps.map((s) => (s.state === 'stalled' ? { ...s, state: 'running' as const } : s)),
    }
  }

  /**
   * Satisfy a surface-scoped ask (§3.5). Without this, `waiting` would have no
   * exit at all — a state nothing can leave is not a state, it is a wedge.
   */
  async settleAsk(operationId: string, askId: string): Promise<void> {
    await this.enqueue(operationId, async () => {
      const operation = this.deps.store.get(operationId)?.operation
      if (!operation || isTerminalOperationState(operation.state)) return
      this.persist(
        this.persistable({
          ...operation,
          awaiting: (operation.awaiting ?? []).filter((ask) => ask.id !== askId),
        }),
        this.now(),
      )
      await this.driveLocked(operationId)
    })
  }

  active(group?: string): OperationRow | undefined {
    if (group !== undefined) return this.deps.store.activeByGroup(group)
    return this.deps.store.active()[0]
  }

  /**
   * IS THIS STILL THE STEP THE ENGINE IS WATCHING? (POD-2173.)
   *
   * A runner that hands work off leaves something behind to watch it, and that
   * watcher outlives the call that made it — by design, since the point is to
   * report news arriving after `ensure()` returned. What it must not outlive is
   * the step. `recordProgress` already refuses a report for a finished step or a
   * terminal operation, so a stale watcher is silent; being silent is not the
   * same as being STOPPED, and a `web` watcher whose step ran out of time went
   * on reading a digest off disk twice a second for the life of the process.
   *
   * The engine is the only thing that knows the answer — the timers belong to
   * the kind, so `stop()` cannot sweep them — so it has to be askable. It is a
   * read, not a lock: a watcher may still be mid-tick when this turns false, and
   * the report it sends is dropped exactly as before.
   */
  watching(operationId: string, stepId: string): boolean {
    const operation = this.deps.store.get(operationId)?.operation
    if (!operation || isTerminalOperationState(operation.state)) return false
    return inFlightStep(operation)?.id === stepId
  }

  history(kind?: string, limit?: number): OperationRow[] {
    return this.deps.store.history(kind, limit)
  }

  /**
   * Resolve once everything queued for this operation has run.
   *
   * A deadline fires into the queue and nobody awaits it — that is what makes
   * it timer-driven. So quiescing has to be askable: shutdown wants it before
   * closing the database, and a test wants it instead of a sleep, which this
   * repo's unit lane rightly treats as a bug. It loops because the work it
   * waits on may enqueue more.
   */
  async whenSettled(operationId: string): Promise<void> {
    for (let guard = 0; guard < 100; guard++) {
      const chain = this.chains.get(operationId)
      if (!chain) return
      await chain.catch(() => undefined)
      if (this.chains.get(operationId) === chain) return
    }
  }

  /**
   * SHUT THE ENGINE DOWN. For shutdown, and for a test that is done.
   *
   * This is a fence, not a timer sweep, and both halves of that were live
   * defects (POD-2148). Clearing the deadline map misses `invokeWithin`'s
   * budget timer, which is armed per CALL rather than per operation; and a
   * drive that nobody awaits can be sitting on a pending `ensure()` that
   * resolves after `store.close()`. Either one wakes into a closed database,
   * and the resulting throw is swallowed by the chain, so nobody ever learns.
   *
   * So after this: every timer is dropped, `enqueue` refuses new work, and
   * every loop that is mid-await returns instead of persisting. Operations are
   * durable, so nothing is lost — the successor adopts them and re-derives from
   * reality, which is the stronger answer anyway.
   */
  stop(): void {
    this.stopped = true
    for (const handle of this.timers.values()) this.deps.clock.clearTimeout(handle)
    this.timers.clear()
    for (const handle of this.budgetTimers) this.deps.clock.clearTimeout(handle)
    this.budgetTimers.clear()
  }

  // ───────────────────────────── driving ──────────────────────────────

  private enqueue(operationId: string, work: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const previous = this.chains.get(operationId) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.chains.set(
      operationId,
      next.catch(() => undefined),
    )
    return next
  }

  private drive(operationId: string): Promise<void> {
    return this.enqueue(operationId, () => this.driveLocked(operationId))
  }

  /**
   * Run the plan forward until it blocks or ends. Sequential by construction:
   * the user is shown "step 2 of 4", so two steps running at once would make
   * that sentence false.
   *
   * Callers must already hold the operation's chain.
   */
  private async driveLocked(operationId: string): Promise<void> {
    for (;;) {
      if (this.stopped) return
      const operation = this.deps.store.get(operationId)?.operation
      if (!operation || isTerminalOperationState(operation.state)) return

      const def = this.deps.registry.get(operation.kind)
      if (!def) return

      const step = nextStep(operation)
      if (!step) {
        this.settle(operation, def)
        return
      }
      // A stalled step is waiting on its own retry or its deadline, not on us.
      if (step.state === 'stalled') return

      const runner = def.runners[step.id]
      if (!runner) {
        this.fail(operation, step.id, {
          code: 'no-runner',
          message: `The '${operation.kind}' operation has no runner for step '${step.id}'.`,
        })
        return
      }

      const started = this.beginStep(operation, step.id)
      const outcome = await this.invokeWithin(runner, started, step.id, def.deadlines?.[step.id])
      // The runner may have answered on the far side of a shutdown (POD-2148).
      if (this.stopped) return
      if (outcome === OVERDUE) {
        await this.onDeadline(operationId)
        return
      }

      const current = this.deps.store.get(operationId)?.operation
      if (!current || isTerminalOperationState(current.state)) return
      const at = this.now()
      const next = this.applyPatch(current, step.id, outcome, at)
      this.persist(next, at)

      if (outcome.state === 'running') {
        this.armDeadline(operationId)
        return
      }
      if (outcome.state === 'failed') {
        this.fail(next, step.id, outcome.error ?? { code: 'step-failed' })
        return
      }
    }
  }

  /**
   * Run `ensure()`, but never for longer than the step's own budget.
   *
   * A RUNNER THAT NEVER RETURNS IS THE HANG THIS FRAMEWORK EXISTS TO END. The
   * deadline timer cannot save us from it on its own: the timer callback goes
   * through this operation's serial queue, and a pending `ensure()` is holding
   * that queue — so arming a timer before the await would produce a deadline
   * that fires into a lane it cannot enter. Racing here is what makes the
   * budget real, whatever the runner does.
   *
   * The losing `ensure()` is simply dropped. It cannot reject (see below), and
   * whatever it eventually answers is stale by definition — the step it was
   * answering about has since been stalled, retried or failed, and `ensure()`
   * is idempotent by contract, so nothing is owed to a call we stopped waiting
   * for.
   *
   * A CONSEQUENCE WORTH NAMING for anyone writing a runner: `ensure()` must not
   * await `recordProgress` for its own operation. That call queues behind the
   * very work it is being called from, which is a deadlock the budget would
   * merely convert into a stall. Report progress from wherever the news
   * actually arrives — a daemon frame, a watcher — after returning `running`.
   */
  private async invokeWithin(
    runner: { ensure: AnyOperationKindDefinition['runners'][string]['ensure'] },
    operation: Operation,
    stepId: string,
    budget: StepDeadlines | undefined,
  ): Promise<StepOutcome | typeof OVERDUE> {
    const ensure = this.invoke(runner, operation, stepId)
    const step = (operation.steps ?? []).find((s) => s.id === stepId)
    const due = step ? deadlineDue(step, budget, this.now()) : undefined
    if (due === undefined) return ensure

    return new Promise<StepOutcome | typeof OVERDUE>((resolve) => {
      let settled = false
      const timer = this.deps.clock.setTimeout(
        () => {
          this.budgetTimers.delete(timer)
          if (settled) return
          settled = true
          resolve(OVERDUE)
        },
        Math.max(0, due - this.now()),
      )
      // Registered so `stop()` can drop it (POD-2148): this timer is keyed to a
      // call, not to an operation, so `this.timers` could never hold it.
      this.budgetTimers.add(timer)
      void ensure.then((outcome) => {
        if (settled) return
        settled = true
        this.deps.clock.clearTimeout(timer)
        this.budgetTimers.delete(timer)
        resolve(outcome)
      })
    })
  }

  /** `ensure()` throwing is a failed step, not a crashed server. */
  private async invoke(
    runner: { ensure: AnyOperationKindDefinition['runners'][string]['ensure'] },
    operation: Operation,
    stepId: string,
  ): Promise<StepOutcome> {
    const step = (operation.steps ?? []).find((s) => s.id === stepId) as OperationStep
    try {
      return await runner.ensure({
        operation,
        step,
        context: this.contexts.get(operation.id) as never,
      })
    } catch (err) {
      return {
        state: 'failed',
        error: {
          code: 'step-threw',
          message: `The '${stepId}' step could not be completed.`,
          detail: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  /** Mark a step running and count the attempt, before anything is attempted. */
  private beginStep(operation: Operation, stepId: string): Operation {
    const at = this.now()
    const next = this.applyPatch(operation, stepId, { state: 'running' }, at, (step) => ({
      ...step,
      startedAt: step.startedAt ?? at,
      attempts: (step.attempts ?? 0) + 1,
    }))
    this.persist(next, at)
    return next
  }

  // ─────────────────────────── transitions ────────────────────────────

  /**
   * Every step is finished, so the operation is too — unless something only a
   * surface can do is still outstanding and gates correctness (§3.5). Voluntary
   * asks do not hold it open; stragglers self-serve on their next load.
   */
  private settle(operation: Operation, def: AnyOperationKindDefinition): void {
    const blocking = (operation.awaiting ?? []).filter((ask) => ask.required === true)
    const at = this.now()
    if (blocking.length > 0) {
      this.persist(this.persistable(operation, def), at, 'waiting')
      this.armWaitingGrace(operation.id, def)
      return
    }
    this.finish(this.persistable(operation, def), 'done', at)
  }

  /**
   * §3.5's "completes after a short grace", which had never been built
   * (POD-2149). The only exits from `waiting` were `settleAsk` and `cancel`,
   * and the panel that would offer the second does not ship yet — so an ask
   * nobody could answer, a laptop whose lid stays shut, held the exclusion
   * group and every future operation in it for as long as the machine slept.
   * The framework exists to end silent unbounded waits; this was one, wearing a
   * different state name.
   *
   * The grace takes over the operation's single timer rather than needing a
   * second one, which is sound because a `waiting` operation has no step in
   * flight to be judged: every step is finished, or `settle` was not reached.
   */
  private armWaitingGrace(operationId: string, def: AnyOperationKindDefinition): void {
    this.disarm(operationId)
    const grace = def.waitingGraceMs ?? DEFAULT_WAITING_GRACE_MS
    this.timers.set(
      operationId,
      this.deps.clock.setTimeout(
        () => {
          void this.enqueue(operationId, async () => {
            this.expireWaiting(operationId)
          }).catch((err) => this.containDriveFailure(operationId, err))
        },
        Math.max(0, grace),
      ),
    )
  }

  /**
   * The grace ran out. The shared steps all succeeded, so the operation is
   * `done` — the spec's diagram points "asks satisfied" and "expired" at the
   * same place. `awaiting` is left exactly as it stands: completing is not the
   * same as pretending the ask was answered, and a surface reading the finished
   * operation can still say which one went unanswered.
   */
  private expireWaiting(operationId: string): void {
    const operation = this.deps.store.get(operationId)?.operation
    if (operation?.state !== 'waiting') return
    this.finish(this.persistable(operation), 'done', this.now())
  }

  private fail(operation: Operation, stepId: string, error: OperationError): void {
    const at = this.now()
    const marked = this.applyPatch(operation, stepId, { state: 'failed', error }, at)
    this.finish(marked, 'failed', at, error)
  }

  private finish(
    operation: PersistedOperation,
    state: 'done' | 'failed' | 'canceled',
    at: number,
    error?: OperationError,
  ): Operation {
    const finished: PersistedOperation = {
      ...operation,
      state,
      updatedAt: at,
      finishedAt: at,
      error: error ?? operation.error ?? null,
    }
    this.deps.store.update(finished)
    this.disarm(finished.id)
    this.contexts.delete(finished.id)
    this.deps.store.sweepRetention(finished.kind)
    this.announce(finished.id)
    return finished
  }

  /**
   * The row this binary cannot drive (see `adoptOnBoot`): the outcome goes onto
   * the columns and the payload is left exactly as its writer left it.
   *
   * `error` names WHY when the caller knows something more specific than "this
   * kind is not registered" — an adoption that threw, a drive that could not
   * continue. The policy is identical in every case, which is the point: it was
   * already the right one and was simply unreachable from a throw.
   */
  private abandon(row: OperationRow, error?: OperationError): Operation {
    const at = this.now()
    const outcome = error ?? {
      code: UNKNOWN_KIND_ERROR_CODE,
      message: `This server cannot continue a '${row.kind}' operation.`,
    }
    if (row.operation) {
      return this.finish(this.persistable(row.operation), 'failed', at, outcome)
    }
    this.deps.store.markTerminal(row.id, 'failed', at)
    this.disarm(row.id)
    this.announce(row.id)
    return { id: row.id, kind: row.kind, state: 'failed', exclusionGroup: row.exclusionGroup }
  }

  /**
   * Record an outcome, and never throw doing it: the reason we are here may be
   * that the store is the broken thing, and a second throw out of the recovery
   * path is exactly how a contained failure becomes an uncontained one.
   */
  private abandonSafely(row: OperationRow, error: OperationError): Operation | undefined {
    try {
      return this.abandon(row, error)
    } catch {
      return undefined
    }
  }

  /**
   * A drive nobody is awaiting threw (POD-2151).
   *
   * `start()` does not await the drive — a click must not be held hostage to a
   * runner — and a deadline fires into the queue with nobody watching either.
   * Without this, the chain's blanket `.catch` swallows the throw and leaves
   * the operation `running` with no timer, no error and no announcement: the
   * caller was told it started, and it never advances again. Its exclusion
   * group goes with it.
   *
   * `invoke()` already turns a throwing `ensure()` into a failed step, so what
   * reaches here is the engine's own loop failing — a store write that did not
   * land, an invariant that did not hold. Failing the operation with that on
   * the record is both the honest answer and the one that frees the group.
   */
  private containDriveFailure(operationId: string, err: unknown): void {
    // Mid-shutdown, a write is the hazard rather than the repair.
    if (this.stopped) return
    try {
      const row = this.deps.store.get(operationId)
      if (!row || isTerminalOperationState(row.state)) return
      this.abandonSafely(row, {
        code: DRIVE_FAILED_ERROR_CODE,
        message: 'Podium could not continue this operation.',
        detail: err instanceof Error ? err.message : String(err),
      })
    } catch {
      // The store itself is gone. Nothing can be recorded, and a throw from
      // here would be the unhandled rejection this exists to prevent.
    }
  }

  private persist(
    operation: PersistedOperation,
    at: number,
    state?: Operation['state'],
  ): Operation {
    const next: PersistedOperation = { ...operation, updatedAt: at, ...(state ? { state } : {}) }
    this.deps.store.update(next)
    this.announce(next.id)
    return next
  }

  /** `transitions.applyStepPatch`, plus the facts the store needs to write it. */
  private applyPatch(
    operation: Operation,
    stepId: string,
    patch: StepProgressPatch,
    at: number,
    extra?: (step: OperationStep) => OperationStep,
  ): PersistedOperation {
    return this.persistable(applyStepPatch(operation, stepId, patch, at, extra), undefined, at)
  }

  // ───────────────────────────── deadlines ────────────────────────────

  /**
   * Arm the one timer this operation gets, for whichever of its deadlines
   * expires first. Re-armed on every accepted progress report, which is what
   * makes silence — rather than slowness — the thing that fires.
   */
  private armDeadline(operationId: string): void {
    this.disarm(operationId)
    const due = this.nextDue(operationId)
    if (due === undefined) return
    this.timers.set(
      operationId,
      this.deps.clock.setTimeout(
        () => {
          // A deadline is the other drive site nobody awaits (POD-2151).
          void this.enqueue(operationId, () => this.onDeadline(operationId)).catch((err) =>
            this.containDriveFailure(operationId, err),
          )
        },
        Math.max(0, due - this.now()),
      ),
    )
  }

  /** When this operation's running step next owes an answer, if it owes one at all. */
  private nextDue(operationId: string): number | undefined {
    const watched = this.watched(operationId)
    if (!watched) return undefined
    return deadlineDue(watched.step, watched.budget, this.now())
  }

  /**
   * The step a timer is about, with the budget it is judged against — the four
   * refusals every deadline path shares, resolved once.
   */
  private watched(operationId: string):
    | {
        operation: Operation
        def: AnyOperationKindDefinition
        step: OperationStep
        budget: StepDeadlines
      }
    | undefined {
    const operation = this.deps.store.get(operationId)?.operation
    if (!operation || isTerminalOperationState(operation.state)) return undefined
    const def = this.deps.registry.get(operation.kind)
    const step = inFlightStep(operation)
    if (!step || !def) return undefined
    const budget = def.deadlines?.[step.id]
    if (!budget) return undefined
    return { operation, def, step, budget }
  }

  private disarm(operationId: string): void {
    const handle = this.timers.get(operationId)
    if (handle !== undefined) this.deps.clock.clearTimeout(handle)
    this.timers.delete(operationId)
  }

  /**
   * A deadline came due (P4). Silence gets ONE retry, because the common cause
   * is a lost message and `ensure()` is idempotent by contract. The total
   * budget gets none: a step that has already overrun its whole allowance is
   * not going to be rescued by starting it again.
   */
  private async onDeadline(operationId: string): Promise<void> {
    const watched = this.watched(operationId)
    if (!watched) return
    const { operation, def, step, budget } = watched

    const now = this.now()
    const breach = deadlineBreach(step, budget, now)
    if (breach.kind === 'none') {
      // Progress arrived while the timer was in flight — nothing is owed yet.
      this.armDeadline(operationId)
      return
    }

    const stalls = step.stalls ?? 0
    if (breach.kind === 'total' || stalls >= 1) {
      this.fail(operation, step.id, {
        code: STALLED_ERROR_CODE,
        message:
          breach.kind === 'total'
            ? `This step ran out of time after ${Math.round(breach.elapsedMs / 1000)}s.`
            : `No progress for ${Math.round(breach.silentMs / 1000)}s. Podium retried once.`,
      })
      return
    }

    // Stalled, and VISIBLY so, before anything is retried: the panel renders
    // "no progress for N s" from this state rather than from a guess, and the
    // heartbeat is deliberately not refreshed by our noticing.
    this.persist(
      this.applyPatch(operation, step.id, { state: 'stalled' }, now, (s) => ({
        ...s,
        stalls: stalls + 1,
        lastProgressAt: step.lastProgressAt,
      })),
      now,
    )

    const runner = def.runners[step.id]
    if (!runner) {
      // The answer `driveLocked` gives in the identical situation (POD-2145).
      // Returning here left the step stalled with no timer and no retry — the
      // same wedge as the adoption case, reached by a second route.
      this.fail(this.require(operationId), step.id, {
        code: 'no-runner',
        message: `The '${operation.kind}' operation has no runner for step '${step.id}'.`,
      })
      return
    }
    const retryAt = this.now()
    const retrying = this.applyPatch(
      this.require(operationId),
      step.id,
      { state: 'running' },
      retryAt,
      (s) => ({ ...s, attempts: (s.attempts ?? 0) + 1 }),
    )
    this.persist(retrying, retryAt)

    // Bounded exactly as the first attempt was: a retry that hangs is the same
    // hang, and this one has already used the step's one stall.
    const outcome = await this.invokeWithin(runner, retrying, step.id, budget)
    if (this.stopped) return
    if (outcome === OVERDUE) {
      await this.onDeadline(operationId)
      return
    }
    const after = this.deps.store.get(operationId)?.operation
    if (!after || isTerminalOperationState(after.state)) return
    const at = this.now()
    const next = this.applyPatch(after, step.id, outcome, at)
    this.persist(next, at)

    if (outcome.state === 'failed') {
      this.fail(next, step.id, outcome.error ?? { code: 'step-failed' })
      return
    }
    if (outcome.state === 'running') {
      this.armDeadline(operationId)
      return
    }
    await this.driveLocked(operationId)
  }

  // ────────────────────────────── helpers ─────────────────────────────

  /** `transitions.withPersistenceFacts`, with the group resolved from the registry. */
  private persistable(
    operation: Operation,
    def?: AnyOperationKindDefinition,
    at?: number,
  ): PersistedOperation {
    const group = def?.exclusionGroup ?? this.deps.registry.get(operation.kind)?.exclusionGroup
    return withPersistenceFacts(operation, group, at ?? this.now())
  }

  private require(operationId: string): Operation {
    const operation = this.deps.store.get(operationId)?.operation
    if (!operation) throw new Error(`operation ${operationId} vanished mid-flight`)
    return operation
  }

  private announce(operationId: string): void {
    const row = this.deps.store.get(operationId)
    if (row) this.deps.onChanged?.(row)
  }

  private now(): number {
    return this.deps.clock.now()
  }

  private mintId(): string {
    return this.deps.newId ? this.deps.newId() : `op_${randomUUID()}`
  }
}
