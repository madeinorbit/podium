import { createHash } from 'node:crypto'

/**
 * Neutral login-identity fingerprint shared by the adapter credentials
 * sections (POD-4738).
 *
 * KNOWLEDGE-free mechanism support: a sha256 over an account id or email.
 * The result is safe to replicate to clients. Names no harness and lives
 * beside the other adapter-shared pure helpers so no adapter imports another
 * adapter's directory for it.
 */
export function fingerprintForLoginIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
