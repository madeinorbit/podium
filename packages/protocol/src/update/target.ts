import { z } from 'zod'

export const PlatformAsset = z
  .object({
    url: z.string().min(1),
    digest: z.string().min(1),
    signature: z.string().min(1),
  })

export const FeedArtifact = z
  .object({
    delivery: z.literal('feed'),
    platforms: z.record(z.string(), PlatformAsset),
  })

export const BundleArtifact = z
  .object({
    delivery: z.literal('bundle'),
    platforms: z.record(z.string(), PlatformAsset),
  })

export const GitArtifact = z
  .object({
    delivery: z.literal('git'),
    repo: z.string().min(1),
    sha: z.string().min(1),
  })

export const UpdateArtifact = z.discriminatedUnion('delivery', [
  FeedArtifact,
  BundleArtifact,
  GitArtifact,
])
export type UpdateArtifact = z.infer<typeof UpdateArtifact>

export const UpdateNotes = z
  .object({
    summary: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough()
export type UpdateNotes = z.infer<typeof UpdateNotes>

export const MinRequired = z
  .object({
    desktop: z.string().optional(),
    web: z.string().optional(),
    mobile: z
      .object({ ios: z.string().optional(), android: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()
export type MinRequired = z.infer<typeof MinRequired>

export const UpdateTarget = z
  .object({
    version: z.string().min(1),
    notes: UpdateNotes.optional(),
    critical: z.boolean().default(false),
    minRequired: MinRequired.optional(),
    artifacts: z
      .object({
        headless: UpdateArtifact.optional(),
        desktop: UpdateArtifact.optional(),
        web: z.object({ digest: z.string().min(1) }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough()
export type UpdateTarget = z.infer<typeof UpdateTarget>
