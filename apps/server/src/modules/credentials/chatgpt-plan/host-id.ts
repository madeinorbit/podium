/**
 * THE HOST ID PODIUM SENDS TO OPENAI (credential management §11 "Host id").
 *
 * OpenAI asks each host that renews a ChatGPT sign-in for a stable, opaque
 * `ext_agent_host_id`, and accepts only three forms. Podium's installation id
 * (`pdm_…`) is none of them, so the host id is the RFC 9278 thumbprint URI of
 * the installation's Ed25519 public key (RFC 7638 thumbprint over the RFC 8037
 * JWK). It moves with the server because the key does, and is no secret.
 */

import { createHash, createPublicKey } from 'node:crypto'

export const CHATGPT_HOST_ID_PREFIX = 'urn:ietf:params:oauth:jwk-thumbprint:sha-256:'

/** RFC 7638: SHA-256 over the required members in lexicographic order, base64url. */
export function jwkThumbprintEd25519(x: string): string {
  const canonical = JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })
  return createHash('sha256').update(canonical, 'utf8').digest('base64url')
}

/** The host id of an installation whose public key is SPKI DER, base64. */
export function chatgptHostId(identity: { publicKey: string }): string {
  const key = createPublicKey({
    key: Buffer.from(identity.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  })
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('the installation key is not an Ed25519 key')
  }
  const x = key.export({ format: 'jwk' }).x
  if (typeof x !== 'string') throw new Error('the installation key has no public half')
  return `${CHATGPT_HOST_ID_PREFIX}${jwkThumbprintEd25519(x)}`
}
