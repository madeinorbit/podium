/**
 * `records.workflowBinding.edit` (POD-6676, ADR 12 D3; design POD-5620 §1.10):
 * the one generic edit of the workflow family. A binding is keyed by its target,
 * one per target, last writer wins. It replaced `workflows.assign` and runs the
 * same checks in the same order: the target check is assign's (the caller may
 * read the revision), and the handler runs the rest (the target's grade, a
 * published revision for a shared default, the session's scope and machine)
 * inside the edit's unit of work, the binding row and its change entry
 * committing together.
 */

import { WORKFLOW_BINDING_RECORD } from '@podium/commands'
import { parseWorkflowBindingRowId } from '@podium/model'
import { onBehalfOfUser } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { registerRecordKind } from '../records/generic'
import { SyncWriteRefused } from '../sync-write/entry'
import {
  NO_TARGET,
  refuseTarget,
  type SyncTargetContext,
  type SyncWriteRegistry,
  type SyncWriteTarget,
} from '../sync-write/registry'
import { REFUSAL_KINDS, workflowCallerForPrincipal, workflowRefusalOf } from './sync-write'

export interface WorkflowBindingRecordDeps {
  modules(): RegistryModules
}

/** The workflow caller a generic edit's principal is, with its role now. */
async function callerOf(
  ctx: Pick<SyncTargetContext, 'principal' | 'confirmed'>,
  roleOf: (user: string) => Promise<string | undefined>,
) {
  const { principal } = ctx
  if (principal.kind === 'system') return undefined
  const human = onBehalfOfUser(principal)
  if (human === null) return undefined
  const role = await roleOf(human)
  // A disabled account has no role: refused, whatever its capability says.
  if (role === undefined) return undefined
  return workflowCallerForPrincipal(principal, role === 'admin' ? 'admin' : 'member', ctx.confirmed)
}

/** Register `records.workflowBinding.edit` on the entry point. */
export function registerWorkflowBindingRecord(
  registry: SyncWriteRegistry,
  deps: WorkflowBindingRecordDeps & { roleOf(user: string): Promise<string | undefined> },
): void {
  registerRecordKind(registry, WORKFLOW_BINDING_RECORD, {
    target: async (_op, id, ctx, edited): Promise<SyncWriteTarget> => {
      if (parseWorkflowBindingRowId(id) === undefined) return undefined
      const revisionId = edited?.patch.revisionId
      if (typeof revisionId !== 'string') return undefined
      const caller = await callerOf(ctx, deps.roleOf)
      if (caller === undefined) return undefined
      const refused = await deps.modules().workflows.targetRefusal(caller, 'assign', { revisionId })
      return refused === undefined
        ? NO_TARGET
        : refuseTarget({ kind: REFUSAL_KINDS[refused.kind], message: refused.message })
    },
    edit: async (ctx, id, patch) => {
      const key = parseWorkflowBindingRowId(id)
      const revisionId = patch.revisionId
      if (key === undefined || typeof revisionId !== 'string') {
        throw new SyncWriteRefused({ kind: 'invalid', details: ['patch.revisionId'] })
      }
      const caller = await callerOf(ctx, deps.roleOf)
      if (caller === undefined) throw new SyncWriteRefused({ kind: 'target-not-found' })
      try {
        await deps
          .modules()
          .workflows.assign(caller, { ...key, revisionId }, ctx.ledger, (step, label) =>
            ctx.afterCommit(step, label),
          )
      } catch (error) {
        const refusal = workflowRefusalOf(error)
        if (refusal !== undefined) throw new SyncWriteRefused(refusal, { cause: error })
        throw error
      }
      return { ok: true }
    },
  })
}
