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
export const MobileWebIdentity = z.object({
  /** An exported phone website exists here. Absent means "no phone app", not "stale". */
  present: z.boolean(),
  /** Product version from the phone bundle's build stamp, when the stamp names one. */
  appVersion: z.string().optional(),
  /** Its checkout, in the same currency as `artifacts.web.digest`. */
  digest: z.string().optional(),
})
export type MobileWebIdentity = z.infer<typeof MobileWebIdentity>

export const ServerVersion = z
  .object({
    appVersion: z.string().optional(),
    wireVersion: z.number().int().optional(),
    minSupportedVersion: z.number().int().optional(),
    wireSchemaDigest: z.string().optional(),
    instanceId: z.string().optional(),
    feedScoping: z.string().optional(),
    target: UpdateTarget.optional().catch(undefined),
    mobileWeb: MobileWebIdentity.optional().catch(undefined),
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
