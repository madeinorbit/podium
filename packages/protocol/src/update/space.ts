import { z } from 'zod'

/** Informational only. This capability is independent of update delivery/admission. */
export const UPDATE_SPACE_CAPABILITY = 'update.space-check.v1'
export const UPDATE_SPACE_TIMEOUT_MS = 5_000

const bytes = z.number().int().nonnegative().safe()
export const UpdateSpaceVolume = z.object({
  path: z.string(),
  availableBytes: bytes,
  peakBytes: bytes,
  requiredBytes: bytes,
  shortfallBytes: bytes,
})
export type UpdateSpaceVolume = z.infer<typeof UpdateSpaceVolume>

export const UpdateSpaceEstimate = z.object({
  status: z.enum(['enough', 'low', 'unknown']),
  checkedAt: z.number().int().nonnegative(),
  /** All figures are estimates; sufficient space is never a promise of success. */
  volumes: z.array(UpdateSpaceVolume).max(16),
  reason: z.string().max(256).optional(),
})
export type UpdateSpaceEstimate = z.infer<typeof UpdateSpaceEstimate>

export const UpdateSpacePreview = z.object({
  machines: z
    .array(
      UpdateSpaceEstimate.extend({
        machineId: z.string(),
        name: z.string(),
        targetVersion: z.string(),
      }),
    )
    .max(256),
})
export type UpdateSpacePreview = z.infer<typeof UpdateSpacePreview>

export function unknownUpdateSpace(reason: string): UpdateSpaceEstimate {
  return { status: 'unknown', checkedAt: Date.now(), volumes: [], reason }
}
