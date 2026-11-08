/**
 * WHO MAY DECIDE AN APPROVAL (POD-6674, coordinator review of 68a2f3a94a).
 *
 * An approval asks a person to release a management operation the agent may
 * not run itself. Being the asking session's owner is not enough: a member
 * would then approve their own agent's server update, which only an admin can
 * do. So a decider must be BOTH
 *
 *  - the request's person (the owner of the asking session, or a caller whose
 *    scope is the whole instance) or an admin; and
 *  - allowed to run the operation, checked live at the decision against the
 *    operation's own target, as that operation's own command checks it (ADR 3's
 *    target check):
 *      update, channel, set-server  instance admin
 *      stop                         `manage` on the machine it stops
 *      workflow-publish             write on the revision's workflow
 *      workflow-set-default         write on the revision's workflow
 *      automation-schedule          an automation of one's own: a member, and
 *                                   the session it resumes must be theirs
 *    An operation with no rule here needs an admin.
 *
 * When the agent asks, the request is routed (`deciders` on the record): to its
 * owner when they may run the operation, else to every admin who may. Only
 * those receive it in their popup, and the decision checks again, live. A
 * request that nobody could decide is refused then.
 */

import type { MachineId, SessionId, UserId } from '@podium/model'
import type { ApprovalEffectInput, ApprovalOp } from '@podium/protocol'
import type { CommandPrincipal } from '../../command-principal'

export interface ApprovalOpPermissionDeps {
  /** Whether the principal holds `verb` on the machine, read now. */
  machineVerb(principal: CommandPrincipal, machineId: MachineId, verb: 'manage'): Promise<boolean>
  /** Whether the principal may write the workflow the revision belongs to. */
  workflowWrite(principal: CommandPrincipal, revisionId: string): Promise<boolean>
  /** The owner of a session now; undefined when it is gone. */
  sessionOwner(sessionId: SessionId): Promise<UserId | undefined>
}

const isAdmin = (principal: CommandPrincipal): boolean =>
  principal.kind !== 'system' && principal.capability.role === 'admin'

/** Whether `principal` may run `op`, as the request names it. */
export async function mayRunApprovalOp(
  deps: ApprovalOpPermissionDeps,
  principal: CommandPrincipal,
  approval: ApprovalEffectInput,
): Promise<boolean> {
  if (principal.kind === 'system') return false
  const op: ApprovalOp = approval.op
  switch (op.kind) {
    case 'update':
    case 'channel':
    case 'set-server':
      return isAdmin(principal)
    case 'stop':
      return await deps.machineVerb(principal, approval.machineId, 'manage')
    case 'workflow-publish':
    case 'workflow-set-default':
      return await deps.workflowWrite(principal, op.revisionId)
    case 'automation-schedule': {
      if (principal.capability.role === 'viewer') return false
      const resumes =
        op.target.kind === 'current'
          ? approval.sessionId
          : op.target.kind === 'session'
            ? op.target.sessionId
            : undefined
      if (resumes === undefined) return true
      const owner = await deps.sessionOwner(resumes)
      return owner !== undefined && principal.kind === 'user' && owner === principal.user
    }
    default:
      // An operation this table does not know yet is an admin's.
      return isAdmin(principal)
  }
}

/** Whether `principal` is the request's person: its owner, or instance-scoped. */
export function isRequestPerson(principal: CommandPrincipal, person: UserId | null): boolean {
  if (principal.kind === 'system') return false
  if (principal.capability.scope.kind === 'all') return true
  return principal.kind === 'user' && person !== null && principal.user === person
}
