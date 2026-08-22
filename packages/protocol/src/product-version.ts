/**
 * THE ONE PRODUCT VERSION OPERATORS LOOK AT.
 *
 * Update, `/version`, About, and log field `v` must print the same string.
 * Channel / packaged builds use `PODIUM_APP_VERSION` (e.g. `0.4.2`). A source
 * host uses `dev+<git rev-parse --short=7 HEAD>`. Neither the protocol digest
 * nor the Vite entry-chunk hash is this string — those stay on the stamp as
 * other fields so a crash stack can still be matched by eye.
 *
 * `-dirty` is not part of this identity. A dest bundle is only published from a
 * clean tree, and Update compares this string for equality against the target.
 * Server/daemon *process* logs may still append `-dirty` via
 * `developmentLogVersion()`; that answers "what is actually running" and is
 * deliberately not the product version.
 */

import type { BuildStamp } from './schema-digest'

const SOURCE_SHA = /^[0-9a-f]{7,40}$/i

/** Vite serving source — not a product version. */
export const DEV_SERVER_VERSION = 'dev-server'

export function isSourceSha(value: string): boolean {
  return SOURCE_SHA.test(value)
}

export function formatSourceVersion(sourceSha: string): string {
  return `dev+${sourceSha.toLowerCase().slice(0, 7)}`
}

export interface BuildIdentity {
  /** Human-readable product label. It is fallback evidence, never stronger than a digest. */
  version?: string
  /** Source checkout identity, in the same currency as `artifacts.web.digest`. */
  digest?: string
}

/** Normalize full and abbreviated git identities into the seven characters targets publish. */
export function sourceDigest(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized && isSourceSha(normalized) ? normalized.slice(0, 7) : undefined
}

/**
 * Read a source digest carried as version build metadata (`dev+abc1234` or
 * `0.4.2-edge.1+abc1234`). This keeps old servers useful while newer ones send
 * the digest as its own field.
 */
export function sourceDigestFromVersion(version: string | undefined): string | undefined {
  const metadata = version?.split('+', 2)[1]
  if (!metadata) return undefined
  for (const part of metadata.split('.')) {
    const digest = sourceDigest(part)
    if (digest) return digest
  }
  return undefined
}

/**
 * Whether two reported builds are known to differ.
 *
 * A digest is authoritative whenever both sides have one. Exact display-label
 * equality remains the compatibility fallback for older reports without source
 * identity; absence on either side is not evidence of staleness.
 */
export function buildsDiffer(current: BuildIdentity, expected: BuildIdentity): boolean {
  const currentDigest = sourceDigest(current.digest) ?? sourceDigestFromVersion(current.version)
  const expectedDigest = sourceDigest(expected.digest) ?? sourceDigestFromVersion(expected.version)
  if (currentDigest && expectedDigest) return currentDigest !== expectedDigest
  return (
    current.version !== undefined &&
    expected.version !== undefined &&
    current.version !== expected.version
  )
}

/**
 * Forensic identities that used to occupy `appVersion` after POD-1965.
 * A stamp that still carries one is an old artefact: derive the product
 * version from `sourceSha` instead of showing the chunk hash to an operator.
 */
export function isForensicBundleIdentity(version: string): boolean {
  return version.startsWith('bundle+') || version === DEV_SERVER_VERSION
}

/** Packaged version wins; otherwise `dev+<sha>`; otherwise `dev`. */
export function resolveProductVersion(
  packagedVersion: string | undefined,
  sourceSha: string | undefined,
): string {
  const packaged = packagedVersion?.trim()
  if (packaged) return packaged
  if (sourceSha && isSourceSha(sourceSha)) return formatSourceVersion(sourceSha)
  return 'dev'
}

/**
 * Product version a stamp (or an older stamp) names.
 *
 * New stamps write the product string under `appVersion`. Stamps from
 * POD-1965…POD-1968 wrote `bundle+<hash>` there and put the checkout in
 * `sourceSha` — Update already reconstructed `dev+<sourceSha>` from that.
 */
export function productVersionFromStamp(stamp: BuildStamp): string {
  const labeled = stamp.appVersion
  if (labeled && !isForensicBundleIdentity(labeled)) return labeled
  const fromSha = resolveProductVersion(undefined, stamp.sourceSha)
  if (fromSha !== 'dev') return fromSha
  return labeled ?? 'dev'
}
