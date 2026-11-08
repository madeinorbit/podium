/**
 * THE APPROVAL DECISIONS ON THE SYNC WRITE ENTRY POINT (POD-6415, ADR 12 D2;
 * design B on POD-6241).
 *
 * `approvals.approve` and `approvals.deny`, the family's table unchanged, on the
 * sync family builder. The target check is the contract's role floor (member),
 * read live: `resource: none`, the approval IS the target, the rule the old
 * route applied.
 *
 * NOTHING OUTSIDE THE DATABASE RUNS IN THE WRITE. The decision settles the
 * request and logs it in the unit of work; then
 *  - a daemon op is handed to the owning daemon after the commit;
 *  - a server-catalog op becomes an `approval.execute` effect record created in
 *    the same unit (`execute-effect.ts`), whose run executes it;
 *  - the outcome mail and the broadcast follow the commit.
 * An unknown request is not found and a decided one a conflict, in the
 * service's words.
 */

import { mintDeviceId } from '@podium/model'
import { attributionOf, onBehalfOfUser } from '../../command-principal'
import { humanWithRoleFloor, type SyncFamily, type SyncFamilyState } from '../sync-write/family'
import { APPROVAL_EXECUTE_KIND } from './execute-effect'
import { APPROVAL_COMMANDS_TRPC } from './registry'
import { type ApprovalDecisionUnit, ApprovalRefusal, type ApprovalService } from './service'

/** The decision's unit of work, from the write's state. */
function decisionUnit(state: SyncFamilyState): ApprovalDecisionUnit {
  return {
    afterCommit: (step, label) => state.afterCommit(step, label),
    executeOnServer: async (row) => {
      const effects = state.modules.effects
      if (effects === undefined) throw new Error('approvals: no effects module is composed')
      await effects.createInUnit(state.writer, {
        id: mintDeviceId('eff_'),
        kind: APPROVAL_EXECUTE_KIND,
        target: { kind: 'session', id: row.sessionId },
        input: { approvalId: row.id },
        createdBy: onBehalfOfUser(state.principal),
        actor: attributionOf(state.principal).actor,
      })
    },
  }
}

/** The service, its two decisions written in this write's unit. */
const decisionsIn = (state: SyncFamilyState): ApprovalService => {
  const approvals = state.modules.approvals
  const unit = decisionUnit(state)
  const caller = onBehalfOfUser(state.principal)
  if (!caller) throw new Error('approval decisions require a human principal')
  const scoped = approvals.forCaller(caller)
  return Object.assign(Object.create(approvals) as ApprovalService, {
    approve: async (id: string) => await scoped.approve(id, unit),
    deny: async (id: string) => await scoped.deny(id, unit),
  })
}

export const APPROVAL_SYNC_FAMILY: SyncFamily<ApprovalService, typeof APPROVAL_COMMANDS_TRPC> = {
  family: 'approvals',
  service: decisionsIn,
  commands: APPROVAL_COMMANDS_TRPC,
  target: async (contract, _input, ctx) => await humanWithRoleFloor(contract, ctx),
  refusalOf: (error) =>
    error instanceof ApprovalRefusal ? { kind: error.kind, message: error.message } : undefined,
}
