/**
 * AN APPROVED SERVER-CATALOG OP RUNS AS AN EFFECT RECORD (POD-6415, ADR 12 D5
 * E2; decided on POD-6241).
 *
 * `approvals.approve` is a write: it settles the request (pending → executing)
 * and logs the decision in its unit of work. The op itself (publish a workflow
 * revision, set a workflow default, schedule a one-off automation) is another
 * family's write through that family's own door, which cannot open inside the
 * decision's unit. So the decision creates an `approval.execute` record in the
 * same unit, and its run executes the op after the commit:
 *
 *  - TARGET: the requesting session, whose readers see the request. Nobody
 *    creates this kind through `effects.create` (`admit` refuses it): only the
 *    decision does, in its own unit.
 *  - RUN: once per record id (the runner's claim), as the approver re-read now:
 *    an approver whose account was disabled in between settles the request
 *    failed instead. A request no longer executing answers its own status.
 *  - RECOVER (the server stopped mid-run): a settled request answers how it
 *    settled; one still executing may or may not have run its op, so it is
 *    settled failed in those words and the record is `unknown`.
 *  - DEADLINE: the approval stall deadline. A record that never ran leaves its
 *    request executing, and the stall sweep fails it in the same words.
 *
 * Daemon ops never come here: the decision hands them to the owning daemon
 * after its commit (`ApprovalService.approve`).
 */

import { z } from 'zod'
import type { RegistryModules } from '../../relay'
import type { UsersRepository } from '../../store/users'
import type { EffectExecutor, EffectOutcome } from '../effects/registry'
import { WRITER_NO_LONGER_ALLOWED, writerPrincipalNow } from '../effects/writer'
import { NO_TARGET } from '../sync-write/registry'
import { APPROVAL_EXEC_DEADLINE_MS, type ApprovalService } from './service'

export const APPROVAL_EXECUTE_KIND = 'approval.execute'

export const ApprovalExecuteInput = z.object({ approvalId: z.string().min(1) }).strict()
export type ApprovalExecuteInput = z.infer<typeof ApprovalExecuteInput>

export interface ApprovalExecuteEffectDeps {
  modules(): RegistryModules
  /** The approver's account as it is now. */
  users: Pick<UsersRepository, 'get'>
  approvals(): ApprovalService
}

const settled = (status: string, resultText: string | null): EffectOutcome =>
  status === 'succeeded'
    ? { status: 'succeeded', result: { status, resultText } }
    : {
        status: 'failed',
        error: { code: status, message: resultText ?? `the request is ${status}` },
        result: { status, resultText },
      }

const MAY_HAVE_RUN =
  'The server stopped while it ran this operation; it may or may not have run. Check before asking again.'

export function registerApprovalExecuteEffect(deps: ApprovalExecuteEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('approval execute: no effects module')

  const executor: EffectExecutor<ApprovalExecuteInput> = {
    kind: APPROVAL_EXECUTE_KIND,
    input: ApprovalExecuteInput,
    deadlineMs: APPROVAL_EXEC_DEADLINE_MS,
    // Cancel and dismiss read this: a person may act on an approval's record.
    target: async (_target, principal) => (principal.kind === 'system' ? undefined : NO_TARGET),
    // Only the decision creates one, in its own unit: never `effects.create`.
    admit: async () => ({
      kind: 'unauthorized',
      message: 'an approval runs its operation when it is approved',
    }),
    run: async ({ record, input }) => {
      const approvals = deps.approvals()
      const row = await approvals.rowOf(input.approvalId)
      if (row === undefined) return settled('failed', 'the approval request is gone')
      if (row.status !== 'executing') return settled(row.status, row.resultText)
      const approver = await writerPrincipalNow(deps.modules(), deps.users, record)
      if (approver === undefined) {
        await approvals.settleServerOp(row, 'failed', WRITER_NO_LONGER_ALLOWED)
        return settled('failed', WRITER_NO_LONGER_ALLOWED)
      }
      const outcome = await approvals.runServerOp(input.approvalId)
      return settled(outcome.status, outcome.resultText)
    },
    recover: async ({ input }) => {
      const approvals = deps.approvals()
      const row = await approvals.rowOf(input.approvalId)
      if (row === undefined) return settled('failed', 'the approval request is gone')
      if (row.status !== 'executing') return settled(row.status, row.resultText)
      await approvals.settleServerOp(row, 'failed', MAY_HAVE_RUN)
      return { status: 'unknown', error: { code: 'lost-track', message: MAY_HAVE_RUN } }
    },
  }
  effects.executors.register(executor)
}
