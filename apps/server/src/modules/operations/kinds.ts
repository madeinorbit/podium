import type {
  AwaitingAsk,
  DeferredPlace,
  Operation,
  OperationError,
  OperationStep,
  OperationStepState,
  StepPlace,
} from '@podium/protocol'

/**
 * What a KIND is (POD-2097, spec §3.0).
 *
 * The engine drives operations without knowing what any of them do. Everything
 * it would otherwise have to know is one of these three hooks — plan, reconcile,
 * and a runner per step — plus a deadline table. `update` is the first kind; a
 * server move is the one the shape was designed to also fit, which is why
 * nothing here mentions versions, machines or bundles.
 */

/** The patch a runner or a progress report may apply to a step. */
export interface StepProgressPatch {
  state?: OperationStepState
  progress?: { done: number; total: number }
  places?: StepPlace[]
  detail?: string
  error?: OperationError | null
}

/**
 * What one `ensure()` concluded.
 *
 * `running` is the interesting one: it means the step handed work to something
 * outside this call — a machine wave, a build, the server's own restart — and
 * the engine should stop driving and start watching. Liveness for that step is
 * then whatever `recordProgress` says, policed by the deadline table. Every
 * other outcome advances the plan immediately.
 */
export interface StepOutcome extends StepProgressPatch {
  state: 'done' | 'running' | 'skipped' | 'failed'
}

/**
 * A step executor. THE CONTRACT IS IDEMPOTENCE, REALITY FIRST: `ensure()` looks
 * at the world before it acts, does only the delta, and may be called again at
 * any time — after a retry, after a stall, after the server that started it was
 * replaced mid-step. That single property is what makes adoption (§3.4) and
 * retry safe, and it is the reason the engine never records "I asked for this"
 * as if it were "this happened".
 */
export interface StepRunner<Ctx = unknown> {
  ensure(input: { operation: Operation; step: OperationStep; context: Ctx }): Promise<StepOutcome>
  /**
   * May the operation be canceled while this step is the current one (§3.2)?
   * Absent means NO — the safe reading, because the irreversible steps are the
   * ones nobody remembers to mark (a server swap, a signed-bundle install), and
   * a cancel that lands mid-swap is the failure this gate exists to prevent.
   */
  reversible?: boolean
}

/** Per-step liveness budget (§3.3). Silence is heartbeat staleness; total is wall clock. */
export interface StepDeadlines {
  /** No accepted progress for this long ⇒ stalled, then one retry. */
  silenceMs?: number
  /** The step has simply taken too long ⇒ failed, with no retry. */
  totalMs?: number
}

/** What `plan()` computes at creation time — the step list IS the plan (§3.1). */
export interface OperationPlan {
  steps: Array<Pick<OperationStep, 'id'> & Partial<OperationStep>>
  details?: Record<string, unknown>
  awaiting?: AwaitingAsk[]
  deferred?: DeferredPlace[]
  /**
   * The operation this one retries the remainder of (§3.2). Set by the KIND,
   * because only the kind knows what a remainder is — but carried here, and
   * written onto the top-level `retryOf` the protocol already defines, so
   * history has one definition of the link rather than a second copy under
   * `details` that every reader would have to learn (POD-2098).
   */
  retryOf?: string
}

export interface OperationKindDefinition<Ctx = unknown, Reality = unknown> {
  kind: string
  /**
   * At most one operation per group may be active. `update` takes `lifecycle`
   * and a future server move joins it, so the two can never interleave.
   */
  exclusionGroup: string
  plan(context: Ctx): OperationPlan | Promise<OperationPlan>
  /**
   * Re-derive the operation from observable facts after a restart (P3). Called
   * with whatever `reality` the caller assembled — the framework fixes only the
   * shape and the call order (reconcile, persist, resume), never the facts.
   *
   * It returns the operation it believes in. Returning the input unchanged is a
   * legitimate answer for a kind whose steps cannot be observed.
   */
  reconcile(operation: Operation, reality: Reality): Operation | Promise<Operation>
  runners: Record<string, StepRunner<Ctx>>
  deadlines?: Record<string, StepDeadlines>
  /**
   * How long this kind's operations stay `waiting` on a required surface-local
   * ask before completing anyway (§3.5). Absent means the framework default —
   * there is deliberately no way to say "forever", because an unbounded wait is
   * the defect the grace exists to close (POD-2149).
   */
  waitingGraceMs?: number
}

/** The erased form the engine holds: it passes a context through, it never reads one. */
export type AnyOperationKindDefinition = OperationKindDefinition<never, never>

/**
 * The registry — a plain map, populated at composition time. It is a class only
 * so that a duplicate registration is refused loudly: two definitions for one
 * kind would make which one drives an operation depend on module import order.
 */
export class OperationKindRegistry {
  private readonly defs = new Map<string, AnyOperationKindDefinition>()

  register<Ctx, Reality>(def: OperationKindDefinition<Ctx, Reality>): void {
    if (this.defs.has(def.kind)) {
      throw new Error(`operation kind '${def.kind}' is already registered`)
    }
    // The one cast in the framework: the engine carries a context from the
    // caller who chose the kind straight back to that kind's own hooks, and is
    // deliberately unable to look at it on the way through.
    this.defs.set(def.kind, def as unknown as AnyOperationKindDefinition)
  }

  get(kind: string): AnyOperationKindDefinition | undefined {
    return this.defs.get(kind)
  }

  kinds(): string[] {
    return [...this.defs.keys()]
  }

  /** Distinct exclusion groups — what boot adoption has to sweep. */
  groups(): string[] {
    return [...new Set([...this.defs.values()].map((d) => d.exclusionGroup))]
  }
}
