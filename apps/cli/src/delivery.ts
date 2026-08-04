/**
 * DELIVERY: turn a resolved artifact reference into verified bytes.
 *
 * Authority (what to run) and delivery (how the bytes arrive) are separate
 * axes. This module owns only the second one, so it never re-derives the
 * running platform. Task 2 already selected that asset.
 *
 * `bundle` verifies exactly like `feed`: an authenticated socket says who sent
 * the bytes, while a signature says what those bytes are. Both are required.
 */
import { createHash } from 'node:crypto'
import type { UpdateArtifact } from '@podium/protocol'
import { verifyTarball } from './podium-update'

type PlatformAsset = Extract<UpdateArtifact, { delivery: 'feed' }>['platforms'][string]

export interface DeliveryDeps {
  fetch: typeof fetch
  pubkey: string
  /**
   * Digest checking is a separate integrity gate from the signature. Tests may
   * disable it when they use a deliberately symbolic digest fixture; production
   * callers leave it enabled (the default).
   */
  verifyDigest?: boolean
}

function matchesDigest(bytes: Uint8Array, expected: string): boolean {
  // Release manifests encode digests as `sha256-<base64>`.
  if (!expected.startsWith('sha256-')) return false
  const actual = `sha256-${createHash('sha256').update(bytes).digest('base64')}`
  return actual === expected
}

export async function fetchArtifact(
  asset: PlatformAsset,
  delivery: UpdateArtifact['delivery'],
  deps: DeliveryDeps,
): Promise<{ bytes: Uint8Array }> {
  if (delivery === 'git') {
    throw new Error('git delivery is not implemented in this phase (Phase 5 owns it)')
  }

  const res = await deps.fetch(asset.url)
  if (!res.ok) throw new Error(`artifact download returned ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())

  if (deps.verifyDigest !== false && !matchesDigest(bytes, asset.digest)) {
    throw new Error('digest verification FAILED — refusing to install the artifact')
  }

  // SECURITY GATE, before anything touches disk. Fail closed for both feed and
  // bundle delivery; the transport’s authentication is not a substitute.
  if (!verifyTarball(bytes, asset.signature, deps.pubkey)) {
    throw new Error(
      'signature verification FAILED — refusing to install. The artifact was not ' +
        'signed by the trusted key (tampered, corrupt, or wrong feed). No changes were made.',
    )
  }
  return { bytes }
}
