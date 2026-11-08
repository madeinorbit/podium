/**
 * Approval test helpers over the REAL composed server (`makeOracle`): an agent
 * asks through the relay, a person decides with `records.effect.edit` over
 * `sync.submit`, and the record is read from the effects table (POD-6674).
 */

import type { SessionId } from '@podium/model'
import type { ApprovalEffectInput, ApprovalOp, SyncSubmitReply } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { expect, vi } from 'vitest'
import type { EffectRow } from '../../store/effects'
import type { Oracle } from '../sessions/oracle-support'
import { envelope, submit } from '../sync-write/outbox-test-support'

export type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

/** One relayed agent call, answered. */
export async function relay(
  o: Oracle,
  sessionId: SessionId,
  requestId: string,
  router: string,
  proc: string,
  input: unknown,
): Promise<RelayResult> {
  await o.reg.gateway.routeDaemonFrame(o.store.hostMachineId, {
    type: 'agentRelayRequest',
    requestId,
    sessionId,
    router,
    proc,
    input,
  })
  const answered = (): RelayResult | undefined =>
    o.daemon.find(
      (msg): msg is RelayResult => msg.type === 'agentRelayResult' && msg.requestId === requestId,
    )
  await vi.waitFor(() => expect(answered()).toBeDefined())
  return answered() as RelayResult
}

/** An agent session in an issue's worktree, so its request targets the issue. */
export async function agentOnIssue(o: Oracle, title: string): Promise<SessionId> {
  const writer = o.reg.issues.reports.store.serverWriter
  if (!(await o.store.repos.listRepoPaths()).includes('/r')) {
    await o.store.repos.addRepo('/r', o.store.hostMachineId)
  }
  const issue = await o.reg.issues.crud.create(writer, { repoPath: '/r', title, startNow: false })
  const slug = title.replace(/\W+/g, '-')
  await o.reg.issues.crud.update(writer, issue.id, { worktreePath: `/r/.worktrees/${slug}` })
  const cwd = (await o.reg.issues.reports.get(issue.id))?.worktreePath as string
  return (await o.reg.modules.sessions.createSession({ cwd, agentKind: 'shell' })).sessionId
}

/** An agent asks for `op`, as `podium approval` does; answers the record id. */
export async function askFor(
  o: Oracle,
  op: ApprovalOp,
  sessionId?: SessionId,
): Promise<{ id: string; sessionId: SessionId }> {
  const asker = sessionId ?? (await agentOnIssue(o, `asks ${crypto.randomUUID().slice(0, 8)}`))
  const answer = await relay(o, asker, `r-${crypto.randomUUID()}`, 'approvals', 'request', { op })
  if (!answer.ok) throw new Error(`the request was refused: ${JSON.stringify(answer)}`)
  return { id: (answer.result as { id: string }).id, sessionId: asker }
}

/** The approval records waiting for a person. */
export const awaiting = async (o: Oracle): Promise<EffectRow[]> =>
  await o.store.effects.listAwaiting('approval', 500)

export async function record(o: Oracle, id: string): Promise<EffectRow> {
  const row = await o.store.effects.get(id)
  if (row === undefined) throw new Error(`no effect record ${id}`)
  return row
}

export const inputOf = (row: EffectRow): ApprovalEffectInput => row.input as ApprovalEffectInput

/** The person's decision, as the app sends it: a generic edit at the shown revision. */
export async function decide(
  o: Oracle,
  id: string,
  decision: 'approve' | 'deny',
  opts: { mutationId?: string; revision?: number } = {},
): Promise<SyncSubmitReply> {
  const revision = opts.revision ?? (await o.store.effects.get(id))?.revision ?? 1
  return await submit(
    o,
    envelope(
      'records.effect.edit',
      { id, patch: { decision }, expectedRevision: revision },
      opts.mutationId ?? `m-${crypto.randomUUID()}`,
    ),
  )
}

/** The exec requests the server sent to the daemon for one record. */
export const execRequests = (o: Oracle, id: string) =>
  o.daemon.filter((m) => m.type === 'approvalExecRequest' && m.requestId === id)

/** The activity events of one request, by kind, oldest first. */
export async function activity(o: Oracle, id: string): Promise<string[]> {
  return (await o.store.events.listEventsSince(0))
    .filter((event) => (event.payload as { approvalId?: string } | undefined)?.approvalId === id)
    .map((event) => event.kind)
}

/** The service's server catalog and mail, for a test to stand in for. */
export const approvalDeps = (o: Oracle) =>
  (
    o.reg.modules.approvals as unknown as {
      deps: {
        executeServerOp: (op: ApprovalOp, sessionId: string) => Promise<string | null>
        notifyIssue: (issueId: string, body: string) => Promise<void>
        hasDaemon: (machineId: string) => boolean
        opPermission: { workflowWrite: (principal: unknown, revisionId: string) => Promise<boolean> }
      }
    }
  ).deps

/** Let the runner's after-commit work finish. */
export async function settled(o: Oracle): Promise<void> {
  await o.reg.modules.effects?.runner.idle()
}
