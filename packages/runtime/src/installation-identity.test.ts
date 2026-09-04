import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bumpInstallationGeneration,
  CONNECT_PROBE_PREFIX,
  CONNECT_REACHABILITY_PREFIX,
  CONNECT_REQUEST_PREFIX,
  connectRequestMessage,
  INSTALLATION_FILE,
  installationPublicKeyWire,
  isInstallationId,
  readInstallationIdentity,
  readOrCreateInstallationIdentity,
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

const dirs: string[] = []
const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-installation-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readOrCreateInstallationIdentity', () => {
  it('mints once and reuses forever', () => {
    const dir = stateDir()
    const first = readOrCreateInstallationIdentity(dir)
    expect(isInstallationId(first.installationId)).toBe(true)
    expect(first.generation).toBe(1)
    expect(first.version).toBe(1)
    expect(readOrCreateInstallationIdentity(dir)).toEqual(first)
    expect(readInstallationIdentity(dir)).toEqual(first)
    expect(statSync(join(dir, INSTALLATION_FILE)).mode & 0o777).toBe(0o600)
  })

  it('is absent, not minted, on a plain read', () => {
    expect(readInstallationIdentity(stateDir())).toBeUndefined()
  })

  it('is per state dir', () => {
    expect(readOrCreateInstallationIdentity(stateDir()).installationId).not.toBe(
      readOrCreateInstallationIdentity(stateDir()).installationId,
    )
  })

  it('the wx loser re-reads the winner', () => {
    const dir = stateDir()
    const winner = readOrCreateInstallationIdentity(stateDir())
    // Plant the "other process's" file after a fresh dir has been chosen, so the
    // next call decides to mint and then loses the write.
    writeFileSync(join(dir, INSTALLATION_FILE), JSON.stringify(winner))
    expect(readOrCreateInstallationIdentity(dir)).toEqual(winner)
  })

  it.each([
    ['not json', '{'],
    ['wrong version', JSON.stringify({ version: 2 })],
    [
      'bad id',
      JSON.stringify({
        version: 1,
        installationId: 'x',
        privateKey: 'a',
        publicKey: 'b',
        generation: 1,
        createdAt: 'c',
      }),
    ],
  ])('refuses a corrupt file (%s) rather than re-minting', (_name, raw) => {
    const dir = stateDir()
    writeFileSync(join(dir, INSTALLATION_FILE), raw)
    expect(() => readOrCreateInstallationIdentity(dir)).toThrow(
      /invalid persisted installation identity/,
    )
    expect(() => readInstallationIdentity(dir)).toThrow()
  })

  it('refuses a file whose halves disagree', () => {
    const dir = stateDir()
    const a = readOrCreateInstallationIdentity(dir)
    const b = readOrCreateInstallationIdentity(stateDir())
    writeFileSync(join(dir, INSTALLATION_FILE), JSON.stringify({ ...a, publicKey: b.publicKey }))
    expect(() => readInstallationIdentity(dir)).toThrow(/invalid persisted installation identity/)
  })
})

describe('bumpInstallationGeneration', () => {
  it('increments durably and is a no-op without an identity', () => {
    const dir = stateDir()
    expect(bumpInstallationGeneration(dir)).toBeUndefined()
    const first = readOrCreateInstallationIdentity(dir)
    expect(bumpInstallationGeneration(dir)?.generation).toBe(2)
    expect(readInstallationIdentity(dir)).toEqual({ ...first, generation: 2 })
    expect(bumpInstallationGeneration(dir)?.generation).toBe(3)
  })
})

describe('signatures', () => {
  it('round-trip through the wire public key and are bound to their prefix', () => {
    const identity = readOrCreateInstallationIdentity(stateDir())
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

  it('agree with connect.meetpodium.com byte for byte (shared vectors)', () => {
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
