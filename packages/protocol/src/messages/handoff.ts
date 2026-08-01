import {
  AgentIdentityIdField,
  AgentKind,
  Attribution,
  DelegationScope,
  HandoffManifest,
  HandoffRefusalReason,
  IssueIdField,
  MachineIdField,
  Ownership,
  RepoIdField,
  ResumeRef,
  SessionIdField,
  UserIdField,
} from '@podium/model'
import { z } from 'zod'
import { BindingMachineAccess } from './terminal'

// HandoffManifest — the entity-shaped member of this family — lives in
// @podium/model (POD-300). The 10 request/result frames below (five pairs:
// export, chunkRead, importChunk, import, bindingFinalize) STAY protocol frames: they are
// transport, not entity (ADR 4 D4).
//
// `refusal` on the two RESULT frames is vocabulary from @podium/model, not a new
// frame concept: a fail-closed handoff must be distinguishable from a broken one
// (ADR 9 D6 M5). It is OPTIONAL for mixed-version readability; current handoff
// daemons populate it when the fleet authorization interface refuses a leg.

/** The immutable binding operand copied from the source daemon. It deliberately
 * contains no native artifact id and no resolved authorization result. */
export const HandoffBindingTransfer = z.object({
  transferId: z.string().min(1),
  sessionId: SessionIdField,
  agentKind: AgentKind,
  fromMachineId: MachineIdField,
  toMachineId: MachineIdField,
  observationGeneration: z.number().int().nonnegative(),
  delegation: z.object({
    actor: AgentIdentityIdField,
    onBehalfOf: UserIdField,
    grantedScope: DelegationScope,
    parentBindingId: SessionIdField.nullable(),
  }),
})
export type HandoffBindingTransfer = z.infer<typeof HandoffBindingTransfer>

/** Server-authored export instruction. The principal pair comes from the
 * authenticated command transport; the manifest is never allowed to supply it. */
export const HandoffBindingExportInstruction = z.object({
  transitionId: z.string().min(1),
  transferId: z.string().min(1),
  targetMachineId: MachineIdField,
  machineAccess: BindingMachineAccess,
  exportedBy: Attribution,
  owner: UserIdField,
  visibility: Ownership.shape.visibility,
})
export type HandoffBindingExportInstruction = z.infer<typeof HandoffBindingExportInstruction>

export const HandoffBindingImportInstruction = z.object({
  transitionId: z.string().min(1),
  machineAccess: BindingMachineAccess,
  transfer: HandoffBindingTransfer,
})
export type HandoffBindingImportInstruction = z.infer<typeof HandoffBindingImportInstruction>

export const HandoffExportRequestMessage = z.object({
  type: z.literal('handoffExportRequest'),
  requestId: z.string(),
  sessionId: SessionIdField,
  /** The session's stamped cwd — momentary, and it drifts (the daemon follows the
   *  shell). The exporter moves the worktree CONTAINING it ([spec:SP-3f7a]). */
  cwd: z.string(),
  /** The attached issue's worktree, used only when `cwd` has drifted off any
   *  worktree (typically onto the main checkout, which is never a source). */
  fallbackCwd: z.string().optional(),
  agentKind: AgentKind,
  resume: ResumeRef,
  branch: z.string(),
  baseShas: z.array(z.string()),
  repoId: RepoIdField,
  title: z.string().optional(),
  issueId: IssueIdField.optional(),
  sourceMachineId: z.string(),
  /** Optional on the wire for old-frame readability; a current daemon refuses
   * an export without this authenticated server instruction. */
  binding: HandoffBindingExportInstruction.optional(),
})
export const HandoffExportResultMessage = z.object({
  type: z.literal('handoffExportResult'),
  requestId: z.string(),
  ok: z.boolean(),
  manifest: HandoffManifest.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  stagePath: z.string().optional(),
  binding: HandoffBindingTransfer.optional(),
  error: z.string().optional(),
  /** Why the export was refused, when it was. `use` gates the SOURCE machine
   *  too, so an export can be denied for the same reason an accept can. */
  refusal: HandoffRefusalReason.optional(),
})
export const HandoffChunkReadRequestMessage = z.object({
  type: z.literal('handoffChunkReadRequest'),
  requestId: z.string(),
  stagePath: z.string(),
  offset: z.number().int().nonnegative(),
  length: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024),
})
export const HandoffChunkReadResultMessage = z.object({
  type: z.literal('handoffChunkReadResult'),
  requestId: z.string(),
  ok: z.boolean(),
  data: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  eof: z.boolean().optional(),
  error: z.string().optional(),
})
export const HandoffImportChunkMessage = z.object({
  type: z.literal('handoffImportChunk'),
  requestId: z.string(),
  sessionId: SessionIdField,
  offset: z.number().int().nonnegative(),
  data: z.string().max(12 * 1024 * 1024),
})
export const HandoffImportChunkResultMessage = z.object({
  type: z.literal('handoffImportChunkResult'),
  requestId: z.string(),
  ok: z.boolean(),
  sizeBytes: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
})
export const HandoffImportRequestMessage = z.object({
  type: z.literal('handoffImportRequest'),
  requestId: z.string(),
  sessionId: SessionIdField,
  repoPath: z.string(),
  worktreeName: z.string(),
  /** Other resumable sessions on the target machine. Import must not reset a
   *  checkout any of them still owns. Optional for mixed-version daemons. */
  occupiedWorktreePaths: z.array(z.string()).optional(),
  /** Payload identity in the manifest is inert. This server-authored capsule is
   * the only source of the imported binding's delegation. */
  binding: HandoffBindingImportInstruction.optional(),
})
export const HandoffImportResultMessage = z.object({
  type: z.literal('handoffImportResult'),
  requestId: z.string(),
  ok: z.boolean(),
  /** Where the agent resumes: the worktree root, or a subdir of it when the
   *  session carried a `cwdSubpath`. */
  newCwd: z.string().optional(),
  /** The worktree itself, which `newCwd` may sit inside. The issue's home is the
   *  ROOT, never the drifted subdir ([spec:SP-3f7a]) — and the daemon owns the
   *  layout that decides it, so it reports the root rather than letting the server
   *  re-derive it by stripping `cwdSubpath`. Optional: an older daemon omits it,
   *  and the server then leaves the issue's home alone rather than guessing. */
  worktreeRoot: z.string().optional(),
  /** Generation established by the import-time ADOPT claim. */
  observationGeneration: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  /** Why the accept was refused, when it was: `unauthorized` (no `use` on this
   *  machine) vs `unreachable` (offline) vs `unknown-target` — the arm a target
   *  outside the principal's `see` set shares with a nonexistent id, so the
   *  refusal cannot be read as an existence oracle. Never RETARGET on a refusal
   *  (ADR 9 D6 M5); `error` stays the human-readable half. */
  refusal: HandoffRefusalReason.optional(),
})
export const HandoffBindingFinalizeRequestMessage = z.object({
  type: z.literal('handoffBindingFinalizeRequest'),
  requestId: z.string(),
  sessionId: SessionIdField,
  transitionId: z.string().min(1),
  machineAccess: BindingMachineAccess,
  transferId: z.string().min(1),
  role: z.enum(['source', 'target']),
  phase: z.enum(['commit', 'abort']),
  fromMachineId: MachineIdField,
  toMachineId: MachineIdField,
})
export const HandoffBindingFinalizeResultMessage = z.object({
  type: z.literal('handoffBindingFinalizeResult'),
  requestId: z.string(),
  ok: z.boolean(),
  observationGeneration: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  refusal: HandoffRefusalReason.optional(),
})
export type HandoffExportResultMessage = z.infer<typeof HandoffExportResultMessage>
export type HandoffChunkReadResultMessage = z.infer<typeof HandoffChunkReadResultMessage>
export type HandoffImportChunkResultMessage = z.infer<typeof HandoffImportChunkResultMessage>
export type HandoffImportResultMessage = z.infer<typeof HandoffImportResultMessage>
export type HandoffBindingFinalizeResultMessage = z.infer<
  typeof HandoffBindingFinalizeResultMessage
>
