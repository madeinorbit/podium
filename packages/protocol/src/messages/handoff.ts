import { AgentKind, HandoffManifest, ResumeRef } from '@podium/model'
import { z } from 'zod'

// HandoffManifest — the entity-shaped member of this family — lives in
// @podium/model (POD-300). The 7 request/result frames below STAY protocol
// frames: they are transport, not entity.

export const HandoffExportRequestMessage = z.object({
  type: z.literal('handoffExportRequest'),
  requestId: z.string(),
  sessionId: z.string(),
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
  repoId: z.string(),
  title: z.string().optional(),
  issueId: z.string().optional(),
  sourceMachineId: z.string(),
})
export const HandoffExportResultMessage = z.object({
  type: z.literal('handoffExportResult'),
  requestId: z.string(),
  ok: z.boolean(),
  manifest: HandoffManifest.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  stagePath: z.string().optional(),
  error: z.string().optional(),
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
  sessionId: z.string(),
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
  sessionId: z.string(),
  repoPath: z.string(),
  worktreeName: z.string(),
  /** Other resumable sessions on the target machine. Import must not reset a
   *  checkout any of them still owns. Optional for mixed-version daemons. */
  occupiedWorktreePaths: z.array(z.string()).optional(),
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
  error: z.string().optional(),
})
export type HandoffExportResultMessage = z.infer<typeof HandoffExportResultMessage>
export type HandoffChunkReadResultMessage = z.infer<typeof HandoffChunkReadResultMessage>
export type HandoffImportChunkResultMessage = z.infer<typeof HandoffImportChunkResultMessage>
export type HandoffImportResultMessage = z.infer<typeof HandoffImportResultMessage>
