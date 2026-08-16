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
  StepOutcome,
  StepProgressPatch,
} from './kinds'
import type { OperationRow, OperationStore, PersistedOperation } from './store'

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

const isStepFinished = (state: OperationStep['state']): boolean =>
  state === 'done' || state === 'skipped' || state === 'failed'

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

    const plan = await (def.plan as (c: unknown) => Awaited<ReturnType<typeof def.plan>>)(context)

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
      awaiting: plan.awaiting ?? [],
      deferred: plan.deferred ?? [],
      error: null,
    }
    this.deps.store.insert(operation)
    this.contexts.set(operation.id, context)
    this.announce(operation.id)

    await this.drive(operation.id)
    return { started: true, operation: this.require(operation.id) }
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
      if (isStepFinished(next.steps?.find((s) => s.id === stepId)?.state ?? 'running')) {
        await this.driveLocked(operationId)
      } else {
        this.armDeadline(operationId)
      }
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
    const inFlight = (operation.steps ?? []).find(
      (s) => s.state === 'running' || s.state === 'stalled',
    )
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
   */
  async adoptOnBoot(
    realityFor: (row: OperationRow) => unknown | Promise<unknown>,
    contextFor: (row: OperationRow) => unknown = () => undefined,
  ): Promise<Operation[]> {
    const adopted: Operation[] = []
    for (const row of this.deps.store.active()) {
      const def = this.deps.registry.get(row.kind)
      if (!def || !row.operation) {
        adopted.push(this.abandon(row))
        continue
      }

      const context = contextFor(row)
      this.contexts.set(row.id, context)
      const reality = await realityFor(row)
      const reconciled = await (
        def.reconcile as (op: Operation, r: unknown) => Operation | Promise<Operation>
      )(row.operation, reality)

      this.persist(this.persistable(reconciled, def), this.now())
      await this.drive(row.id)
      adopted.push(this.require(row.id))
    }
    return adopted
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

  /** Drops every armed deadline. For shutdown, and for a test that is done. */
  stop(): void {
    for (const handle of this.timers.values()) this.deps.clock.clearTimeout(handle)
    this.timers.clear()
  }

  // ───────────────────────────── driving ──────────────────────────────

  private enqueue(operationId: string, work: () => Promise<void>): Promise<void> {
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
      const operation = this.deps.store.get(operationId)?.operation
      if (!operation || isTerminalOperationState(operation.state)) return

      const def = this.deps.registry.get(operation.kind)
      if (!def) return

      const step = (operation.steps ?? []).find((s) => !isStepFinished(s.state))
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
      const outcome = await this.invoke(runner, started, step.id)

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
      this.disarm(operation.id)
      this.persist(this.persistable(operation, def), at, 'waiting')
      return
    }
    this.finish(this.persistable(operation, def), 'done', at)
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
   */
  private abandon(row: OperationRow): Operation {
    const at = this.now()
    if (row.operation) {
      return this.finish(this.persistable(row.operation), 'failed', at, {
        code: UNKNOWN_KIND_ERROR_CODE,
        message: `This server cannot continue a '${row.kind}' operation.`,
      })
    }
    this.deps.store.markTerminal(row.id, 'failed', at)
    this.disarm(row.id)
    this.announce(row.id)
    return { id: row.id, kind: row.kind, state: 'failed', exclusionGroup: row.exclusionGroup }
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

  /**
   * Fold a patch into one step and hand back the whole operation. Unknown
   * fields on the step and on the operation ride through untouched — the store
   * writes the object back whole, so anything dropped here is dropped for good.
   */
  private applyPatch(
    operation: Operation,
    stepId: string,
    patch: StepProgressPatch,
    at: number,
    extra: (step: OperationStep) => OperationStep = (s) => s,
  ): PersistedOperation {
    const steps = (operation.steps ?? []).map((step) => {
      if (step.id !== stepId) return step
      const merged: OperationStep = extra({
        ...step,
        ...(patch.state ? { state: patch.state } : {}),
        ...(patch.progress ? { progress: patch.progress } : {}),
        ...(patch.places ? { places: patch.places } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        lastProgressAt: at,
      })
      if (isStepFinished(merged.state)) merged.finishedAt = at
      return merged
    })
    return this.persistable({ ...operation, steps }, undefined, at)
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
          void this.enqueue(operationId, () => this.onDeadline(operationId))
        },
        Math.max(0, due - this.now()),
      ),
    )
  }

  /** When this operation's running step next owes an answer, if it owes one at all. */
  private nextDue(operationId: string): number | undefined {
    const operation = this.deps.store.get(operationId)?.operation
    if (!operation || isTerminalOperationState(operation.state)) return undefined
    const def = this.deps.registry.get(operation.kind)
    const step = this.inFlightStep(operation)
    if (!step || !def) return undefined
    const budget = def.deadlines?.[step.id]
    if (!budget) return undefined

    const now = this.now()
    const dues: number[] = []
    if (budget.silenceMs !== undefined) {
      dues.push((step.lastProgressAt ?? step.startedAt ?? now) + budget.silenceMs)
    }
    if (budget.totalMs !== undefined) dues.push((step.startedAt ?? now) + budget.totalMs)
    return dues.length > 0 ? Math.min(...dues) : undefined
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
    const operation = this.deps.store.get(operationId)?.operation
    if (!operation || isTerminalOperationState(operation.state)) return
    const def = this.deps.registry.get(operation.kind)
    const step = this.inFlightStep(operation)
    if (!step || !def) return
    const budget = def.deadlines?.[step.id]
    if (!budget) return

    const now = this.now()
    const silent = now - (step.lastProgressAt ?? step.startedAt ?? now)
    const elapsed = now - (step.startedAt ?? now)
    const overTotal = budget.totalMs !== undefined && elapsed >= budget.totalMs
    const overSilence = budget.silenceMs !== undefined && silent >= budget.silenceMs
    if (!overTotal && !overSilence) {
      // Progress arrived while the timer was in flight — nothing is owed yet.
      this.armDeadline(operationId)
      return
    }

    const stalls = step.stalls ?? 0
    if (overTotal || stalls >= 1) {
      this.fail(operation, step.id, {
        code: STALLED_ERROR_CODE,
        message: overTotal
          ? `This step ran out of time after ${Math.round(elapsed / 1000)}s.`
          : `No progress for ${Math.round(silent / 1000)}s. Podium retried once.`,
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
    if (!runner) return
    const retryAt = this.now()
    const retrying = this.applyPatch(
      this.require(operationId),
      step.id,
      { state: 'running' },
      retryAt,
      (s) => ({ ...s, attempts: (s.attempts ?? 0) + 1 }),
    )
    this.persist(retrying, retryAt)

    const outcome = await this.invoke(runner, retrying, step.id)
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

  private inFlightStep(operation: Operation): OperationStep | undefined {
    return (operation.steps ?? []).find((s) => s.state === 'running' || s.state === 'stalled')
  }

  /**
   * Put back the three facts the store requires, without inventing any. An
   * operation that reached the store once already carries them; a reconciled
   * one may have been rebuilt by a kind that dropped them.
   */
  private persistable(
    operation: Operation,
    def?: AnyOperationKindDefinition,
    at?: number,
  ): PersistedOperation {
    const now = at ?? this.now()
    return {
      ...operation,
      exclusionGroup:
        operation.exclusionGroup ??
        def?.exclusionGroup ??
        this.deps.registry.get(operation.kind)?.exclusionGroup ??
        operation.kind,
      createdAt: operation.createdAt ?? now,
      updatedAt: now,
    }
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
