import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A new update key authorized by the private half of the previous key. */
export interface UpdateKeyRotation {
  from: string
  to: string
  signature: string
}

const ROTATION_CONTEXT = 'podium-update-key-rotation:v1'

/** Domain-separated bytes signed when an update publisher rotates its key. */
export function updateKeyRotationPayload(from: string, to: string): Buffer {
  return Buffer.from(`${ROTATION_CONTEXT}\n${from}\n${to}\n`, 'utf8')
}

/** Short display identity for out-of-band comparison; never a trust decision by itself. */
export function updateKeyFingerprint(publicKey: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64')}`
}

export function verifyUpdateKeyRotation(rotation: UpdateKeyRotation): boolean {
  if (!rotation.from || !rotation.to || !rotation.signature) return false
  try {
    return verify(
      null,
      updateKeyRotationPayload(rotation.from, rotation.to),
      { key: Buffer.from(rotation.from, 'base64'), format: 'der', type: 'spki' },
      Buffer.from(rotation.signature, 'base64'),
    )
  } catch {
    return false
  }
}

/**
 * Prove a path from a daemon's existing pin to the publisher's advertised key.
 * Earlier transitions may be present for machines that enrolled later; every
 * transition from the pinned key onward must be contiguous and valid.
 */
export function acceptsUpdateKeyRotation(
  pinned: string,
  advertised: string,
  rotations: readonly UpdateKeyRotation[],
): boolean {
  if (pinned === advertised) return true
  const start = rotations.findIndex((rotation) => rotation.from === pinned)
  if (start < 0) return false
  let trusted = pinned
  for (const rotation of rotations.slice(start)) {
    if (rotation.from !== trusted || !verifyUpdateKeyRotation(rotation)) return false
    trusted = rotation.to
    if (trusted === advertised) return true
  }
  return false
}

/**
 * Explicit local recovery for a publisher key whose predecessor is unavailable.
 * This is intentionally a filesystem-local action: neither a server reply nor
 * an update manifest can invoke it.
 */
export function trustDaemonUpdateKey(publicKey: string, dir: string): string {
  const key = createPublicKey({
    key: Buffer.from(publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('update key must be an Ed25519 SPKI key')
  const path = join(dir, 'daemon.json')
  let identity: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { machineId?: unknown }).machineId !== 'string'
    ) {
      throw new Error('daemon identity has no machine id')
    }
    identity = parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(
      'cannot replace the update key in ' +
        path +
        ': ' +
        (error instanceof Error ? error.message : String(error)),
    )
  }
  identity.updatePubkey = publicKey
  const temporary = path + '.update-key'
  writeFileSync(temporary, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, path)
  return updateKeyFingerprint(publicKey)
}
