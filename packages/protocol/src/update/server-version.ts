import { z } from 'zod'
import { UpdateTarget } from './target'

/**
 * The phone website this server serves, as the server sees it on disk (POD-1980).
 *
 * The desktop shell can read its OWN stamp from `/podium-build.json`; nobody can
 * read the phone's that way, because a page fetching `/mobile/podium-build.json`
 * gets the same 404 whether the export is stale-without-a-stamp or was never
 * built at all — and those two need opposite verdicts. The server can tell them
 * apart (index.html is either there or it is not), so the server is what says so.
 */
export const ServedWebIdentity = z.object({
  /** A website exists here. Absent means "no app of this kind", not "stale". */
  present: z.boolean(),
  /** Product version from its build stamp, when the stamp names one. */
  appVersion: z.string().optional(),
  /** Its checkout, in the same currency as `artifacts.web.digest`. */
  digest: z.string().optional(),
  /**
   * `bundle+<entry chunk hash>` from its build stamp (POD-2721).
   *
   * A SECOND IDENTITY, not a finer one. `digest` is the checkout — what an
   * update is trying to move. This is the bytes, and it is the only one that
   * decides whether a page loaded from an earlier build can still resolve the
   * URLs it is holding: the entry chunk fingerprints the whole module graph,
   * because a lazy chunk's hash appears inside it as an import specifier.
   *
   * The two come apart, and POD-2721 is the case where they did: a packaged
   * `0.1.1-edge.2` and a dev release `0.1.1-dev.1+a55ec3d` built from the SAME
   * commit `a55ec3d` were served in turn, so the checkout never moved while
   * every lazy chunk's URL did.
   */
  bundle: z.string().optional(),
})
export type ServedWebIdentity = z.infer<typeof ServedWebIdentity>

/**
 * The phone website this server serves, as the server sees it on disk (POD-1980).
 *
 * ONE SHAPE, TWO WEBSITES. This is the same idea as {@link ServedWebIdentity}
 * pointed at the other dist, and it is deliberately the same type: they are read
 * by the same code, compared the same way, and a second copy of the shape is a
 * second answer waiting to disagree. The name is kept because the field on
 * `/version` is named for the website it describes.
 */
export const MobileWebIdentity = ServedWebIdentity
export type MobileWebIdentity = ServedWebIdentity

export const ServerVersion = z
  .object({
    appVersion: z.string().optional(),
    /** Whether this process can consume a packaged coordinator update. */
    installKind: z.enum(['installed', 'source']).optional().catch(undefined),
    /** Server source identity, in the same currency as `target.artifacts.web.digest`. */
    sourceDigest: z.string().optional(),
    wireVersion: z.number().int().optional(),
    minSupportedVersion: z.number().int().optional(),
    wireSchemaDigest: z.string().optional(),
    instanceId: z.string().optional(),
    feedScoping: z.string().optional(),
    target: UpdateTarget.optional().catch(undefined),
    mobileWeb: MobileWebIdentity.optional().catch(undefined),
    web: ServedWebIdentity.optional().catch(undefined),
  })
  .passthrough()
export type ServerVersion = z.infer<typeof ServerVersion>

export function parseServerVersion(raw: unknown): ServerVersion {
  const parsed = ServerVersion.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

export type SkewVerdict = 'ok' | 'client-too-old' | 'client-too-new' | 'schema-skew'

export function classifySkew(
  server: ServerVersion,
  local: { wire: number; digest: string },
): SkewVerdict {
  const { wireVersion, minSupportedVersion, wireSchemaDigest } = server
  if (minSupportedVersion !== undefined && local.wire < minSupportedVersion) return 'client-too-old'
  if (wireVersion !== undefined && local.wire > wireVersion) return 'client-too-new'
  if (wireVersion !== undefined && local.wire < wireVersion) return 'client-too-old'
  if (wireSchemaDigest !== undefined && wireSchemaDigest !== local.digest) return 'schema-skew'
  return 'ok'
}

/**
 * Has the website this page was loaded from been replaced underneath it?
 *
 * `replaced` means the server is serving a DIFFERENT build from the one running
 * this page, so some of the URLs this page holds may already be gone. It says
 * nothing about which build is newer, and deliberately so: POD-2721 produced one
 * crash in each direction — a page from the old build after the update landed,
 * and a page from the new build after the coordinator rolled back — and an
 * ordering test would have caught only the first.
 *
 * `unknown` is the answer whenever either end cannot name its build, and it is
 * the reason this can be acted on. A comparison that guessed here would offer a
 * reload against evidence it does not have, which is the shape of the reload
 * loop POD-2608 paid for. Nothing is ever reported as replaced without both
 * names in hand.
 */
export type AssetVerdict = 'ok' | 'unknown' | 'replaced'

/**
 * THE CALLER CHOOSES WHICH WEBSITE. A server serves two of them — the desktop
 * dist and the phone export — and a page belongs to exactly one. Comparing a
 * page against the wrong one is not a near-miss: the two are built by different
 * toolchains and will never share an entry hash, so it would report `replaced`
 * forever and offer a reload that changes nothing. That is the POD-2608 failure
 * with a new cause, so the choice is made where the page's own identity is
 * known and this function is handed only the pair it should compare.
 */
export function classifyAssets(
  served: ServedWebIdentity | undefined,
  page: { bundle?: string },
): AssetVerdict {
  if (served?.present !== true) return 'unknown'
  if (served.bundle === undefined || page.bundle === undefined) return 'unknown'
  return served.bundle === page.bundle ? 'ok' : 'replaced'
}
