/**
 * CLIENT BUILD EVIDENCE — what packaging trusts about apps/web/dist and apps/mobile/dist.
 *
 * Replaces the POD-2540 nonce. That nonce answered "did OUR build write these bytes NOW?"
 * for a build that ran in a live checkout with a persistent dist. Under the snapshot
 * updater "now" is answered by the fresh worktree at the approved commit, and "ours" by
 * the build task (or, from M2 on, a Turbo cache restore keyed on the inputs). What this
 * module proves: the inventory is exact, every byte matches its recorded hash, the site
 * names the approved commit and version, and the site is not a stub. What it does NOT
 * prove, recorded rather than buried: a same-user attacker who can write the local
 * cache directory could plant a consistent dist — the same trust domain as editing
 * package.json, which POD-2540 already placed outside its threat model.
 *
 * Spec: docs/internal/superpowers/specs/2026-08-28-cached-release-build-design.md §5.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clientBuildRootDigestFromSites } from './client-build-root-digest'
import { CLIENT_BUILD_MANIFEST_FILE, type ClientBuildManifest } from './write-web-build-stamp'

/** From today's builds (510 web / 42 mobile). Revisit when a genuine build trips it. */
export const CLIENT_FILE_FLOOR = { web: 400, mobile: 30 } as const

export type ClientBuildEvidence = Readonly<{
  clientRootDigest: string
  version: string
  sourceCommit: string
  sites: { web: string; mobile: string }
}>

export interface VerifyClientBuildInput {
  web: string
  mobile: string
  sourceCommit: string
  version: string
}

/** Evidence is minted here or it is not evidence. A caller cannot forge membership
 *  of a WeakSet this module never exposes, so a structurally identical literal —
 *  or one parsed out of an archive — is refused by `isClientBuildEvidence`. */
const minted = new WeakSet<object>()

export function isClientBuildEvidence(value: unknown): value is ClientBuildEvidence {
  return typeof value === 'object' && value !== null && minted.has(value)
}

function readManifest(site: string, label: string): ClientBuildManifest {
  let manifest: ClientBuildManifest
  try {
    manifest = JSON.parse(
      readFileSync(join(site, CLIENT_BUILD_MANIFEST_FILE), 'utf8'),
    ) as ClientBuildManifest
  } catch (error) {
    throw new Error(
      `verify-client-build: ${label} has no readable ${CLIENT_BUILD_MANIFEST_FILE}: ${String(error)}`,
    )
  }
  if (manifest.manifestVersion !== 2) {
    throw new Error(`verify-client-build: ${label} manifest is not v2`)
  }
  const inventoried = Object.keys(manifest.files ?? {}).length
  if (manifest.fileCount !== inventoried) {
    throw new Error(
      `verify-client-build: ${label} manifest fileCount ${manifest.fileCount} disagrees with its inventory of ${inventoried}`,
    )
  }
  return manifest
}

function checkSite(site: string, label: 'web' | 'mobile', input: VerifyClientBuildInput): void {
  const manifest = readManifest(site, label)
  if (manifest.sourceCommit !== input.sourceCommit) {
    throw new Error(
      `verify-client-build: ${label} was built from ${manifest.sourceCommit}, not ${input.sourceCommit}`,
    )
  }
  if (manifest.buildStamp?.appVersion !== input.version) {
    throw new Error(
      `verify-client-build: ${label} is stamped ${manifest.buildStamp?.appVersion}, not ${input.version}`,
    )
  }
  if (manifest.fileCount < CLIENT_FILE_FLOOR[label]) {
    throw new Error(
      `verify-client-build: ${label} has ${manifest.fileCount} files, floor is ${CLIENT_FILE_FLOOR[label]}`,
    )
  }
}

/** Verify both sites and mint the evidence packaging requires. Throws on any mismatch. */
export function verifyClientBuild(input: VerifyClientBuildInput): ClientBuildEvidence {
  checkSite(input.web, 'web', input)
  checkSite(input.mobile, 'mobile', input)
  // Exact inventory + per-file hash check lives in clientBuildRootDigestFromSites
  // (packages/runtime/src/client-build-provenance.ts); it throws on any drift.
  const clientRootDigest = clientBuildRootDigestFromSites({ web: input.web, mobile: input.mobile })
  const evidence: ClientBuildEvidence = Object.freeze({
    clientRootDigest,
    version: input.version,
    sourceCommit: input.sourceCommit,
    sites: { web: input.web, mobile: input.mobile },
  })
  minted.add(evidence)
  return evidence
}
