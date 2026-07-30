/**
 * THE JOIN — contracts (L1, `@podium/commands`) paired with handlers (L3, this
 * module's `handlers/` directory), per ADR 3 D1 and POD-311's three-way split.
 *
 * A transport does not reach a handler; it reaches a CONTRACT by name, the
 * contract's schema validates the input, the framework applies the contract's
 * run-scoped idempotency, and only then does the joined handler run. That order
 * is the whole point of a framework: a twelfth advance added to this table is
 * idempotent because it declared itself an advance, not because whoever added
 * it remembered to write the check.
 */

import {
  type AdvanceIdempotencyPort,
  type AnyCommandContract,
  advanceIdempotencyKey,
  assertAdvanceIsDeliverable,
  registryClassificationErrors,
  type TransportTag,
  WORKFLOW_CONTRACTS,
  type WorkflowContractName,
  workflowAdvanceOf,
} from '@podium/commands'
import {
  adoptHandler,
  assignStepHandler,
  checkpointHandler,
  retryHandler,
  skipHandler,
} from './handlers/advances'
import type { WorkflowHandlerContext } from './handlers/context'
import {
  assignHandler,
  createHandler,
  forkHandler,
  profileSaveHandler,
  publishHandler,
  reviseHandler,
} from './handlers/library'

/** One contract joined to the handler that implements it. */
export interface WorkflowCommand {
  readonly contract: AnyCommandContract
  readonly handler: (ctx: WorkflowHandlerContext, input: never) => unknown
}

/**
 * The joined table, keyed by the BARE proc name every transport already
 * dispatches on. The wire names are kept: renaming them is a
 * client-compatibility change and this is a migration.
 *
 * ELEVEN, matching POD-311's list exactly. The seven QUERIES this surface also
 * serves are NOT here and are not contracts: they are declared in
 * `./queries.ts`, for the reason that file gives — a `visibility` class
 * describes what a command WRITES, and a read writes nothing. Their
 * AUTHORIZATION runs through the same `WorkflowAccess` these handlers use,
 * which is the property POD-730 pinned them for, and both transports read the
 * one declaration, which is the property POD-732's cutover was for.
 */
export const WORKFLOW_COMMANDS = {
  create: { contract: WORKFLOW_CONTRACTS.create, handler: createHandler },
  revise: { contract: WORKFLOW_CONTRACTS.revise, handler: reviseHandler },
  fork: { contract: WORKFLOW_CONTRACTS.fork, handler: forkHandler },
  publish: { contract: WORKFLOW_CONTRACTS.publish, handler: publishHandler },
  assign: { contract: WORKFLOW_CONTRACTS.assign, handler: assignHandler },
  profileSave: { contract: WORKFLOW_CONTRACTS.profileSave, handler: profileSaveHandler },
  checkpoint: { contract: WORKFLOW_CONTRACTS.checkpoint, handler: checkpointHandler },
  assignStep: { contract: WORKFLOW_CONTRACTS.assignStep, handler: assignStepHandler },
  skip: { contract: WORKFLOW_CONTRACTS.skip, handler: skipHandler },
  retry: { contract: WORKFLOW_CONTRACTS.retry, handler: retryHandler },
  adopt: { contract: WORKFLOW_CONTRACTS.adopt, handler: adoptHandler },
} as const satisfies Record<WorkflowContractName, WorkflowCommand>

export type WorkflowProcName = keyof typeof WORKFLOW_COMMANDS

export const isWorkflowCommand = (proc: string): proc is WorkflowProcName =>
  proc in WORKFLOW_COMMANDS

/**
 * ADR 3 D3, enforced rather than documented. Default-closed: an unknown proc is
 * `false`, not "probably fine", so a typo at a call site removes a surface
 * loudly instead of opening one silently.
 */
export function isWorkflowProcExposedOn(proc: string, transport: TransportTag): boolean {
  if (!isWorkflowCommand(proc)) return false
  return WORKFLOW_COMMANDS[proc].contract.exposure.includes(transport)
}

/** The classification lint over the joined table. */
export const workflowRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(WORKFLOW_COMMANDS).map((c) => c.contract))

/**
 * The run id an advance acts on — the resource scope its idempotency key needs.
 *
 * Resolved through the ENGINE, not read off the input, because `runId` is
 * optional on every advance and the implicit case (the caller's own live run)
 * is the one the ledger most needs to cover: a retried RPC from an agent never
 * carries a run id.
 *
 * Resolution runs the run's VISIBILITY decision as a side effect, which is
 * deliberate ordering — a caller may not probe the idempotency ledger for a run
 * it cannot see.
 */
function advanceTarget(
  ctx: WorkflowHandlerContext,
  input: { runId?: string | undefined },
): { id: string; hasSteps: boolean } {
  const run = ctx.engine.runFor(ctx.caller, input.runId)
  return { id: run.id, hasSteps: run.steps.length > 0 }
}

/**
 * Validate through the CONTRACT's schema, apply the framework's run-scoped
 * idempotency, then run the joined handler.
 *
 * THE IDEMPOTENCY IS THE FRAMEWORK'S, NOT THE HANDLER'S, and that placement is
 * the fix rather than an implementation detail. POD-730 §6's double-advance
 * exists because `checkpoint`'s handler resolves the current step at apply
 * time; no amount of care inside that handler can tell its second invocation
 * from its first, because the two are identical. Only the layer that can see
 * the DELIVERY can. So this function:
 *
 *   1. refuses the ambiguous frame — no mutation id AND no step id — before any
 *      state is read, so the refusal cannot half-apply;
 *   2. returns the FIRST delivery's recorded result for a replayed mutation id,
 *      without invoking the handler at all, which is what makes the replay
 *      observationally identical for the caller and a no-op for the run.
 *
 * A handler that is never invoked cannot double-advance. That is the whole
 * mechanism, and it is why the check lives here.
 */
export function dispatchWorkflowCommand(
  proc: WorkflowProcName,
  ctx: WorkflowHandlerContext,
  rawInput: unknown,
  opts?: { ledger?: AdvanceIdempotencyPort },
): unknown {
  const { contract, handler } = WORKFLOW_COMMANDS[proc]
  const ledger = opts?.ledger
  // THE PARSE IS UNCONDITIONAL (POD-732).
  //
  // POD-731 carried a `validated` flag so the service shims could pass
  // hand-built objects through unparsed, on the reasoning that a parse would
  // replace POD-730's pinned DOMAIN errors with ZodErrors. The shims are gone,
  // and the reasoning was MEASURED rather than inherited: of the 88 pins, the
  // parse moved exactly ONE — `create` with `scopeRef: ''`, which the schema's
  // `.min(1)` has always rejected on every transport, so the pin described a
  // path only the shims could take. Every other pinned domain error is thrown
  // by a handler for input this schema accepts.
  //
  // So the flag is deleted rather than inherited. One door, always validated —
  // a bypass that exists is a bypass a future caller will find, and the one
  // behaviour it preserved was a behaviour no wire caller could observe.
  const input = contract.input.parse(rawInput ?? {})
  const run = (ctx: WorkflowHandlerContext, i: unknown): unknown =>
    (handler as (c: WorkflowHandlerContext, i: unknown) => unknown)(ctx, i)

  const advance = workflowAdvanceOf(proc)
  if (advance === undefined) return run(ctx, input)

  const identity = input as { mutationId?: string; stepId?: string; runId?: string }
  // Resolving the target FIRST is deliberate on two counts. It runs the run's
  // visibility decision before anything else, so a caller cannot probe the
  // idempotency ledger for a run it may not see; and it is what tells the
  // framework whether there is a step to name at all — a prompt-only run has
  // none, and refusing it for not naming one would refuse a frame with no
  // ambiguity and no remedy.
  const target = advanceTarget(ctx, identity)
  assertAdvanceIsDeliverable({
    ...(identity.mutationId !== undefined ? { mutationId: identity.mutationId } : {}),
    ...(identity.stepId !== undefined ? { stepId: identity.stepId } : {}),
    targetNamedBy: advance.targetNamedBy,
    targetHasSteps: target.hasSteps,
  })
  if (identity.mutationId === undefined || ledger === undefined) return run(ctx, input)

  const key = advanceIdempotencyKey({
    contract: contract.name,
    runId: target.id,
    mutationId: identity.mutationId,
  })
  const recalled = ledger.recall(key)
  // A recorded result is returned VERBATIM rather than recomputed. Recomputing
  // it would re-read a run that has since moved and hand the caller a different
  // answer to the same delivery — which is the double-advance again, wearing a
  // read's clothes.
  if (recalled !== undefined) return JSON.parse(recalled)
  const result = run(ctx, input)
  ledger.record(key, JSON.stringify(result ?? null))
  return result
}
