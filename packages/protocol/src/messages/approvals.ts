import { AgentKind, IssueIdField, MachineIdField, SessionIdField } from '@podium/model'
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

/**
 * The channels a brokered `podium channel <target>` may name (POD-2199).
 *
 * WIDENED, NOT OPENED. `target` is the one brokered parameter that reaches a
 * command line verbatim (`approvalArgv` → `podium channel <target>`), so the set
 * stays CLOSED — a `z.string()` here would hand an agent the argv the closed
 * catalog above exists to deny. `dev` is added as a literal because it is not a
 * new value in this system: `FleetUpdateChannel`, the config schema
 * (`updateChannel`) and the fleet tRPC input (`setupSetChannelInput`) all
 * already range over it, and it is the ONLY channel a source checkout's own
 * `dev+<sha>` target is ever published on. This enum was the last holdout, which
 * is why an AGENT session could not pin its own machine to the channel its
 * target appears on while an operator could (POD-2198 fixed the operator half).
 *
 * Exported so the CLI planner validates against the wire instead of repeating
 * the literals — one source of truth for what the broker will accept.
 */
export const ApprovalChannelTarget = z.enum(['stable', 'edge', 'dev'])
export type ApprovalChannelTarget = z.infer<typeof ApprovalChannelTarget>

/** The closed catalog of brokered management operations (v1). */
export const ApprovalOp = z.discriminatedUnion('kind', [
  // Self-update the podium install from the configured channel feed.
  z.object({ kind: z.literal('update') }),
  // Show is direct; SWITCHING the update channel is brokered.
  z.object({ kind: z.literal('channel'), target: ApprovalChannelTarget }),
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
  z.object({
    kind: z.literal('automation-schedule'),
    name: z.string().min(1),
    runAt: z.string().datetime({ offset: true }),
    prompt: z.string().min(1),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('current') }),
      z.object({ kind: z.literal('session'), sessionId: z.string().min(1).pipe(SessionIdField) }),
      z.object({
        kind: z.literal('fresh'),
        repoPath: z.string().min(1),
        /** OPTIONAL, and validated when present (POD-1107). Absent means "the
         *  operator's configured default", which the server answers with
         *  `resolveSpawnDefaults` — the same answer issue-create gets. It was
         *  required here while the automations wire left the kind unvalidated,
         *  which is the pair of divergences POD-1107 closes: the enum is kept
         *  because a REQUESTER naming a harness is naming one this build ships. */
        agentKind: AgentKind.optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
      }),
    ]),
  }),
])
export type ApprovalOp = z.infer<typeof ApprovalOp>

export const ApprovalStatus = z.enum(['pending', 'denied', 'executing', 'succeeded', 'failed'])
export type ApprovalStatus = z.infer<typeof ApprovalStatus>

/**
 * AN APPROVAL IS AN EFFECT RECORD WITH A HUMAN GATE (POD-6674, ADR 12 D5 E2).
 *
 * The agent's request is an `effect` row of kind `approval` (`APPROVAL_EFFECT_KIND`),
 * synced to every device of the people who may see it. Its target is the
 * requesting issue (the session when it has none); its input is
 * {@link ApprovalEffectInput}. It waits `pending` (stage `awaiting-approval`)
 * with `decision: null` until its person decides: `approve` lets the effect
 * trigger run it (`running`, stage `executing`, then `succeeded` or `failed`),
 * `deny` ends it `cancelled`. There is no deadline: it waits as long as it takes.
 *
 * {@link ApprovalWire} below is no longer a client read model. It is the answer
 * the requesting agent's CLI reads over the issue relay (`approvals.get`, which
 * it polls while it blocks), so its status vocabulary stays the one the CLI on
 * every machine already prints: {@link approvalStatusOf} maps the record onto it.
 */

/** What an approval record asks for, and from where (the relay binds both ids). */
export const ApprovalEffectInput = z
  .object({
    op: ApprovalOp,
    machineId: MachineIdField,
    sessionId: SessionIdField,
    issueId: IssueIdField.nullable(),
  })
  .strict()
export type ApprovalEffectInput = z.infer<typeof ApprovalEffectInput>

/**
 * The CLI's status word for an approval record. `cancelled` is a denial;
 * `expired` and `unknown` (the executor lost track) read as `failed`, whose
 * result text says which.
 */
export function approvalStatusOf(
  status: string,
  decision: 'approve' | 'deny' | null | undefined,
): ApprovalStatus {
  switch (status) {
    case 'pending':
      return decision === 'approve' ? 'executing' : 'pending'
    case 'running':
      return 'executing'
    case 'succeeded':
      return 'succeeded'
    case 'cancelled':
      return 'denied'
    default:
      return 'failed'
  }
}

/** One approval request as the requesting agent's CLI reads it (`approvals.get`). */
export const ApprovalWire = z.object({
  id: z.string(),
  machineId: MachineIdField,
  machineName: z.string().optional(),
  sessionId: SessionIdField,
  /** The issue the requesting session was attached to (navigation target). */
  issueId: IssueIdField.nullable(),
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
    case 'automation-schedule': {
      const target =
        op.target.kind === 'current'
          ? 'this session'
          : op.target.kind === 'session'
            ? `session ${op.target.sessionId}`
            : `a new ${op.target.agentKind} session in ${op.target.repoPath}`
      return `schedule “${op.name}” for ${op.runAt}, targeting ${target}: ${op.prompt}`
    }
  }
}
