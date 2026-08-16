import { z } from 'zod'

export const PlatformAsset = z.object({
  url: z.string().min(1),
  digest: z.string().min(1),
  signature: z.string().min(1),
})

export const FeedArtifact = z.object({
  delivery: z.literal('feed'),
  platforms: z.record(z.string(), PlatformAsset),
})

export const BundleArtifact = z.object({
  delivery: z.literal('bundle'),
  platforms: z.record(z.string(), PlatformAsset),
})

export const GitArtifact = z.object({
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

/**
 * WHAT THIS TARGET'S BUILD CAN OPEN (POD-2213).
 *
 * Migrations are forward-only and releases are expand-only, so a build can open
 * a database iff it defines every migration that database has applied. Only the
 * publisher of a target knows that list, and a daemon about to swap the install
 * its co-located server runs from has no other way to find out — so the target
 * carries it, and a target that omits it is one nothing can prove safe.
 *
 * Optional forever: every release published before this existed says nothing,
 * and every machine that owns no database ignores it either way.
 */
export const SchemaDeclaration = z
  .object({
    /** Migration folder names, as the server's drizzle ledger records them. */
    migrations: z.array(z.string()),
  })
  .passthrough()
export type SchemaDeclaration = z.infer<typeof SchemaDeclaration>

export const UpdateTarget = z
  .object({
    version: z.string().min(1),
    schema: SchemaDeclaration.optional(),
    notes: UpdateNotes.optional(),
    critical: z.boolean().default(false),
    minRequired: MinRequired.optional(),
    artifacts: z
      .object({
        headless: UpdateArtifact.optional(),
        /**
         * Ordered fallbacks for daemons that cannot consume the primary
         * headless artifact. Kept separate from `headless` so older daemons
         * continue to see and consume the original descriptor unchanged.
         */
        headlessAlternatives: z.array(UpdateArtifact).optional(),
        desktop: UpdateArtifact.optional(),
        web: z
          .object({ digest: z.string().min(1) })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough()
export type UpdateTarget = z.infer<typeof UpdateTarget>
