import { z } from 'zod'

export const ARTIFACT_FILE_CAP_BYTES = 100 * 1024 * 1024
export const ARTIFACT_BUNDLE_CAP_BYTES = 500 * 1024 * 1024
export const ARTIFACT_FILE_COUNT_CAP = 200
// Base64 plus the command envelope stays below the agent relay's 1 MB cap.
export const ARTIFACT_UPLOAD_CHUNK_BYTES = 512 * 1024

const uploadId = z.string().uuid()
export const ArtifactUploadPacket = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('begin'),
    uploadId,
    path: z.string().min(1).max(2048),
    title: z.string().max(2048).optional(),
    entry: z.string().min(1).max(512),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(512),
          size: z.number().int().min(0).max(ARTIFACT_FILE_CAP_BYTES),
        }),
      )
      .min(1)
      .max(ARTIFACT_FILE_COUNT_CAP),
  }),
  z.object({
    action: z.literal('chunk'),
    uploadId,
    file: z.string().min(1).max(512),
    offset: z.number().int().min(0).max(ARTIFACT_FILE_CAP_BYTES),
    dataBase64: z.string().max(Math.ceil(ARTIFACT_UPLOAD_CHUNK_BYTES / 3) * 4),
  }),
  z.object({ action: z.literal('commit'), uploadId }),
  z.object({ action: z.literal('abort'), uploadId }),
])
export type ArtifactUploadPacket = z.infer<typeof ArtifactUploadPacket>
