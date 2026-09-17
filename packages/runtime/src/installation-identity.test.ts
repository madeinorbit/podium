import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONNECT_PROBE_PREFIX,
  CONNECT_REACHABILITY_PREFIX,
  CONNECT_REQUEST_PREFIX,
  connectRequestMessage,
  installationPublicKeyWire,
  mintInstallationIdentity,
  signWithInstallation,
  verifyWithWireKey,
} from './installation-identity'

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'connect-vectors.json'), 'utf8'),
) as {
  installationId: string
  publicKeyWire: string
  privateKeyPkcs8: string
  path: string
  body: string
  bodyHashHex: string
  timestamp: number
  signature: string
  challenge: string
  reachabilitySignature: string
}

describe('signatures', () => {
  it('round-trip through the wire public key and are bound to their prefix', () => {
    const identity = mintInstallationIdentity()
    const wire = installationPublicKeyWire(identity)
    expect(wire).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/)
    const sig = signWithInstallation(identity, CONNECT_REACHABILITY_PREFIX, 'challenge')
    expect(verifyWithWireKey(wire, CONNECT_REACHABILITY_PREFIX, 'challenge', sig)).toBe(true)
    expect(verifyWithWireKey(wire, CONNECT_REQUEST_PREFIX, 'challenge', sig)).toBe(false)
    expect(verifyWithWireKey(wire, CONNECT_REACHABILITY_PREFIX, 'other', sig)).toBe(false)
    expect(verifyWithWireKey('ed25519:short', CONNECT_REACHABILITY_PREFIX, 'challenge', sig)).toBe(
      false,
    )
    expect(verifyWithWireKey(wire, CONNECT_REACHABILITY_PREFIX, 'challenge', '!!')).toBe(false)
  })

  it('agree with connect.podium.do byte for byte (shared vectors)', () => {
    // The same fixture lives in podium-cloud apps/connect/src/fixtures/vectors.json
    // and is verified there with Web Crypto. If either side drifts, this fails.
    const identity = { privateKey: vectors.privateKeyPkcs8 }
    const hash = createHash('sha256').update(vectors.body).digest('hex')
    expect(hash).toBe(vectors.bodyHashHex)
    const message = connectRequestMessage('PUT', vectors.path, vectors.timestamp, hash)
    expect(signWithInstallation(identity, CONNECT_REQUEST_PREFIX, message)).toBe(vectors.signature)
    expect(
      verifyWithWireKey(vectors.publicKeyWire, CONNECT_REQUEST_PREFIX, message, vectors.signature),
    ).toBe(true)
    expect(signWithInstallation(identity, CONNECT_REACHABILITY_PREFIX, vectors.challenge)).toBe(
      vectors.reachabilitySignature,
    )
    expect(
      verifyWithWireKey(vectors.publicKeyWire, CONNECT_PROBE_PREFIX, message, vectors.signature),
    ).toBe(false)
  })
})
