import { z } from 'zod'

// ---- Daemon <-> server: file/directory ops on a session's host ----
export const FileReadRequestMessage = z.object({
  type: z.literal('fileReadRequest'),
  requestId: z.string(),
  cwd: z.string(),
  path: z.string(),
  /** Server-asserted: this path is in the session transcript-known set, so the
   *  daemon may read it even if it resolves outside the cwd. Read-only. */
  knownPath: z.boolean(),
})
export type FileReadRequestMessage = z.infer<typeof FileReadRequestMessage>

export const FileAssetRequestMessage = z.object({
  type: z.literal('fileAssetRequest'),
  requestId: z.string(),
  cwd: z.string(),
  path: z.string(),
  /** Server-asserted transcript-known path; allows reading outside cwd. Read-only. */
  knownPath: z.boolean(),
})
export type FileAssetRequestMessage = z.infer<typeof FileAssetRequestMessage>

export const FileWriteRequestMessage = z.object({
  type: z.literal('fileWriteRequest'),
  requestId: z.string(),
  cwd: z.string(),
  path: z.string(),
  content: z.string(),
  baseHash: z.string().optional(),
})
export type FileWriteRequestMessage = z.infer<typeof FileWriteRequestMessage>

export const DirListRequestMessage = z.object({
  type: z.literal('dirListRequest'),
  requestId: z.string(),
  /** Containment root — the daemon enforces the listed path stays inside it. */
  root: z.string(),
  /** Directory to list; equal to or nested under `root`. */
  path: z.string(),
})
export type DirListRequestMessage = z.infer<typeof DirListRequestMessage>

// Image upload: the web client sends the base64-encoded image; the daemon
// writes it to ~/.podium/uploads/<sessionId>/<id>.<ext> and returns the
// absolute path so it can be pasted into an agent prompt.
export const ImageUploadRequestMessage = z.object({
  type: z.literal('imageUploadRequest'),
  requestId: z.string(),
  sessionId: z.string(),
  /** Original filename — informational only; the daemon derives the path from mime + id. */
  filename: z.string(),
  mimeType: z.string(),
  /** Base64-encoded file contents. Capped at 10 MiB base64 (~7.5 MiB decoded). */
  dataBase64: z.string().max(10 * 1024 * 1024),
})
export const ImageUploadResultMessage = z.object({
  type: z.literal('imageUploadResult'),
  requestId: z.string(),
  /** Absolute path on the daemon host where the file was written. Empty on failure. */
  path: z.string(),
  /** Set when the daemon failed to write the file; absent on success. */
  error: z.string().optional(),
})

export const FileReadResultMessage = z.object({
  type: z.literal('fileReadResult'),
  requestId: z.string(),
  ok: z.boolean(),
  path: z.string(),
  content: z.string().optional(),
  /** `${mtimeMs}:${size}` snapshot, echoed back on write to detect conflicts. */
  baseHash: z.string().optional(),
  tooLarge: z.boolean().optional(),
  binary: z.boolean().optional(),
  error: z.string().optional(),
})
export type FileReadResultMessage = z.infer<typeof FileReadResultMessage>

export const FileAssetResultMessage = z.object({
  type: z.literal('fileAssetResult'),
  requestId: z.string(),
  ok: z.boolean(),
  path: z.string(),
  /** Base64-encoded file bytes (images etc.). */
  dataBase64: z.string().optional(),
  contentType: z.string().optional(),
  tooLarge: z.boolean().optional(),
  error: z.string().optional(),
})
export type FileAssetResultMessage = z.infer<typeof FileAssetResultMessage>

export const FileWriteResultMessage = z.object({
  type: z.literal('fileWriteResult'),
  requestId: z.string(),
  ok: z.boolean(),
  baseHash: z.string().optional(),
  conflict: z.boolean().optional(),
  error: z.string().optional(),
})
export type FileWriteResultMessage = z.infer<typeof FileWriteResultMessage>

export const DirEntry = z.object({ name: z.string(), isDir: z.boolean() })
export type DirEntry = z.infer<typeof DirEntry>

export const DirListResultMessage = z.object({
  type: z.literal('dirListResult'),
  requestId: z.string(),
  ok: z.boolean(),
  /** The resolved directory that was listed (realpath of the request path). */
  path: z.string(),
  entries: z.array(DirEntry).default([]),
  error: z.string().optional(),
})
export type DirListResultMessage = z.infer<typeof DirListResultMessage>
