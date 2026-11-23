/**
 * Approvals in a test that builds a bare registry (POD-6674): file a request as
 * the relay would, and decide it as its person does, with `records.effect.edit`
 * on the sync write entry point. The decision's run follows its commit; these
 * wait for it.
 */

import { asMutationId, firstAdminMemberId } from '@podium/model'
import type { ApprovalWire } from '@podium/protocol'
import { fixtureCommitWriter } from '@podium/sync/testing'
import { userCommandPrincipal } from '../command-principal'
import type { SessionRegistry } from '../relay'

/** The person every bare-registry session belongs to. */
const owner = () => userCommandPrincipal(firstAdminMemberId(), 'admin')

/** An agent's request, written as `approvals.request` writes it. */
export async function fileApproval(
  reg: SessionRegistry,
  input: { op: unknown; sessionId: string; machineId: string },
): Promise<{ id: string }> {
  return await reg.modules.approvals.request(input, {
    ledger: fixtureCommitWriter(),
    principal: owner(),
  })
}

/** The person's decision, then its run; answers the request as the CLI reads it. */
export async function decideApproval(
  reg: SessionRegistry,
  id: string,
  decision: 'approve' | 'deny' = 'approve',
): Promise<ApprovalWire> {
  const shown = await reg.sessionStore.effects.get(id)
  const reply = await reg.modules.syncWrite.submit(
    {
      mutationId: asMutationId(`m-${decision}-${id}`),
      command: 'records.effect.edit',
      version: 1,
      input: { id, patch: { decision }, expectedRevision: shown?.revision },
    },
    owner(),
    'trpc',
  )
  if (reply.outcome !== 'applied')
    throw new Error(`the decision was refused: ${JSON.stringify(reply)}`)
  await reg.modules.effects?.runner.idle()
  return await reg.modules.approvals.get({ id })
}
