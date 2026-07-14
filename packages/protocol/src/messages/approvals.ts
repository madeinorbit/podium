import { z } from 'zod'

/**
 * Approval broker [spec:SP-edbb] — agent-initiated management operations.
 *
 * An agent session may INITIATE any podium management op, but never executes it:
 * the CLI call becomes an approval request (over the issue relay), the user
 * approves/denies in the web UI, and on approval either the owning daemon or a
 * closed server-side handler executes it. The op catalog below is closed and
 * typed — an agent cannot smuggle
 * arbitrary argv through the broker.
 */

/** The closed catalog of brokered management operations (v1). */
export const ApprovalOp = z.discriminatedUnion('kind', [
  // Self-update the podium install from the configured channel feed.
  z.object({ kind: z.literal('update') }),
  // Show is direct; SWITCHING the update channel is brokered.
  z.object({ kind: z.literal('channel'), target: z.enum(['stable', 'edge']) }),
  // Stop the managed podium processes on the machine.
  z.object({ kind: z.literal('stop') }),
  // Repoint the daemon at another server (trust-topology change — the UI must
  // render the target URL, not just the op name).
  z.object({ kind: z.literal('set-server'), target: z.string().min(1) }),
  // Workflow publication/default changes affect agents beyond the requesting
  // session, so the server applies them only after an operator decision.
  z.object({ kind: z.literal('workflow-publish'), revisionId: z.string().min(1) }),
  z.object({
    kind: z.literal('workflow-set-default'),
    targetKind: z.enum(['global', 'repository']),
    targetId: z.string(),
    revisionId: z.string().min(1),
  }),
])
export type ApprovalOp = z.infer<typeof ApprovalOp>

export const ApprovalStatus = z.enum(['pending', 'denied', 'executing', 'succeeded', 'failed'])
export type ApprovalStatus = z.infer<typeof ApprovalStatus>

/** One approval request as the web UI / CLI sees it. */
export const ApprovalWire = z.object({
  id: z.string(),
  machineId: z.string(),
  machineName: z.string().optional(),
  sessionId: z.string(),
  /** The issue the requesting session was attached to (navigation target). */
  issueId: z.string().nullable(),
  issueSeq: z.number().nullable(),
  /** Human-facing nice id of the issue (#474), e.g. `POD-13`. Absent on rows
   *  from a server that predates it or when the repo has no prefix. */
  issueDisplayRef: z.string().optional(),
  issueTitle: z.string().nullable(),
  op: ApprovalOp,
  status: ApprovalStatus,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  /** Result of execution (trimmed output / error), once terminal. */
  resultText: z.string().nullable(),
})
export type ApprovalWire = z.infer<typeof ApprovalWire>

/** server → daemon: execute an approved op (the daemon spawns the podium binary). */
export const ApprovalExecRequestMessage = z.object({
  type: z.literal('approvalExecRequest'),
  requestId: z.string(),
  op: ApprovalOp,
})
export type ApprovalExecRequestMessage = z.infer<typeof ApprovalExecRequestMessage>

/** daemon → server: execution outcome. `podium update` exit codes are load-bearing
 *  (10 = updated, 0 = already current, else failure) — `ok` folds that in. */
export const ApprovalExecResultMessage = z.object({
  type: z.literal('approvalExecResult'),
  requestId: z.string(),
  ok: z.boolean(),
  exitCode: z.number().nullable(),
  output: z.string(),
})
export type ApprovalExecResultMessage = z.infer<typeof ApprovalExecResultMessage>

/** server → web: snapshot of undecided approval requests (small; pending only). */
export const ApprovalsChangedMessage = z.object({
  type: z.literal('approvalsChanged'),
  pending: z.array(ApprovalWire),
})
export type ApprovalsChangedMessage = z.infer<typeof ApprovalsChangedMessage>

/** Human-readable one-liner for an op — shared by UI, CLI and the activity log. */
export function describeApprovalOp(op: ApprovalOp): string {
  switch (op.kind) {
    case 'update':
      return 'update podium (self-update from the configured channel)'
    case 'channel':
      return `switch the update channel to "${op.target}"`
    case 'stop':
      return 'stop the podium processes on this machine'
    case 'set-server':
      return `repoint the daemon at server ${op.target}`
    case 'workflow-publish':
      return `publish global workflow revision ${op.revisionId}`
    case 'workflow-set-default':
      return `set the ${op.targetKind} workflow default${op.targetId ? ` for ${op.targetId}` : ''} to revision ${op.revisionId}`
  }
}
