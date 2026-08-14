/**
 * UPDATE DELIVERY: turn a resolved artifact reference into verified bytes or
 * a converged development checkout.
 *
 * Authority (what to run) and delivery (how the artifact arrives) are separate
 * axes. The convergence planner has already selected the platform asset, so
 * this module never re-derives the running platform.
 */
import { createHash, verify as cryptoVerify } from 'node:crypto'
import type { UpdateArtifact } from '@podium/protocol'
import { convergeViaGit, type GitRun } from './update-delivery-git'

/** The production release key used by feed and bundle verification. */
export const PODIUM_UPDATE_PUBKEY = 'MCowBQYDK2VwAyEAG12/153QJI/SePyYeJQhBSbh1ZsFgkoMkwb823NiYOU='

type PlatformAsset = Extract<UpdateArtifact, { delivery: 'feed' }>['platforms'][string]
type GitArtifact = Extract<UpdateArtifact, { delivery: 'git' }>

export interface DeliveryDeps {
  fetch: typeof fetch
  pubkey: string
  /** Public key pinned by this daemon's server pairing. Required for bundles. */
  pinnedPubkey?: string
  /**
   * Digest checking is a separate integrity gate from the signature. Tests may
   * disable it when they use a deliberately symbolic digest fixture; production
   * callers leave it enabled (the default).
   */
  verifyDigest?: boolean
  /** Runner for the development checkout delivery path. */
  git?: { run: GitRun }
  /**
   * Hard deadline for the artifact download. Without one a stalled connection
   * left the daemon in `downloading` forever and the operator watching a row
   * that could never fail.
   */
  downloadTimeoutMs?: number
  /** Raised when a newer grant supersedes the one being delivered. */
  signal?: AbortSignal
}

/** Long enough for a slow link, short enough that a hung socket still fails. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000

function matchesDigest(bytes: Uint8Array, expected: string): boolean {
  // Release manifests encode digests as `sha256-<base64>`.
  if (!expected.startsWith('sha256-')) return false
  const actual = `sha256-${createHash('sha256').update(bytes).digest('base64')}`
  return actual === expected
}

/**
 * Pure, testable Ed25519 verification of a downloaded artifact. A malformed
 * key, missing signature, or crypto failure is a rejection, never a pass.
 */
export function verifyTarball(
  bytes: Uint8Array,
  signatureB64: string,
  pubkeyB64: string = PODIUM_UPDATE_PUBKEY,
): boolean {
  if (!signatureB64) return false
  try {
    const key = {
      key: Buffer.from(pubkeyB64, 'base64'),
      format: 'der' as const,
      type: 'spki' as const,
    }
    return cryptoVerify(null, bytes, key, Buffer.from(signatureB64, 'base64'))
  } catch {
    return false
  }
}

export function fetchArtifact(
  asset: PlatformAsset,
  delivery: 'feed' | 'bundle',
  deps: DeliveryDeps,
): Promise<{ bytes: Uint8Array }>
export function fetchArtifact(
  artifact: GitArtifact,
  delivery: 'git',
  deps: DeliveryDeps,
): Promise<{ git: true }>
export function fetchArtifact(
  asset: PlatformAsset | GitArtifact,
  delivery: UpdateArtifact['delivery'],
  deps: DeliveryDeps,
): Promise<{ bytes: Uint8Array } | { git: true }>
export async function fetchArtifact(
  asset: PlatformAsset | GitArtifact,
  delivery: UpdateArtifact['delivery'],
  deps: DeliveryDeps,
): Promise<{ bytes: Uint8Array } | { git: true }> {
  if (delivery === 'git') {
    if (!('repo' in asset) || !('sha' in asset) || !deps.git) {
      throw new Error('git delivery requires a configured checkout runner')
    }
    const result = await convergeViaGit({ repo: asset.repo, sha: asset.sha }, deps.git)
    if (!result.ok) throw new Error('git delivery failed: ' + result.reason)
    return { git: true }
  }
  if (!('url' in asset)) throw new Error('platform delivery requires an artifact URL')

  const timeoutMs = deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  const abort = new AbortController()
  // Either bound ends the download: the deadline, or a superseding grant.
  const onCallerAbort = (): void => abort.abort()
  deps.signal?.addEventListener('abort', onCallerAbort, { once: true })
  if (deps.signal?.aborted) abort.abort()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  ;(timer as { unref?: () => void }).unref?.()
  let bytes: Uint8Array
  try {
    const res = await deps.fetch(asset.url, { signal: abort.signal })
    if (!res.ok) throw new Error(`artifact download returned ${res.status}`)
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (error) {
    if (deps.signal?.aborted) throw new Error('artifact download was superseded by a newer grant')
    if (abort.signal.aborted) {
      throw new Error(`artifact download timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', onCallerAbort)
  }

  if (deps.verifyDigest !== false && !matchesDigest(bytes, asset.digest)) {
    throw new Error('digest verification FAILED — refusing to install the artifact')
  }

  // SECURITY GATE, before anything touches disk. Fail closed for both feed and
  // bundle delivery; transport authentication is not a substitute.
  const trustedPubkey = delivery === 'bundle' ? deps.pinnedPubkey : deps.pubkey
  if (trustedPubkey === undefined) {
    throw new Error('bundle delivery requires the server update key pinned at pairing')
  }
  if (!verifyTarball(bytes, asset.signature, trustedPubkey)) {
    throw new Error(
      'signature verification FAILED — refusing to install. The artifact was not ' +
        'signed by the trusted key (tampered, corrupt, or wrong feed). No changes were made.',
    )
  }
  return { bytes }
}
