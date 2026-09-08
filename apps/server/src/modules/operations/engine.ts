import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createLogger } from '@podium/logger'
import {
  isTerminalOperationState,
  type Operation,
  type OperationError,
  type OperationStep,
} from '@podium/protocol'
import type { CommandPrincipal } from '../../command-principal'
import type {
  AdoptionDeferred,
  AnyOperationKindDefinition,
  CancelCleanupResult,
  HandoffSealPatch,
  OperationKindRegistry,
  OperationActionResult,
  OperationPlan,
  StepDeadlines,
  StepOutcome,
  StepProgressPatch,
} from './kinds'
import { ADOPTION_DEFERRED } from './kinds'
import type { OperationRow, OperationStore, PersistedOperation } from './store'
import {
  applyStepPatch,
  deadlineBreach,
  deadlineDue,
  inFlightStep,
  isStepFinished,
  nextStep,
  restartPlaceClocks,
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

/**
 * THE ENGINE'S OWN NARRATION (POD-3224).
 *
 * This class had no logging at all, which made the durable operation — the one
 * story the update was supposed to have — the least observable part of it. The
 * row in the database says where an operation ENDED UP; only a log can say when
 * each step was entered, how many times, what the runner answered, which
 * deadline fired, and what a successor concluded when it adopted the thing.
 * Reconstructing an update's timeline meant diffing successive payload rows.
 *
 * Levels follow the same rule as everywhere else in this issue: a TRANSITION is
 * `info` and is bounded by the plan (a whole update is on the order of a dozen),
 * a re-entry or a progress report is `debug` because a wave reports per machine
 * per tick, and a stall, a failure or an abandonment is `warn`/`error`.
 *
 * `server:operations` rather than `server:updates`, because the engine is
 * generic: the next kind registered against it gets this for free, and an
 * operator narrowing to one namespace should get the framework or the update,
 * not both at once.
 */
const log = createLogger('server:operations')

/** Enough of an operation to identify it in a log line, and never more. */
function operationFields(operation: Operation): Record<string, unknown> {
  return {
    operationId: operation.id,
    kind: operation.kind,
    state: operation.state,
  }
}

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
  onChanged?: (row: OperationRow, previousState: string | undefined) => void | Promise<void>
}

export type StartResult =
  | { started: true; operation: Operation }
  | { started: false; alreadyRunning: string }
  | { started: false; refused: 'unknown-kind' }

export type CancelResult =
  | { canceled: true; operation: Operation }
  | {
      canceled: false
      refused: 'not-found' | 'already-finished' | 'irreversible' | 'handed-off'
      step?: string
    }

export type ActionDispatchResult =
  | { handled: true; result: OperationActionResult }
  | {
      handled: false
      refused: 'not-found' | 'already-finished' | 'not-offered' | 'unsupported'
    }

/** The one error code the framework itself contributes to the taxonomy (§7). */
export const STALLED_ERROR_CODE = 'stalled'
/** An operation whose kind this binary does not register — see {@link OperationEngine.adoptOnBoot}. */
export const UNKNOWN_KIND_ERROR_CODE = 'unknown-operation-kind'
/** Adoption asked the kind to re-derive an operation and the kind threw (POD-2147). */
export const ADOPTION_FAILED_ERROR_CODE = 'operation-adoption-failed'
/** The engine's own loop threw while advancing an operation nobody is awaiting (POD-2151). */
export const DRIVE_FAILED_ERROR_CODE = 'operation-drive-failed'
/** A runner claimed successor ownership without first sealing the durable row. */
export const HANDOFF_UNSEALED_ERROR_CODE = 'handoff-unsealed'
/** Cleanup gets a real deadline even when a kind does not name one. */
export const DEFAULT_CANCEL_DEADLINE_MS = 60_000

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

type HandoffState = {
  stepId: string
  phase: 'sealed' | 'reclaiming' | 'handed-off'
}

type RunnerIdentity = {
  operationId: string
  stepId: string
  token: symbol
}

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
  private readonly budgetTimers = new Map<OperationTimerHandle, string>()
  /** A seal belongs to this process; persisted handoff bytes remain adoptable elsewhere. */
  private readonly handoffs = new Map<string, HandoffState>()
  /** Only the runner currently inside ensure may seal or reclaim its row. */
  private readonly activeRunners = new Map<string, symbol>()
  private readonly runnerScope = new AsyncLocalStorage<RunnerIdentity>()
  /** Concurrent callers share one cleanup run and one terminal result. */
  private readonly cancelRuns = new Map<string, Promise<CancelResult>>()
  /** Live rows whose successor reality exists but is not final enough to persist. */
  private readonly deferredAdoptions = new Set<string>()
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
   * claimGroup() enforces single-flight with a conditional insert. The read
   * below only saves planning for an already-busy group. A post-plan re-check
   * followed by an awaited insert is unsafe: both starts can pass the check
   * before either inserts (POD-3524, spec rule 54).
   */
  async start(
    kind: string,
    context?: unknown,
    opts: { createdBy?: string } = {},
  ): Promise<StartResult> {
    const def = this.deps.registry.get(kind)
    if (!def) {
      log.warn('refused to start an operation of an unregistered kind', { kind })
      return { started: false, refused: 'unknown-kind' }
    }

    // THE FAST PATH, not the guarantee — see above. A group that is already busy
    // when the click arrives is answered without planning at all.
    const held = await this.deps.store.activeByGroup(def.exclusionGroup)
    if (held) {
      // SINGLE-FLIGHT ANSWERED, not a failure. A second surface pressing the
      // button lands here, and telling that apart from a start that did nothing
      // is exactly what the client could not do (POD-3224).
      log.info('an operation of this group is already running', {
        kind,
        group: def.exclusionGroup,
        operationId: held.id,
        ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
      })
      return { started: false, alreadyRunning: held.id }
    }

    const plan = await (def.plan as (c: unknown) => OperationPlan | Promise<OperationPlan>)(context)

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
    const claim = await this.deps.store.claimGroup(operation)
    if (!claim.claimed) {
      // Another start took the group while this one was planning. It is the
      // WRITE that found out, which is the point: this branch is reached
      // because the row was refused, not because a read said so.
      log.info('another operation took this group while the plan was being made', {
        kind,
        group: def.exclusionGroup,
        operationId: claim.heldBy.id,
      })
      return { started: false, alreadyRunning: claim.heldBy.id }
    }
    this.contexts.set(operation.id, context)
    /**
     * THE PLAN, IN FULL, AT THE MOMENT IT WAS MADE.
     *
     * Everything downstream is a consequence of this: which steps exist, which
     * places are in the wave, which are `deferred` and WHY, and which asks are
     * outstanding. The plan is a pure function of facts that have since moved
     * on, so an hour later this line is the only way to know what the server
     * believed when it decided.
     */
    log.info('operation created', {
      ...operationFields(operation),
      group: def.exclusionGroup,
      ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
      ...(plan.retryOf ? { retryOf: plan.retryOf } : {}),
      steps: operation.steps?.map((step) => step.id).join(',') ?? '',
      places: Object.fromEntries(
        (operation.steps ?? [])
          .filter((step) => step.places && step.places.length > 0)
          .map((step) => [step.id, step.places?.map((place) => place.id).join(',')]),
      ),
      awaiting: (operation.awaiting ?? []).map(
        (ask) => `${ask.id}${ask.required === true ? '!' : ''}@${ask.surface ?? '-'}`,
      ),
      deferred: (operation.deferred ?? []).map(
        (place) => `${place.id}:${place.reason ?? 'unstated'}`,
      ),
    })
    await this.announce(operation.id, undefined)

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
    void this.drive(operation.id).catch(
      async (err) => await this.containDriveFailure(operation.id, err),
    )
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
    if (this.isSealed(operationId)) return
    await this.enqueue(operationId, async () => {
      if (this.isSealed(operationId)) return
      const operation = (await this.deps.store.get(operationId))?.operation
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
      await this.persist(next, at)

      const reported = next.steps?.find((s) => s.id === stepId)?.state ?? 'running'
      // `debug`: a machine wave reports per machine per tick, and this is the
      // one call in the class whose volume is set by the fleet rather than by
      // the plan. The step ENTRY and the step OUTCOME are the `info` lines.
      log.debug('operation step progress reported', {
        ...operationFields(next),
        step: stepId,
        reported,
        ...(patch.progress ? { progress: patch.progress } : {}),
        ...(patch.detail ? { detail: patch.detail } : {}),
      })
      if (reported === 'failed') {
        // A failure REPORTED is a failure, exactly as one RETURNED by `ensure()`
        // is. Falling through to `driveLocked` here would be worse than losing
        // the report: `isStepFinished` counts a failed step as finished, so the
        // plan would step over it and the operation could reach `done` with a
        // failed step in its own step list.
        await this.fail(next, stepId, patch.error ?? { code: 'step-failed' })
        return
      }
      if (isStepFinished(reported)) {
        await this.driveLocked(operationId)
        return
      }
      await this.armDeadline(operationId)
    })
  }

  /**
   * Persist kind-owned facts that must survive before a runner triggers an
   * external boundary — for a caller that does NOT already hold the chain.
   *
   * `drive`/`driveLocked` split for the same reason, and this one earned it the
   * hard way. The body below is a read-modify-write of the WHOLE operation:
   * `OperationStore.update` has no field-wise form by contract, so a merge of
   * `details` necessarily writes back every step as it stood at the read. While
   * the store was synchronous that read and that write were one uninterruptible
   * span. They are not any more, and the fleet bridge — the one caller here with
   * no chain under it — used the gap to write a pre-stall step list back over a
   * stall the deadline had just recorded, losing both the `stalled` state and
   * the stall count. Queueing puts the read and the write on the same side of
   * every other writer, which is what made it safe before.
   */
  async recordDetails(
    operationId: string,
    patch: Record<string, unknown>,
  ): Promise<Operation | undefined> {
    if (this.isSealed(operationId)) return undefined
    let recorded: Operation | undefined
    await this.enqueue(operationId, async () => {
      recorded = await this.recordDetailsLocked(operationId, patch)
    })
    return recorded
  }

  /**
   * `recordDetails` for a caller that ALREADY holds the operation's chain — a
   * step runner, which is invoked from inside it.
   *
   * Such a caller must NOT queue: it would be waiting for itself. It also does
   * not need to, which is the whole point of holding the chain — no other writer
   * can land between this read and this write. The update server step uses it
   * between publishing its database snapshot and requesting the process restart,
   * and awaits it, because the path has to be durable before this process can be
   * told to go away.
   */
  async recordDetailsLocked(
    operationId: string,
    patch: Record<string, unknown>,
  ): Promise<Operation | undefined> {
    const operation = (await this.deps.store.get(operationId))?.operation
    if (!operation || isTerminalOperationState(operation.state)) return undefined
    const details: Record<string, unknown> =
      operation.details && typeof operation.details === 'object'
        ? (operation.details as Record<string, unknown>)
        : {}
    return await this.persist(
      {
        ...operation,
        details: { ...details, ...patch },
      } as PersistedOperation,
      this.now(),
    )
  }

  /**
   * Persist the last source-owned row before an irreversible coordinator handoff.
   * The sealing step remains running and all successors remain pending.
   */
  async sealForHandoff(
    operationId: string,
    stepId: string,
    patch: HandoffSealPatch = {},
  ): Promise<Operation> {
    if (this.stopped) throw new Error('the operations engine is stopped')
    if (this.handoffs.has(operationId)) throw new Error('operation is already sealed')
    const runner = this.runnerScope.getStore()
    if (
      !runner ||
      runner.operationId !== operationId ||
      runner.stepId !== stepId ||
      this.activeRunners.get(operationId) !== runner.token
    ) {
      throw new Error('handoff may only be sealed by the active runner')
    }

    const operation = await this.require(operationId)
    const steps = operation.steps ?? []
    const index = steps.findIndex((step) => step.id === stepId)
    if (index < 0 || inFlightStep(operation)?.id !== stepId) {
      throw new Error('handoff may only seal the step in flight')
    }
    if (patch.step?.state === 'done') {
      throw new Error('the sealing step must remain running')
    }
    if (steps.slice(index + 1).some((step) => step.state !== 'pending')) {
      throw new Error('handoff successor steps must remain pending')
    }

    const at = this.now()
    const details: Record<string, unknown> =
      operation.details && typeof operation.details === 'object'
        ? (operation.details as Record<string, unknown>)
        : {}
    const withStep = this.applyPatch(operation, stepId, { ...patch.step, state: 'running' }, at)
    const sealed: PersistedOperation = {
      ...withStep,
      details: {
        ...details,
        ...patch.detailsPatch,
        _handoff: { stepId, sealedAt: at },
      },
      updatedAt: at,
    }

    // No callback is allowed between the durable write and the in-memory seal.
    const previousState = (await this.deps.store.get(operationId))?.state
    await this.deps.store.update(sealed)
    this.handoffs.set(operationId, { stepId, phase: 'sealed' })
    this.disarm(operationId)
    this.disarmBudgets(operationId)
    await this.announce(operationId, previousState)
    return sealed
  }

  /**
   * Re-open exactly the terminal failure write after kind cleanup proved that
   * no successor-activating message could have been sent.
   */
  reclaimHandoff(operationId: string): void {
    const handoff = this.handoffs.get(operationId)
    if (!handoff || handoff.phase !== 'sealed') {
      throw new Error('operation has no reclaimable handoff')
    }
    const runner = this.runnerScope.getStore()
    if (
      !runner ||
      runner.operationId !== operationId ||
      runner.stepId !== handoff.stepId ||
      this.activeRunners.get(operationId) !== runner.token
    ) {
      throw new Error('handoff may only be reclaimed by its sealing runner')
    }
    handoff.phase = 'reclaiming'
  }

  /** True only for this process's sealed source row. */
  isSealed(operationId: string): boolean {
    return this.handoffs.has(operationId)
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
   *
   * AND THEN IT DRIVES, exactly as {@link OperationEngine.settleAsk} does
   * (POD-2187). Admitting work and not re-entering the runner was a step that
   * had grown a place nothing would ever act on: the runner is the only thing
   * that hands out work, a running step is otherwise only ever WATCHED, and the
   * newly admitted place arrives `pending` — so it cannot even trigger the
   * offline→online re-entry, which keys on a place that was `offline` in the
   * previous projection and this one was in no projection at all. The step then
   * sat until its whole silence budget ran out, showed the operator a stalled
   * step for ten minutes for no reason, and spent the operation's ONE permitted
   * stall, so the next genuine silence failed the update outright instead of
   * retrying it. Adding work is precisely a change in what the step could do,
   * which is the one thing `reensure` exists to say.
   */
  async admitDeferred(
    operationId: string,
    stepId: string,
    placeIds: readonly string[],
    patch: StepProgressPatch,
  ): Promise<void> {
    if (this.isSealed(operationId)) return
    await this.enqueue(operationId, async () => {
      if (this.isSealed(operationId)) return
      const operation = (await this.deps.store.get(operationId))?.operation
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
      await this.persist(next, at)
      await this.driveLocked(operationId)
    })
  }

  /**
   * THE NOTE ABOUT PLACES THIS OPERATION IS NOT WAITING FOR CHANGED (POD-3040).
   *
   * `deferred` is a claim with a shelf life — "2 machines will follow when they
   * reconnect" is true only while what they would follow still exists. When the
   * kind decides it no longer does, the note has to be restated rather than
   * left standing, because a stale reassurance is worse than none: the operator
   * reads it as work still on its way.
   *
   * Generic, like {@link OperationEngine.admitDeferred}: the engine learns that
   * a deferred place's reason changed, never what the reason means. It does NOT
   * drive — restating a note adds no work to any step, so there is nothing for
   * a runner to do about it.
   *
   * AND IT WRITES TO A FINISHED OPERATION, which is the one place this engine
   * does. That is not an exception grudgingly made; it is what `deferred` IS.
   * Every other field records what HAPPENED, and history may not be edited. A
   * deferred place records what is still GOING to happen — "2 machines will
   * update when they reconnect" — and an operation reaching `done` is precisely
   * what does not settle that sentence: §3.6's whole point is that the
   * operation finishes without them. The commonest shape is a fleet whose
   * behind machines were ALL asleep, which plans no wave at all, is terminal
   * within a tick, and leaves the promise standing for days.
   *
   * So the state, the steps and the outcome of a finished operation are copied
   * through untouched and only the promise is corrected. Nothing reanimates: no
   * runner is entered, no deadline armed, and `history` orders by `createdAt`,
   * so a restated row does not jump the list either.
   */
  async recordDeferred(
    operationId: string,
    deferred: readonly { id: string; name?: string; reason?: string }[],
  ): Promise<void> {
    await this.enqueue(operationId, async () => {
      const operation = (await this.deps.store.get(operationId))?.operation
      if (!operation) return
      await this.persist(
        { ...operation, deferred: [...deferred] } as PersistedOperation,
        this.now(),
      )
    })
  }

  /**
   * SOMETHING OUTSIDE THE OPERATION CHANGED WHAT THIS STEP COULD DO (POD-2167).
   *
   * `ensure()` is idempotent and reality-first, so running it again is always
   * safe — but until now nothing could ask for it. A running step was driven
   * once and then only ever WATCHED: reports could move it along and a deadline
   * could give up on it, and there was no third thing.
   *
   * That hole is a real wedge on the path §3.4 calls normal. `adoptOnBoot` is
   * awaited before the daemon gateway listens, so a successor resuming a machine
   * wave runs `ensure()` against a fleet that is entirely offline, grants nobody,
   * and answers `running`. The daemons reconnect seconds later — and every one of
   * those events reached a bridge that could record progress and re-arm a
   * deadline, but could not say "try again now". The wave sat at zero grants
   * until its ten-minute silence budget stalled it, and the STALL RETRY issued
   * the first grant. An update resumed but not restarted.
   *
   * The patch is applied first so the re-entered runner sees the news that
   * prompted the call. Deliberately narrow: it refuses unless `stepId` is the
   * step actually in flight and running, so it can neither jump the plan nor
   * disturb a step that is stalled and already owed a retry.
   */
  async reensure(operationId: string, stepId: string, patch?: StepProgressPatch): Promise<void> {
    if (this.isSealed(operationId)) return
    await this.enqueue(operationId, async () => {
      if (this.isSealed(operationId)) return
      const operation = (await this.deps.store.get(operationId))?.operation
      if (!operation || isTerminalOperationState(operation.state)) return
      const step = inFlightStep(operation)
      if (!step || step.id !== stepId || step.state !== 'running') return
      if (patch) {
        const at = this.now()
        await this.persist(
          this.applyPatch(operation, stepId, { ...patch, state: 'running' }, at),
          at,
        )
      }
      await this.driveLocked(operationId)
    })
  }

  /**
   * §3.2: cancel is allowed only while the step in flight declares itself
   * reversible. Everything else gets a typed refusal rather than an exception,
   * because "this can't be canceled now, it will finish or fail" is a sentence
   * the panel has to be able to say.
   */
  async cancel(operationId: string): Promise<CancelResult> {
    if (this.isSealed(operationId)) return { canceled: false, refused: 'handed-off' }
    const existing = this.cancelRuns.get(operationId)
    if (existing) return existing

    const run = this.enqueueResult(operationId, () => this.cancelLocked(operationId))
    this.cancelRuns.set(operationId, run)
    void run.then(
      () => {
        if (this.cancelRuns.get(operationId) === run) this.cancelRuns.delete(operationId)
      },
      () => {
        if (this.cancelRuns.get(operationId) === run) this.cancelRuns.delete(operationId)
      },
    )
    return run
  }

  private async cancelLocked(operationId: string): Promise<CancelResult> {
    const refuse = (refused: CancelResult & { canceled: false }): CancelResult => {
      log.info('cancel refused', {
        operationId,
        refused: refused.refused,
        ...(refused.step ? { step: refused.step } : {}),
      })
      return refused
    }
    if (this.isSealed(operationId)) return refuse({ canceled: false, refused: 'handed-off' })
    const row = await this.deps.store.get(operationId)
    if (!row) return refuse({ canceled: false, refused: 'not-found' })
    if (isTerminalOperationState(row.state)) {
      return refuse({ canceled: false, refused: 'already-finished' })
    }
    const operation = row.operation
    if (!operation) return refuse({ canceled: false, refused: 'irreversible' })

    const def = this.deps.registry.get(operation.kind)
    const currentStep = inFlightStep(operation)
    if (currentStep && def?.runners[currentStep.id]?.reversible !== true) {
      return refuse({ canceled: false, refused: 'irreversible', step: currentStep.id })
    }
    log.info('operation canceled', {
      ...operationFields(operation),
      ...(currentStep ? { step: currentStep.id } : {}),
    })

    const at = this.now()
    let canceling = this.persistable(operation, def)
    if (currentStep) {
      canceling = this.applyPatch(canceling, currentStep.id, { detail: 'canceling' }, at)
      await this.persist(canceling, at)
    }

    let cleanup: CancelCleanupResult = { cleanup: 'complete' }
    let cleanupError: string | undefined
    if (def?.onCancel) {
      try {
        cleanup = await this.invokeCancelWithin(
          () =>
            def.onCancel!({
              operation: canceling,
              step: currentStep,
              context: this.contexts.get(operationId) as never,
            }),
          operationId,
          def.deadlines?.['#cancel']?.totalMs ?? DEFAULT_CANCEL_DEADLINE_MS,
        )
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error)
        cleanup = {
          cleanup: 'pending',
          pending: [{ what: 'operation cleanup', retryable: true }],
        }
      }
    }

    const finishedAt = this.now()
    let canceled = canceling
    for (const [stepId, patch] of Object.entries(cleanup.stepPatches ?? {})) {
      canceled = this.applyPatch(canceled, stepId, patch, finishedAt)
    }
    const details = canceled.details && typeof canceled.details === 'object' ? canceled.details : {}
    canceled = {
      ...canceled,
      details: {
        ...details,
        ...cleanup.detailsPatch,
        cleanup: {
          status: cleanup.cleanup,
          ...(cleanup.pending ? { pending: cleanup.pending } : {}),
          ...(cleanupError ? { error: cleanupError } : {}),
        },
      },
    }
    return {
      canceled: true,
      operation: await this.finish(await this.persistable(canceled, def), 'canceled', finishedAt),
    }
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
    contextFor: (row: OperationRow) => unknown | Promise<unknown> = () => undefined,
  ): Promise<Operation[]> {
    const adopted: Operation[] = []
    let live: OperationRow[]
    try {
      live = await this.deps.store.active()
    } catch {
      // Even the SWEEP is inside the guarantee. If the store cannot list its
      // live rows there is nothing to adopt and nothing that could be recorded
      // — and the one thing that must not happen is the caller, which is
      // `startServer` before it binds, learning about it by rejecting.
      return adopted
    }
    for (const row of live) {
      const outcome = await this.adoptRow(row, realityFor, contextFor).catch(
        async (err) =>
          await this.abandonSafely(row, {
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
    contextFor: (row: OperationRow) => unknown | Promise<unknown>,
  ): Promise<Operation> {
    const def = this.deps.registry.get(row.kind)
    if (!def || !row.operation) return await this.abandon(row)

    // AWAITED. Assembling an adopted operation's context is a durable read now
    // (the host's own update channel), and storing the promise instead would
    // hand every step runner a `Promise` where it expects the context — with no
    // type error, because the map holds `unknown`.
    this.contexts.set(row.id, await contextFor(row))
    const reality = await realityFor(row)
    const reconciled = await (
      def.reconcile as (
        operation: Operation,
        observed: unknown,
      ) => Operation | AdoptionDeferred | Promise<Operation | AdoptionDeferred>
    )(row.operation, reality)
    if (reconciled === ADOPTION_DEFERRED) {
      this.deferredAdoptions.add(row.id)
      return row.operation
    }
    this.deferredAdoptions.delete(row.id)

    /**
     * WHAT THE SUCCESSOR INHERITED, AND WHAT IT CONCLUDED (POD-3224).
     *
     * Adoption is the moment the update's story crosses a process boundary, and
     * it is where the previous process's beliefs are thrown away in favour of
     * observable facts. Both sides are logged — the state and steps as the dead
     * process left them, and the state and steps the kind re-derived — because
     * "the successor adopted it and it was already done" and "the successor
     * adopted it and started the wave again" are the two outcomes an operator
     * most needs to tell apart, and the row afterwards shows only the second.
     *
     * `reality` itself is NOT logged: it is the kind's own shape, it can be
     * large, and the kind is the party that knows how to describe it.
     */
    const stepStates = (operation: Operation): string =>
      (operation.steps ?? []).map((step) => `${step.id}=${step.state}`).join(' ')
    log.info('operation adopted on boot', {
      operationId: row.id,
      kind: row.kind,
      was: row.operation.state,
      wasSteps: stepStates(row.operation),
      now: reconciled.state,
      nowSteps: stepStates(reconciled),
      resumedStalled: (reconciled.steps ?? []).some((step) => step.state === 'stalled'),
    })

    const adoptedOperation = await this.persist(
      this.persistable(this.resumeStalled(reconciled), def),
      this.now(),
    )
    await this.drive(row.id)
    // THE ROW MAY LEGITIMATELY BE GONE. Driving it to an outcome sweeps its
    // kind's retention, and an operation older than the newest twenty finished
    // ones is deleted by its own completion — so requiring it here turned a
    // successful adoption into a thrown boot (POD-2147).
    return (await this.deps.store.get(row.id))?.operation ?? adoptedOperation
  }

  /**
   * Retry exactly one adoption the engine previously deferred. Another
   * deferred verdict is a strict no-op; a final verdict is persisted before
   * any runner can observe it.
   */
  async resumeDeferredAdoption(
    operationId: string,
    reality: unknown,
  ): Promise<Operation | undefined> {
    return this.enqueueResult(operationId, async () => {
      if (!this.deferredAdoptions.has(operationId)) return undefined
      const row = (await this.deps.store.get(operationId))
      if (!row?.operation || isTerminalOperationState(row.state)) return row?.operation ?? undefined
      const def = this.deps.registry.get(row.kind)
      if (!def) return undefined

      const reconciled = await (
        def.reconcile as (
          operation: Operation,
          observed: unknown,
        ) => Operation | AdoptionDeferred | Promise<Operation | AdoptionDeferred>
      )(row.operation, reality)
      if (reconciled === ADOPTION_DEFERRED) return row.operation
      this.deferredAdoptions.delete(operationId)
      const persisted = this.persist(
        this.persistable(this.resumeStalled(reconciled), def),
        this.now(),
      )
      if (!isTerminalOperationState((await persisted).state)) await this.driveLocked(operationId)
      return (await this.deps.store.get(operationId))?.operation ?? persisted
    })
  }

  isAdoptionDeferred(operationId: string): boolean {
    return this.deferredAdoptions.has(operationId)
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
    if (this.isSealed(operationId)) return
    await this.enqueue(operationId, async () => {
      if (this.isSealed(operationId)) return
      const operation = (await this.deps.store.get(operationId))?.operation
      if (!operation || isTerminalOperationState(operation.state)) return
      await this.persist(
        this.persistable({
          ...operation,
          awaiting: (operation.awaiting ?? []).filter((ask) => ask.id !== askId),
        }),
        this.now(),
      )
      await this.driveLocked(operationId)
    })
  }

  async active(group?: string): Promise<OperationRow | undefined> {
    if (group !== undefined) return await this.deps.store.activeByGroup(group)
    return (await this.deps.store.active())[0]
  }

  async get(operationId: string): Promise<OperationRow | undefined> {
    return (await this.deps.store.get(operationId))
  }

  async project(row: OperationRow): Promise<Operation | null> {
    const operation = row.operation
    if (!operation) return null
    const def = this.deps.registry.get(operation.kind)
    // NO PROJECTION TO APPLY: serve the STORED BYTES, not the reparse.
    //
    // `row.operation` has been through parseOperation, which drops any field
    // this binary does not know about. That is the wrong answer for the endpoint
    // this feeds: the web bundle is swapped during the very operation it renders,
    // so the two ends are guaranteed to be different builds, and a newer server's
    // field has to survive the round trip (P8). Our side served
    // JSON.parse(row.payload) directly; dev/mw introduced this projection and
    // served its parsed result. The merge took the projection and lost the
    // byte-preservation, so keep both: raw bytes when nothing projects, the
    // projected operation when something does.
    if (!def?.projectSealed || !this.hasPersistedHandoff(operation)) {
      try {
        return JSON.parse(row.payload) as Operation
      } catch {
        return operation
      }
    }
    const handoff = this.handoffs.get(operation.id)
    return def.projectSealed(operation, {
      inFlightDrive: handoff?.phase === 'sealed' || handoff?.phase === 'reclaiming',
    })
  }

  async dispatchAction(
    operationId: string,
    actionId: string,
    principal: CommandPrincipal,
    options: { settleAsk: boolean },
  ): Promise<ActionDispatchResult> {
    const row = (await this.deps.store.get(operationId))
    if (!row?.operation) return { handled: false, refused: 'not-found' }
    if (isTerminalOperationState(row.state)) {
      return { handled: false, refused: 'already-finished' }
    }

    const sealed = this.isSealed(operationId) || this.hasPersistedHandoff(row.operation)
    if (sealed) {
      const operation = await this.project(row)
      if (!operation || !this.actionOffered(operation, actionId)) {
        return { handled: false, refused: 'not-offered' }
      }
      const def = this.deps.registry.get(operation.kind)
      if (!def?.onAction) return { handled: false, refused: 'unsupported' }
      const result = await def.onAction({
        operation,
        actionId,
        principal,
        mode: 'sealed',
      })
      return { handled: true, result }
    }

    return this.enqueueResult(operationId, async () => {
      const current = (await this.deps.store.get(operationId))
      if (!current?.operation) return { handled: false, refused: 'not-found' }
      if (isTerminalOperationState(current.state)) {
        return { handled: false, refused: 'already-finished' }
      }
      if (!this.actionOffered(current.operation, actionId)) {
        return { handled: false, refused: 'not-offered' }
      }
      const def = this.deps.registry.get(current.operation.kind)
      if (!def) return { handled: false, refused: 'unsupported' }
      if (!def.onAction && !options.settleAsk) {
        return { handled: false, refused: 'unsupported' }
      }
      const result = def.onAction
        ? await def.onAction({
            operation: current.operation,
            actionId,
            principal,
            mode: 'engine',
          })
        : { settled: true }
      if (options.settleAsk) {
        // AWAITED before the drive below: this removes the settled ask from
        // the operation, and driveLocked re-reads the row. Dropped, the drive
        // could still see the ask it was told had been settled.
        await this.persist(
          this.persistable({
            ...current.operation,
            awaiting: (current.operation.awaiting ?? []).filter((ask) => ask.id !== actionId),
          }),
          this.now(),
        )
        await this.driveLocked(operationId)
      }
      return { handled: true, result }
    })
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
  async watching(operationId: string, stepId: string): Promise<boolean> {
    if (this.isSealed(operationId)) return false
    const operation = (await this.deps.store.get(operationId))?.operation
    if (!operation || isTerminalOperationState(operation.state)) return false
    return inFlightStep(operation)?.id === stepId
  }

  async history(kind?: string, limit?: number): Promise<OperationRow[]> {
    return await this.deps.store.history(kind, limit)
  }

  async retryPendingCleanup(
    contextFor: (row: OperationRow) => unknown | Promise<unknown> = () => undefined,
  ): Promise<number> {
    let completed = 0
    for (const pending of await this.deps.store.pendingCleanup()) {
      completed += await this.enqueueResult(pending.id, async () => {
        const row = (await this.deps.store.get(pending.id))
        const operation = row?.operation
        if (!row || !operation || !isTerminalOperationState(row.state)) return 0
        const def = this.deps.registry.get(operation.kind)
        if (!def?.onCancel) return 0

        const step = inFlightStep(operation)
        let result: CancelCleanupResult
        let cleanupError: string | undefined
        try {
          const context = await contextFor(row)
          result = await this.invokeCancelWithin(
            () =>
              def.onCancel!({
                operation,
                step,
                context: context as never,
              }),
            operation.id,
            def.deadlines?.['#cancel']?.totalMs ?? DEFAULT_CANCEL_DEADLINE_MS,
          )
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : String(error)
          result = {
            cleanup: 'pending',
            pending: [{ what: 'operation cleanup', retryable: true }],
          }
        }

        const at = this.now()
        let updated = this.persistable(operation, def, at)
        for (const [stepId, patch] of Object.entries(result.stepPatches ?? {})) {
          updated = this.applyPatch(updated, stepId, patch, at)
        }
        const details =
          updated.details && typeof updated.details === 'object' ? updated.details : {}
        updated = {
          ...updated,
          details: {
            ...details,
            ...result.detailsPatch,
            cleanup: {
              status: result.cleanup,
              ...(result.pending ? { pending: result.pending } : {}),
              ...(cleanupError ? { error: cleanupError } : {}),
            },
          },
        }
        const previousState = (await this.deps.store.get(updated.id))?.state
        await this.deps.store.update(updated)
        await this.announce(updated.id, previousState)
        return result.cleanup === 'complete' ? 1 : 0
      })
    }
    return completed
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
    for (const handle of this.budgetTimers.keys()) this.deps.clock.clearTimeout(handle)
    this.budgetTimers.clear()
    this.activeRunners.clear()
  }

  // ───────────────────────────── driving ──────────────────────────────

  private enqueueResult<T>(operationId: string, work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('the operations engine is stopped'))
    const previous = this.chains.get(operationId) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.chains.set(
      operationId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  private enqueue(operationId: string, work: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.enqueueResult(operationId, work)
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
      if (this.stopped || this.isSealed(operationId)) return
      const operation = (await this.deps.store.get(operationId))?.operation
      if (!operation || isTerminalOperationState(operation.state)) return

      const def = this.deps.registry.get(operation.kind)
      if (!def) return

      const step = nextStep(operation)
      if (!step) {
        await this.settle(operation, def)
        return
      }
      // A stalled step is waiting on its own retry or its deadline, not on us.
      if (step.state === 'stalled') return

      const runner = def.runners[step.id]
      if (!runner) {
        await this.fail(operation, step.id, {
          code: 'no-runner',
          message: `The '${operation.kind}' operation has no runner for step '${step.id}'.`,
        })
        return
      }

      const started = await this.beginStep(operation, step.id)
      const outcome = await this.invokeWithin(runner, started, step.id, def.deadlines?.[step.id])
      // The runner may have answered on the far side of a shutdown (POD-2148).
      if (this.stopped) return
      if (outcome === OVERDUE) {
        await this.onDeadline(operationId)
        return
      }

      const current = (await this.deps.store.get(operationId))?.operation
      if (!current || isTerminalOperationState(current.state)) return
      if (outcome.state === 'handed-off') {
        await this.completeHandoff(current, step.id)
        return
      }
      const handoff = this.handoffs.get(operationId)
      if (handoff?.phase === 'reclaiming') {
        if (outcome.state !== 'failed') {
          throw new Error('a reclaimed handoff runner must return failed')
        }
        await this.finishReclaimed(current, step.id, outcome.error ?? { code: 'step-failed' })
        return
      }
      if (handoff) return

      const at = this.now()
      const patch: StepProgressPatch = { ...outcome, state: outcome.state }
      const next = this.applyPatch(current, step.id, patch, at)
      await this.persist(next, at)

      if (outcome.state === 'running') {
        await this.armDeadline(operationId)
        return
      }
      if (outcome.state === 'failed') {
        await this.fail(next, step.id, outcome.error ?? { code: 'step-failed' })
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
    if (this.isSealed(operation.id)) return ensure
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
          this.activeRunners.delete(operation.id)
          resolve(OVERDUE)
        },
        Math.max(0, due - this.now()),
      )
      // Registered so `stop()` can drop it (POD-2148): this timer is keyed to a
      // call, not to an operation, so `this.timers` could never hold it.
      this.budgetTimers.set(timer, operation.id)
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
    const token = Symbol(stepId)
    const identity: RunnerIdentity = { operationId: operation.id, stepId, token }
    this.activeRunners.set(operation.id, token)
    try {
      return await this.runnerScope.run(identity, () =>
        runner.ensure({
          operation,
          step,
          context: this.contexts.get(operation.id) as never,
        }),
      )
    } catch (err) {
      log.error('an operation step runner threw', {
        ...operationFields(operation),
        step: stepId,
        err,
      })
      return {
        state: 'failed',
        error: {
          code: 'step-threw',
          message: `The '${stepId}' step could not be completed.`,
          detail: err instanceof Error ? err.message : String(err),
        },
      }
    } finally {
      if (this.activeRunners.get(operation.id) === token) {
        this.activeRunners.delete(operation.id)
      }
    }
  }

  /** Mark a step running and count the attempt, before anything is attempted. */
  private async beginStep(operation: Operation, stepId: string): Promise<Operation> {
    const at = this.now()
    // Read BEFORE the patch: `extra` is handed the step with `running` already
    // written onto it, so asking there whether this is an entry or a re-entry
    // can only ever answer "re-entry".
    const entering = (operation.steps ?? []).find((s) => s.id === stepId)?.state !== 'running'
    /**
     * ENTERING a step is news; RE-ENTERING one is a nudge, and the two were
     * indistinguishable from outside. The distinction matters: a re-entry is how
     * `reensure` pushes a stuck wave along, and a wave that was re-entered
     * fifteen times before it granted anything is a completely different finding
     * from one that was entered once and sat.
     */
    if (entering) {
      log.info('operation step entered', { ...operationFields(operation), step: stepId })
    } else {
      log.debug('operation step re-entered', { ...operationFields(operation), step: stepId })
    }
    const next = this.applyPatch(operation, stepId, { state: 'running' }, at, (step) => ({
      ...step,
      startedAt: step.startedAt ?? at,
      attempts: (step.attempts ?? 0) + 1,
      /**
       * A step ENTERED is a step whose places all start their clocks now
       * (POD-2167) — most sharply for an operation adopted after a restart,
       * whose places carry stamps from the process that died. Judging the
       * successor on how long its predecessor was quiet for would fail the wave
       * the instant it resumed.
       *
       * Only on entry, never on a re-entry of a step already running: that path
       * exists so an outside event can push a stuck wave along, and refreshing
       * every clock from it would hand back the wave-wide silence this all
       * exists to remove.
       */
      ...(entering && step.places
        ? { places: restartPlaceClocks(step.places, at) ?? step.places }
        : {}),
    }))
    await this.persist(next, at)
    return next
  }

  private async completeHandoff(operation: Operation, stepId: string): Promise<void> {
    const handoff = this.handoffs.get(operation.id)
    if (!handoff) {
      // AWAITED. `fail` is async, so dropping it left the operation RUNNING:
      // the unsealed-handoff refusal was decided and never persisted, and
      // whenSettled returned with the row still in flight.
      await this.fail(operation, stepId, {
        code: HANDOFF_UNSEALED_ERROR_CODE,
        message: 'This operation attempted a handoff before its state was sealed.',
      })
      return
    }
    if (handoff.phase !== 'sealed' || handoff.stepId !== stepId) {
      throw new Error('handed-off outcome did not come from the sealing runner')
    }
    handoff.phase = 'handed-off'
    this.disarm(operation.id)
    this.disarmBudgets(operation.id)
    this.contexts.delete(operation.id)
  }

  private async finishReclaimed(
    operation: Operation,
    stepId: string,
    error: OperationError,
  ): Promise<Operation> {
    const at = this.now()
    const marked = this.applyPatch(operation, stepId, { state: 'failed', error }, at)
    const details =
      marked.details && typeof marked.details === 'object' ? { ...marked.details } : {}
    delete details._handoff
    const finished: PersistedOperation = {
      ...marked,
      details,
      state: 'failed',
      updatedAt: at,
      finishedAt: at,
      error,
    }
    const previousState = (await this.deps.store.get(operation.id))?.state
    await this.deps.store.update(finished)
    this.handoffs.delete(operation.id)
    this.disarm(operation.id)
    this.contexts.delete(operation.id)
    await this.deps.store.sweepRetention(finished.kind)
    await this.announce(operation.id, previousState)
    return finished
  }

  private invokeCancelWithin(
    cleanup: () => Promise<CancelCleanupResult>,
    operationId: string,
    budgetMs: number,
  ): Promise<CancelCleanupResult> {
    return new Promise<CancelCleanupResult>((resolve, reject) => {
      let settled = false
      const timer = this.deps.clock.setTimeout(
        () => {
          this.budgetTimers.delete(timer)
          if (settled) return
          settled = true
          reject(new Error('operation cleanup exceeded its deadline'))
        },
        Math.max(0, budgetMs),
      )
      this.budgetTimers.set(timer, operationId)
      void cleanup().then(
        (result) => {
          if (settled) return
          settled = true
          this.deps.clock.clearTimeout(timer)
          this.budgetTimers.delete(timer)
          resolve(result)
        },
        (error) => {
          if (settled) return
          settled = true
          this.deps.clock.clearTimeout(timer)
          this.budgetTimers.delete(timer)
          reject(error)
        },
      )
    })
  }

  private actionOffered(operation: Operation, actionId: string): boolean {
    if ((operation.awaiting ?? []).some((ask) => ask.id === actionId)) return true
    const details: Record<string, unknown> =
      operation.details && typeof operation.details === 'object'
        ? (operation.details as Record<string, unknown>)
        : {}
    const actions = Array.isArray(details.actions) ? details.actions : []
    return actions.some(
      (action: unknown) =>
        typeof action === 'object' && action !== null && 'id' in action && action.id === actionId,
    )
  }

  private hasPersistedHandoff(operation: Operation): boolean {
    const details: Record<string, unknown> =
      operation.details && typeof operation.details === 'object'
        ? (operation.details as Record<string, unknown>)
        : {}
    return typeof details._handoff === 'object' && details._handoff !== null
  }

  // ─────────────────────────── transitions ────────────────────────────

  /**
   * Every step is finished, so the operation is too — unless something only a
   * surface can do is still outstanding and gates correctness (§3.5). Voluntary
   * asks do not hold it open; stragglers self-serve on their next load.
   */
  private async settle(operation: Operation, def: AnyOperationKindDefinition): Promise<void> {
    if (this.isSealed(operation.id)) return
    const blocking = (operation.awaiting ?? []).filter((ask) => ask.required === true)
    const at = this.now()
    if (blocking.length > 0) {
      log.info('operation is waiting on a surface only somebody else can satisfy', {
        ...operationFields(operation),
        blocking: blocking.map((ask) => `${ask.id}@${ask.surface ?? '-'}`),
        graceMs: def.waitingGraceMs ?? DEFAULT_WAITING_GRACE_MS,
      })
      await this.persist(this.persistable(operation, def), at, 'waiting')
      this.armWaitingGrace(operation.id, def)
      return
    }
    await this.finish(this.persistable(operation, def), 'done', at)
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
    if (this.isSealed(operationId)) return
    this.disarm(operationId)
    const grace = def.waitingGraceMs ?? DEFAULT_WAITING_GRACE_MS
    this.timers.set(
      operationId,
      this.deps.clock.setTimeout(
        () => {
          void this.enqueue(operationId, async () => {
            await this.expireWaiting(operationId, def)
          }).catch(async (err) => await this.containDriveFailure(operationId, err))
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
   *
   * UNLESS THE KIND SAYS OTHERWISE (POD-2186). The justification above is a
   * claim about the plan — *the shared steps all succeeded* — and it is vacuous
   * for a plan that has none. `describeWaitingExpiry` is where a kind that can
   * produce such a plan says so, and what it returns is the error the operation
   * fails with. The grace itself is unconditional either way: ending the wait is
   * what POD-2149 was for, and a wedge is not fixed by a wrong outcome.
   */
  private async expireWaiting(
    operationId: string,
    def?: AnyOperationKindDefinition,
  ): Promise<void> {
    const operation = (await this.deps.store.get(operationId))?.operation
    if (operation?.state !== 'waiting') return
    const error = def?.describeWaitingExpiry?.({ operation })
    log.warn('the waiting grace ran out', {
      ...operationFields(operation),
      unanswered: (operation.awaiting ?? []).map((ask) => `${ask.id}@${ask.surface ?? '-'}`),
      outcome: error ? 'failed' : 'done',
      ...(error?.code ? { code: error.code } : {}),
    })
    if (error) {
      await this.finish(this.persistable(operation, def), 'failed', this.now(), error)
      return
    }
    await this.finish(this.persistable(operation, def), 'done', this.now())
  }

  private async fail(operation: Operation, stepId: string, error: OperationError): Promise<void> {
    log.warn('operation step failed', {
      ...operationFields(operation),
      step: stepId,
      code: error.code,
      ...(error.message ? { detail: error.message } : {}),
      ...(error.detail ? { because: error.detail } : {}),
    })
    const at = this.now()
    const marked = this.applyPatch(operation, stepId, { state: 'failed', error }, at)
    await this.finish(marked, 'failed', at, error)
  }

  private async finish(
    operation: PersistedOperation,
    state: 'done' | 'failed' | 'canceled',
    at: number,
    error?: OperationError,
  ): Promise<Operation> {
    if (this.handoffs.has(operation.id)) {
      throw new Error('sealed operation cannot be finished by this engine')
    }
    const finished: PersistedOperation = {
      ...operation,
      state,
      updatedAt: at,
      finishedAt: at,
      error: error ?? operation.error ?? null,
    }
    /**
     * THE OUTCOME AND THE SHAPE OF THE RUN THAT PRODUCED IT.
     *
     * Per-step attempts and stalls are on the record here because they are what
     * an operator actually asks after the fact — "did it retry?", "which step
     * went quiet?" — and retention sweeps the row away twenty operations later,
     * taking the answer with it.
     */
    const at0 = operation.startedAt ?? operation.createdAt
    log.info('operation finished', {
      ...operationFields(finished),
      state,
      ...(typeof at0 === 'number' ? { elapsedMs: at - at0 } : {}),
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.message ? { detail: error.message } : {}),
      steps: (finished.steps ?? [])
        .map(
          (step) =>
            `${step.id}=${step.state}${(step.attempts ?? 1) > 1 ? `x${step.attempts}` : ''}${
              step.stalls ? `+${step.stalls}stall` : ''
            }`,
        )
        .join(' '),
      ...((finished.awaiting ?? []).length > 0
        ? { awaiting: (finished.awaiting ?? []).map((ask) => ask.id) }
        : {}),
      ...((finished.deferred ?? []).length > 0
        ? {
            deferred: (finished.deferred ?? []).map(
              (place) => `${place.id}:${place.reason ?? 'unstated'}`,
            ),
          }
        : {}),
    })
    const previousState = (await this.deps.store.get(finished.id))?.state
    await this.deps.store.update(finished)
    this.disarm(finished.id)
    this.contexts.delete(finished.id)
    await this.deps.store.sweepRetention(finished.kind)
    await this.announce(finished.id, previousState)
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
  private async abandon(row: OperationRow, error?: OperationError): Promise<Operation> {
    const at = this.now()
    const outcome = error ?? {
      code: UNKNOWN_KIND_ERROR_CODE,
      message: `This server cannot continue a '${row.kind}' operation.`,
    }
    // A DOWNGRADE THAT QUIETLY DISABLES UPDATING is what this policy exists to
    // prevent, and it can only be seen from here: the row shows a failed
    // operation with a framework error code and nothing about which binary
    // could not drive it.
    log.error('abandoned an operation this server cannot continue', {
      operationId: row.id,
      kind: row.kind,
      code: outcome.code,
      ...(outcome.message ? { detail: outcome.message } : {}),
      ...(outcome.detail ? { because: outcome.detail } : {}),
      readable: row.operation !== undefined,
    })
    if (row.operation) {
      return await this.finish(this.persistable(row.operation), 'failed', at, outcome)
    }
    await this.deps.store.markTerminal(row.id, 'failed', at)
    this.disarm(row.id)
    await this.announce(row.id, row.state)
    return { id: row.id, kind: row.kind, state: 'failed', exclusionGroup: row.exclusionGroup }
  }

  /**
   * Record an outcome, and never throw doing it: the reason we are here may be
   * that the store is the broken thing, and a second throw out of the recovery
   * path is exactly how a contained failure becomes an uncontained one.
   */
  private async abandonSafely(
    row: OperationRow,
    error: OperationError,
  ): Promise<Operation | undefined> {
    try {
      return await this.abandon(row, error)
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
  private async containDriveFailure(operationId: string, err: unknown): Promise<void> {
    // Mid-shutdown, a write is the hazard rather than the repair.
    if (this.stopped) return
    try {
      const row = await this.deps.store.get(operationId)
      if (!row || isTerminalOperationState(row.state)) return
      await this.abandonSafely(row, {
        code: DRIVE_FAILED_ERROR_CODE,
        message: 'Podium could not continue this operation.',
        detail: err instanceof Error ? err.message : String(err),
      })
    } catch {
      // The store itself is gone. Nothing can be recorded, and a throw from
      // here would be the unhandled rejection this exists to prevent.
    }
  }

  private async persist(
    operation: PersistedOperation,
    at: number,
    state?: Operation['state'],
  ): Promise<Operation> {
    if (this.handoffs.has(operation.id)) {
      throw new Error('sealed operation cannot be persisted by this engine')
    }
    const next: PersistedOperation = { ...operation, updatedAt: at, ...(state ? { state } : {}) }
    const previousState = (await this.deps.store.get(next.id))?.state
    await this.deps.store.update(next)
    await this.announce(next.id, previousState)
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
  private async armDeadline(operationId: string): Promise<void> {
    if (this.isSealed(operationId)) return
    this.disarm(operationId)
    const due = await this.nextDue(operationId)
    if (due === undefined) return
    this.timers.set(
      operationId,
      this.deps.clock.setTimeout(
        () => {
          // A deadline is the other drive site nobody awaits (POD-2151).
          void this.enqueue(operationId, async () => await this.onDeadline(operationId)).catch(
            async (err) => await this.containDriveFailure(operationId, err),
          )
        },
        Math.max(0, due - this.now()),
      ),
    )
  }

  /** When this operation's running step next owes an answer, if it owes one at all. */
  private async nextDue(operationId: string): Promise<number | undefined> {
    const watched = await this.watched(operationId)
    if (!watched) return undefined
    return deadlineDue(watched.step, watched.budget, this.now())
  }

  /**
   * The step a timer is about, with the budget it is judged against — the four
   * refusals every deadline path shares, resolved once.
   */
  private async watched(operationId: string): Promise<
    | {
        operation: Operation
        def: AnyOperationKindDefinition
        step: OperationStep
        budget: StepDeadlines
      }
    | undefined
  > {
    const operation = (await this.deps.store.get(operationId))?.operation
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

  private disarmBudgets(operationId: string): void {
    for (const [handle, owner] of this.budgetTimers) {
      if (owner !== operationId) continue
      this.deps.clock.clearTimeout(handle)
      this.budgetTimers.delete(handle)
    }
  }

  /**
   * A deadline came due (P4). Silence gets ONE retry, because the common cause
   * is a lost message and `ensure()` is idempotent by contract. The total
   * budget gets none: a step that has already overrun its whole allowance is
   * not going to be rescued by starting it again.
   */
  private async onDeadline(operationId: string): Promise<void> {
    const watched = await this.watched(operationId)
    if (!watched) return
    const { operation, def, step, budget } = watched

    const now = this.now()
    const breach = deadlineBreach(step, budget, now)
    if (breach.kind === 'none') {
      // Progress arrived while the timer was in flight — nothing is owed yet.
      await this.armDeadline(operationId)
      return
    }

    const stalls = step.stalls ?? 0
    if (breach.kind === 'total' || stalls >= 1) {
      // The kind's chance to say WHO stopped, before the framework falls back to
      // what it alone can know: how long, and nothing else (POD-2167).
      const named = def.describeStall?.({ operation, step, breach })
      await this.fail(
        operation,
        step.id,
        named ?? {
          code: STALLED_ERROR_CODE,
          message:
            breach.kind === 'total'
              ? `This step ran out of time after ${Math.round(breach.elapsedMs / 1000)}s.`
              : `No progress for ${Math.round(breach.silentMs / 1000)}s. Podium retried once.`,
        },
      )
      return
    }

    log.warn('operation step stalled; retrying once', {
      ...operationFields(operation),
      step: step.id,
      breach: breach.kind,
      silentMs: breach.kind === 'silence' ? breach.silentMs : undefined,
      elapsedMs: breach.elapsedMs,
      stalls: stalls + 1,
    })
    // Stalled, and VISIBLY so, before anything is retried: the panel renders
    // "no progress for N s" from this state rather than from a guess, and the
    // heartbeat is deliberately not refreshed by our noticing.
    await this.persist(
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
      await this.fail(await this.require(operationId), step.id, {
        code: 'no-runner',
        message: `The '${operation.kind}' operation has no runner for step '${step.id}'.`,
      })
      return
    }
    const retryAt = this.now()
    const retrying = this.applyPatch(
      await this.require(operationId),
      step.id,
      { state: 'running' },
      retryAt,
      (s) => ({
        ...s,
        attempts: (s.attempts ?? 0) + 1,
        // THE RETRY GETS ITS OWN WINDOW (POD-2167). Stamping only the step's
        // clock was enough while that was the only clock; with per-place ones
        // the retry would inherit the very silence that caused it, `invokeWithin`
        // would compute a deadline already in the past, and the one automatic
        // retry §3.3 promises would be cut off before it could run.
        ...(s.places ? { places: restartPlaceClocks(s.places, retryAt) ?? s.places } : {}),
      }),
    )
    await this.persist(retrying, retryAt)

    // Bounded exactly as the first attempt was: a retry that hangs is the same
    // hang, and this one has already used the step's one stall.
    const outcome = await this.invokeWithin(runner, retrying, step.id, budget)
    if (this.stopped) return
    if (outcome === OVERDUE) {
      await this.onDeadline(operationId)
      return
    }
    const after = (await this.deps.store.get(operationId))?.operation
    if (!after || isTerminalOperationState(after.state)) return
    if (outcome.state === 'handed-off') {
      await this.completeHandoff(after, step.id)
      return
    }
    const handoff = this.handoffs.get(operationId)
    if (handoff?.phase === 'reclaiming') {
      if (outcome.state !== 'failed') {
        throw new Error('a reclaimed handoff runner must return failed')
      }
      await this.finishReclaimed(after, step.id, outcome.error ?? { code: 'step-failed' })
      return
    }
    if (handoff) return

    const at = this.now()
    const patch: StepProgressPatch = { ...outcome, state: outcome.state }
    const next = this.applyPatch(after, step.id, patch, at)
    await this.persist(next, at)

    if (outcome.state === 'failed') {
      await this.fail(next, step.id, outcome.error ?? { code: 'step-failed' })
      return
    }
    if (outcome.state === 'running') {
      await this.armDeadline(operationId)
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

  private async require(operationId: string): Promise<Operation> {
    const operation = (await this.deps.store.get(operationId))?.operation
    if (!operation) throw new Error(`operation ${operationId} vanished mid-flight`)
    return operation
  }

  private async announce(operationId: string, previousState: string | undefined): Promise<void> {
    const row = await this.deps.store.get(operationId)
    // AWAITED. The port is `void | Promise<void>`, and an observer that does
    // durable work -- the fleet bridge does, and so does the test that asserts
    // "what an observer reads must already be what the database holds" -- had
    // its body running AFTER announce returned. Awaiting is safe for a
    // synchronous observer, whose undefined return awaits to undefined.
    if (row) await this.deps.onChanged?.(row, previousState)
  }

  private now(): number {
    return this.deps.clock.now()
  }

  private mintId(): string {
    return this.deps.newId ? this.deps.newId() : `op_${randomUUID()}`
  }
}
