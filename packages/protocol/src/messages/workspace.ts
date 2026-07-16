import { z } from 'zod'

/**
 * Lazy cross-machine workspace fetch (POD-658). Nothing is published or
 * persisted ahead of time: the server drives export → chunk transfer (the
 * handoff chunk frames, keyed by fetchId) → import inside ONE fetch request.
 * COPY semantics — the source session stays put; only its working tree is
 * snapshotted (temp index, ref deleted before the export reply goes out).
 */
/** Where fetch materializes peek worktrees, relative to the repo root. Shared
 *  so discovery can exclude peeks from repo scans — a peek is a read-only
 *  artifact, not a workspace, and must never surface in the sidebar or count
 *  as a session home. */
export const WORKSPACE_PEEK_DIR = '.worktrees/.peek'

export const WorkspaceManifest = z.object({
  format: z.literal(1),
  fetchId: z.string(),
  repoId: z.string(),
  branch: z.string(),
  headSha: z.string(),
  snapshotSha: z.string().nullable(),
  worktreeName: z.string(),
  bundleBase: z.array(z.string()),
  sourceMachineId: z.string(),
  exportedAt: z.string(),
})
export type WorkspaceManifest = z.infer<typeof WorkspaceManifest>

export const WorkspaceExportRequestMessage = z.object({
  type: z.literal('workspaceExportRequest'),
  requestId: z.string(),
  fetchId: z.string(),
  cwd: z.string(),
  baseShas: z.array(z.string()),
  repoId: z.string(),
  sourceMachineId: z.string(),
})
export const WorkspaceExportResultMessage = z.object({
  type: z.literal('workspaceExportResult'),
  requestId: z.string(),
  ok: z.boolean(),
  manifest: WorkspaceManifest.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  stagePath: z.string().optional(),
  error: z.string().optional(),
})
export const WorkspaceImportRequestMessage = z.object({
  type: z.literal('workspaceImportRequest'),
  requestId: z.string(),
  fetchId: z.string(),
  repoPath: z.string(),
})
export const WorkspaceImportResultMessage = z.object({
  type: z.literal('workspaceImportResult'),
  requestId: z.string(),
  ok: z.boolean(),
  path: z.string().optional(),
  error: z.string().optional(),
})
export const WorkspaceCleanRequestMessage = z.object({
  type: z.literal('workspaceCleanRequest'),
  requestId: z.string(),
  repoPath: z.string(),
})
export const WorkspaceCleanResultMessage = z.object({
  type: z.literal('workspaceCleanResult'),
  requestId: z.string(),
  ok: z.boolean(),
  removed: z.array(z.string()).optional(),
  error: z.string().optional(),
})
export type WorkspaceExportResultMessage = z.infer<typeof WorkspaceExportResultMessage>
export type WorkspaceImportResultMessage = z.infer<typeof WorkspaceImportResultMessage>
export type WorkspaceCleanResultMessage = z.infer<typeof WorkspaceCleanResultMessage>
