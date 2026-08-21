import { z } from 'zod'

export const PlatformAsset = z.object({
  url: z.string().min(1),
  digest: z.string().min(1),
  signature: z.string().min(1),
})

/**
 * THE ONLY DELIVERY KIND (spec §1, disposition 5).
 *
 * There used to be three. `bundle` named "a tarball the source server packed
 * and pushed", `git` named "converge a checkout to a sha", and `feed` named
 * "download the signed artifact a manifest points at". Two of those described
 * WHO minted the bytes rather than HOW they arrive, which is why trust selection
 * ended up keyed on the delivery kind — the mistake this retirement closes.
 *
 * `dev` is now a pulled feed like every other channel, so the artifact is
 * fetched exactly the same way on all three and the trust root is a fact about
 * the CHANNEL ({@link UpdateTrustRoot}). `git` goes with it: exactly one machine
 * runs from source — the publisher — and it is not a fleet consumer.
 *
 * The discriminated union is kept, single-armed. A one-kind union still parses
 * `{ delivery: 'bundle' }` as a REFUSAL rather than silently accepting it, and
 * leaves the axis named for whatever a later delivery kind turns out to be.
 */
export const FeedArtifact = z.object({
  delivery: z.literal('feed'),
  platforms: z.record(z.string(), PlatformAsset),
})

export const UpdateArtifact = z.discriminatedUnion('delivery', [FeedArtifact])
export type UpdateArtifact = z.infer<typeof UpdateArtifact>

/**
 * WHICH KEY A VERIFIER MUST TRUST FOR THIS TARGET'S ARTIFACTS.
 *
 * `release` is the baked Podium release key that ships in every build;
 * `instance` is the Ed25519 key a daemon pinned when it paired with its server.
 * Edge and stable resolve to the first, `dev` to the second (spec §1).
 *
 * RESOLVER-OWNED, NEVER MANIFEST-DECLARED. A manifest is an advertisement
 * fetched off a network, so letting one name its own trust root would let a
 * release-channel feed nominate a key Podium never shipped. The resolver stamps
 * this from the channel it asked for and REFUSES a manifest that carries the
 * field at all — see `release-target.ts`.
 *
 * Optional forever, and absent means `release`: every manifest published before
 * this existed says nothing, and the baked key is the narrower reading of
 * silence — a dev artifact verified against it simply fails.
 */
export const UpdateTrustRoot = z.enum(['release', 'instance'])
export type UpdateTrustRoot = z.infer<typeof UpdateTrustRoot>

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
    /** Minimum native shell bridge contract understood by this payload. */
    desktopBridge: z.number().int().nonnegative().optional(),
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
    /**
     * Stamped by the resolver from the channel it asked for; see
     * {@link UpdateTrustRoot}. A fetched manifest that declares it is refused.
     */
    trust: UpdateTrustRoot.optional(),
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
