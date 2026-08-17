import { createHash } from 'node:crypto'
import type { MinRequired } from '@podium/protocol'

export type PreparedManifestPlatform = {
  target: string
  url: string
  signature: string
  bytes: Uint8Array
}

type PlatformAsset = Omit<PreparedManifestPlatform, 'target' | 'bytes'> & { digest: string }

type FeedArtifact = {
  delivery: 'feed'
  platforms: Record<string, PlatformAsset>
}

export type ReleaseManifest = {
  version: string
  /** The legacy updater shape consumed by `podium update` and the Tauri updater. */
  platforms: Record<string, Omit<PlatformAsset, 'digest'>>
  /** The additive target-descriptor shape consumed by the update story. */
  artifacts: {
    headless?: FeedArtifact
    web?: { digest: string }
    [name: string]: unknown
  }
  notes?: { summary: string }
  critical?: true
  minRequired?: MinRequired
  web?: { digest: string }
  /**
   * The migrations this release's build defines (POD-2213).
   *
   * A machine converging BACKWARDS needs to know whether the build it is about
   * to swap in can open the database it already has — a build that lacks a
   * migration the database applied refuses to start, and from there nothing
   * inside Podium can put the newer build back. The publisher is the only party
   * that knows this list, so the manifest carries it.
   */
  schema?: { migrations: string[] }
}

export function sha256Digest(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(Buffer.from(bytes)).digest('base64')}`
}

/**
 * Build both the legacy feed manifest and the additive UpdateTarget fields.
 * Every headless platform is present in the descriptor. The legacy top-level
 * `platforms` map remains unchanged for existing updater consumers.
 */
export function buildManifest(input: {
  version: string
  platforms: PreparedManifestPlatform[]
  notes: { summary: string } | null
  critical: boolean
  minRequired?: MinRequired
  webDigest?: string
  /** Migration folder names this build defines; absent means "did not say". */
  schemaMigrations?: string[]
}): ReleaseManifest {
  const platforms = Object.fromEntries(
    input.platforms.map(({ target, url, signature }) => [target, { url, signature }]),
  )
  const headlessPlatforms = Object.fromEntries(
    input.platforms.map(({ target, url, signature, bytes }) => [
      target,
      { url, signature, digest: sha256Digest(bytes) },
    ]),
  )
  const headless =
    input.platforms.length > 0
      ? { delivery: 'feed' as const, platforms: headlessPlatforms }
      : undefined

  return {
    version: input.version,
    platforms,
    ...(input.schemaMigrations ? { schema: { migrations: input.schemaMigrations } } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.critical ? { critical: true as const } : {}),
    ...(input.minRequired ? { minRequired: input.minRequired } : {}),
    ...(input.webDigest ? { web: { digest: input.webDigest } } : {}),
    artifacts: {
      ...(headless ? { headless } : {}),
      ...(input.webDigest ? { web: { digest: input.webDigest } } : {}),
    },
  }
}
