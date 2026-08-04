import { z } from 'zod'
import { UpdateTarget } from './target'

export const ServerVersion = z
  .object({
    appVersion: z.string().optional(),
    wireVersion: z.number().int().optional(),
    minSupportedVersion: z.number().int().optional(),
    wireSchemaDigest: z.string().optional(),
    instanceId: z.string().optional(),
    feedScoping: z.string().optional(),
    target: UpdateTarget.optional().catch(undefined),
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
