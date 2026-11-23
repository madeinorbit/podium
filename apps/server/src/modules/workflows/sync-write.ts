/**
 * THE WORKFLOW WRITES ON THE SYNC WRITE ENTRY POINT (POD-6418, ADR 12 D2).
 *
 * The nine writes of `WORKFLOW_COMMANDS`, on the sync family builder. Each runs
 * through `WorkflowService.execute`, the one door every workflow write has used
 * since POD-732: the contract's parse, `WorkflowAccess`, and the run-scoped
 * advance idempotency all still apply. What the entry point adds is everything
 * around it: the coarse check, the target check below, the dedup by the
 * envelope's `mutationId`, and ONE unit of work, so a library write's workflow,
 * revision and event rows commit together or not at all.
 *
 * THE TARGET CHECK is the record's own: owner, grant or delegation, resolved
 * live by `WorkflowAccess` (`WorkflowService.targetRefusal`), after the
 * contract's role floor. It runs before the handler and before the dedup, so a
 * replay is refused once the grant or the delegation is gone. A refusal there
 * carries the words the handler would have used (one answer for a missing record
 * and an invisible one), because callers read them: the workflow CLI turns
 * "approval required" into an approval request.
 *
 * WORK OUTSIDE THE DATABASE. Only `checkpoint` has any: a worker's checkpoint
 * notifies the run's coordinator, a message delivered to that session's
 * machine. It runs through the unit's `afterCommit`: once the checkpoint has
 * committed, never on a rollback, and outside its provenance.
 *
 * THE CALLER. A workflow decision grades by the account's role NOW (admin is
 * `protectedWrite`) and by the agent's scope, which the caller's out-of-scope
 * confirmation widens: both are read from the transport, as the relay always
 * did (`relay.ts` `workflowCallerForCapability`), never from the input.
 */

import type { AnyCommandContract } from '@podium/commands'
import type { UserRole } from '@podium/model'
import type { SyncSubmitRefusal } from '@podium/protocol'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import {
  humanWithRoleFloor,
  type SyncFamily,
  type SyncFamilyState,
  type SyncFamilyTargetContext,
} from '../sync-write/family'
import { NO_TARGET, refuseTarget, type SyncWriteTarget } from '../sync-write/registry'
import { WorkflowRefusal } from './handlers/context'
import { WORKFLOW_COMMANDS, type WorkflowProcName } from './registry'
import type { WorkflowCaller, WorkflowService } from './service'

/** The workflow caller for a principal the transport resolved. */
export function workflowCallerForPrincipal(
  principal: Exclude<CommandPrincipal, { kind: 'system' }>,
  role: UserRole | undefined,
  confirmed: boolean,
): WorkflowCaller {
  const sessionId = principal.capability.actorSessionId
  return {
    actor: sessionId ? { kind: 'session', id: sessionId } : { kind: 'operator', id: null },
    capability: principal.capability,
    principal,
    onBehalfOf: onBehalfOfUser(principal),
    ...(role === 'admin' ? { protectedWrite: true } : {}),
    ...(confirmed ? { overrideScope: true } : {}),
  }
}

/** What a workflow write reaches: the service, and the caller, built per call. */
export interface WorkflowWriteState {
  readonly workflows: WorkflowService
  /** The command's own writer: its rows' change entries commit on it. */
  readonly writer: SyncFamilyState['writer']
  caller(): Promise<WorkflowCaller>
  afterCommit(step: () => void | Promise<void>, label: string): void
}

export function selectWorkflowWriteState(state: SyncFamilyState): WorkflowWriteState {
  const { principal } = state
  return {
    workflows: state.modules.workflows,
    writer: state.writer,
    caller: async () => {
      if (principal.kind === 'system')
        throw new Error('a workflow write reached its handler without a human')
      const human = onBehalfOfUser(principal)
      const role = human === null ? undefined : await state.roleOf(human)
      return workflowCallerForPrincipal(principal, role, state.confirmed)
    },
    afterCommit: (step, label) => state.afterCommit(step, label),
  }
}

/** One write as the sync family runs it: its contract, and a handler answering
 *  what that proc's own handler answers. */
interface WorkflowSyncCommand<N extends WorkflowProcName> {
  readonly contract: (typeof WORKFLOW_COMMANDS)[N]['contract']
  readonly handler: (
    state: WorkflowWriteState,
    input: unknown,
  ) => ReturnType<(typeof WORKFLOW_COMMANDS)[N]['handler']>
}

export type WorkflowSyncCommands = { readonly [N in WorkflowProcName]: WorkflowSyncCommand<N> }

function syncCommand<N extends WorkflowProcName>(proc: N): WorkflowSyncCommand<N> {
  const handler = async (state: WorkflowWriteState, input: unknown): Promise<unknown> =>
    await state.workflows.execute(await state.caller(), proc, input, {
      writer: state.writer,
      afterCommit: (step, label) => state.afterCommit(step, label),
    })
  // `execute` is typed per proc through a conditional the compiler cannot
  // resolve for a generic `N`; the value IS that proc's handler's answer.
  return {
    contract: WORKFLOW_COMMANDS[proc].contract,
    handler: handler as WorkflowSyncCommand<N>['handler'],
  }
}

/** The table, built from `WORKFLOW_COMMANDS` so an eleventh write joins by declaration. */
export const WORKFLOW_SYNC_COMMANDS: WorkflowSyncCommands = Object.fromEntries(
  (Object.keys(WORKFLOW_COMMANDS) as WorkflowProcName[]).map((proc) => [proc, syncCommand(proc)]),
) as unknown as WorkflowSyncCommands

/** `workflows.revise` → `revise`. */
const procOf = (contract: AnyCommandContract): WorkflowProcName =>
  contract.name.slice('workflows.'.length) as WorkflowProcName

async function workflowTarget(
  contract: AnyCommandContract,
  input: unknown,
  ctx: SyncFamilyTargetContext,
): Promise<SyncWriteTarget> {
  const floor = await humanWithRoleFloor(contract, ctx)
  if (floor === undefined) return undefined
  const { principal } = ctx
  if (principal.kind === 'system') return undefined
  const human = onBehalfOfUser(principal)
  const role = human === null ? undefined : await ctx.roleOf(human)
  const caller = workflowCallerForPrincipal(principal, role, ctx.confirmed)
  const refused = await ctx.modules.workflows.targetRefusal(caller, procOf(contract), input)
  return refused === undefined
    ? NO_TARGET
    : refuseTarget({ kind: REFUSAL_KINDS[refused.kind], message: refused.message })
}

export const REFUSAL_KINDS: Readonly<Record<WorkflowRefusal['kind'], SyncSubmitRefusal['kind']>> = {
  'not-found': 'target-not-found',
  unauthorized: 'unauthorized',
  conflict: 'conflict',
  invalid: 'invalid',
}

/** The family's own refusals, with their words; anything else propagates. */
export function workflowRefusalOf(error: unknown): SyncSubmitRefusal | undefined {
  if (!(error instanceof WorkflowRefusal)) return undefined
  return { kind: REFUSAL_KINDS[error.kind], message: error.message }
}

export const WORKFLOW_SYNC_FAMILY: SyncFamily<WorkflowWriteState, WorkflowSyncCommands> = {
  family: 'workflows',
  service: selectWorkflowWriteState,
  commands: WORKFLOW_SYNC_COMMANDS,
  target: workflowTarget,
  refusalOf: workflowRefusalOf,
}
