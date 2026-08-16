import { z } from 'zod'

/**
 * THE OPERATION — a durable, server-owned long-running process, as bytes
 * (POD-2097, spec `2026-08-14-update-operations-design.md` §3.0–§3.1).
 *
 * An operation is deliberately NOT an update. `kind` selects a registered
 * definition (the first is `update`; a server move will be another), and
 * everything kind-specific lives under `details` and inside the open-vocabulary
 * string fields called out below. Nothing in this file may grow an
 * update-shaped assumption — the whole point of the generic layer is that the
 * renderer can draw a kind it has never heard of.
 *
 * THE FROZEN-CONTRACT LAW (P8), copied from `/version` (`server-version.ts`)
 * ------------------------------------------------------------------------
 * A web bundle is swapped *during* the very operation it is rendering, so an
 * old bundle must be able to render a new server's operation and vice versa.
 * Hence: fields are ADDED, never removed or retyped; an absent field is never
 * an error; an unknown field is ignored — and, unlike `/version`, is also
 * PRESERVED, because a server that persists what it parsed must not silently
 * drop a successor's field on the next write (`.passthrough()` everywhere).
 *
 * TWO DELIBERATE ASYMMETRIES, each with a reason:
 *
 *  - `id`, `kind` and `state` are REQUIRED. A payload missing one of them is
 *    not a degraded operation, it is not an operation — there is nothing to
 *    render and nothing to key single-flight on. `parseOperation` answers
 *    `null` for it, which is the same answer as "no operation is active", and
 *    that is the honest reading.
 *  - The two lifecycle enums are CLOSED, so a retyped or invented state is a
 *    parse failure rather than a renderer drawing a blank. Additivity here
 *    means a new FIELD, never a new state value: a seventh operation state
 *    would silently un-render on every deployed bundle, which is exactly the
 *    class of breakage the frozen contract exists to forbid. Vocabularies that
 *    genuinely belong to a kind — a place's convergence state, an error code, a
 *    surface name — are open `z.string()` for the mirror-image reason: the
 *    generic layer cannot enumerate them without becoming update-specific.
 */

export const OPERATION_STATES = [
  'pending',
  'running',
  'waiting',
  'done',
  'failed',
  'canceled',
] as const
export const OperationState = z.enum(OPERATION_STATES)
export type OperationState = z.infer<typeof OperationState>

export const OPERATION_STEP_STATES = [
  'pending',
  'running',
  'stalled',
  'done',
  'failed',
  'skipped',
] as const
export const OperationStepState = z.enum(OPERATION_STEP_STATES)
export type OperationStepState = z.infer<typeof OperationStepState>

/** Reached an outcome: no further work, no timer, releases the exclusion group. */
export const TERMINAL_OPERATION_STATES: ReadonlySet<string> = new Set([
  'done',
  'failed',
  'canceled',
])

/** Takes a bare `string` on purpose — the store reads a column, not a parsed union. */
export function isTerminalOperationState(state: string): boolean {
  return TERMINAL_OPERATION_STATES.has(state)
}

/**
 * One place a step is acting on (§3.1 `steps[].places`). `state` and `detail`
 * are the kind's vocabulary — for `update` these are convergence states
 * (`downloading`, `restarting`, …); the framework only carries them.
 */
export const StepPlace = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    state: z.string().optional(),
    percent: z.number().optional(),
    detail: z.string().optional(),
  })
  .passthrough()
export type StepPlace = z.infer<typeof StepPlace>

/**
 * A typed failure (§7). `code` is open because the taxonomy belongs to the kind
 * (`machine-dirty-checkout`, `server-did-not-reach-target`, …) and one generic
 * code, `stalled`, is contributed by the engine itself.
 */
export const OperationError = z
  .object({
    code: z.string(),
    message: z.string().optional(),
    detail: z.string().optional(),
    places: z.array(z.string()).optional(),
  })
  .passthrough()
export type OperationError = z.infer<typeof OperationError>

/**
 * A named step of the plan. `id` is stable API; `title` is presentation.
 * `lastProgressAt` is the per-step half of the liveness contract (P4) — the
 * operation's `updatedAt` is the other half, and a UI can render "no progress
 * for 40 s" from either without knowing what the step does.
 */
export const OperationStep = z
  .object({
    id: z.string(),
    state: OperationStepState,
    title: z.string().optional(),
    progress: z
      .object({ done: z.number(), total: z.number() })
      .passthrough()
      .optional(),
    places: z.array(StepPlace).optional(),
    startedAt: z.number().optional(),
    lastProgressAt: z.number().optional(),
    finishedAt: z.number().optional(),
    /** How many times `ensure()` has been run for this step, retries included. */
    attempts: z.number().optional(),
    detail: z.string().optional(),
    error: OperationError.nullable().optional(),
  })
  .passthrough()
export type OperationStep = z.infer<typeof OperationStep>

/**
 * A surface-scoped ask (§3.5): something only a particular surface can do —
 * reload this page, restart Podium Desktop on `macbook`. Other surfaces render
 * it honestly and cannot act on it (P5).
 *
 * `required` distinguishes the two kinds of ask §3.5 separates: an ask that
 * gates correctness (the all-in-one install) holds the operation in `waiting`;
 * a voluntary one (an idle tab that hasn't reloaded) does not.
 */
export const AwaitingAsk = z
  .object({
    id: z.string(),
    surface: z.string().optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    place: z.string().optional(),
    required: z.boolean().optional(),
  })
  .passthrough()
export type AwaitingAsk = z.infer<typeof AwaitingAsk>

/**
 * An eventual place (§3.6): known, not reachable now, and explicitly NOT
 * holding the outcome open — "2 machines will update when they reconnect".
 */
export const DeferredPlace = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough()
export type DeferredPlace = z.infer<typeof DeferredPlace>

export const Operation = z
  .object({
    id: z.string(),
    kind: z.string(),
    state: OperationState,
    /** At most one active operation per group; `update` and a future server move share one. */
    exclusionGroup: z.string().optional(),
    /** Kind-specific payload, under the same frozen-contract law as its container. */
    details: z.object({}).passthrough().optional(),
    createdBy: z.string().optional(),
    createdAt: z.number().optional(),
    startedAt: z.number().optional(),
    /** The heartbeat: bumped on every accepted progress event (P4). */
    updatedAt: z.number().optional(),
    finishedAt: z.number().nullable().optional(),
    steps: z.array(OperationStep).optional(),
    awaiting: z.array(AwaitingAsk).optional(),
    deferred: z.array(DeferredPlace).optional(),
    error: OperationError.nullable().optional(),
    /** The operation this one retries the remainder of (§3.2) — history stays honest. */
    retryOf: z.string().optional(),
  })
  .passthrough()
export type Operation = z.infer<typeof Operation>

/**
 * THE one parser. Every consumer — the server's own tests, the engine's
 * round-trip through SQLite, and later the web renderer — goes through this, so
 * there is exactly one place where tolerance is defined and exactly one place a
 * conformance test has to hold.
 *
 * `null` means "this is not an operation", which callers already have to handle
 * because "no operation is active" is the common case.
 */
export function parseOperation(raw: unknown): Operation | null {
  const parsed = Operation.safeParse(raw)
  return parsed.success ? parsed.data : null
}
