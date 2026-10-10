import { describe, expect, it } from 'vitest'
import {
  base64urlFromBytes,
  bytesFromBase64url,
  isServerIdentity,
  LOCATE_PROOF_PATH,
  LOCATE_PROOF_PREFIX,
  locateOrigin,
  locateProofMessage,
  parseLocateProofRequest,
  parseLocateProofResponse,
  rawPublicKeyFromWire,
} from './server-locate'
import vectors from './server-locate.vectors.json'

// The other two installation-key domains (packages/runtime/src/installation-identity.ts),
// spelled out: protocol is L0 and must not import runtime.
const CONNECT_REACHABILITY_PREFIX = 'podium-reachability-v1\n'
const CONNECT_PROBE_PREFIX = 'podium-connect-probe-v1\n'

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

describe('locate proof message (POD-5921)', () => {
  it('is prefix || nonce || publicUrl, byte for byte', () => {
    const nonce = new Uint8Array(32).fill(7)
    const message = locateProofMessage(nonce, 'https://a.example')
    const ascii = (s: string) =>
      Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    expect(hex(message)).toBe(
      `${ascii('podium-locate-v1\n')}${'07'.repeat(32)}${ascii('https://a.example')}`,
    )
  })

  it('has a domain prefix distinct from every other installation-key context', () => {
    const prefixes = [LOCATE_PROOF_PREFIX, CONNECT_REACHABILITY_PREFIX, CONNECT_PROBE_PREFIX]
    expect(new Set(prefixes).size).toBe(prefixes.length)
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a !== b) expect(b.startsWith(a)).toBe(false)
      }
    }
  })

  it('is served on its own path, not the Connect probe route', () => {
    expect(LOCATE_PROOF_PATH).toBe('/.well-known/podium/locate')
  })
})

describe('locate proof parsers', () => {
  const nonce = base64urlFromBytes(new Uint8Array(32).fill(1))

  it('accepts exactly 32 bytes of unpadded base64url as the nonce', () => {
    const parsed = parseLocateProofRequest({ nonce })
    expect('nonce' in parsed && hex(parsed.nonce)).toBe('01'.repeat(32))
    expect(parseLocateProofRequest({ nonce: `${nonce}=` })).toHaveProperty('error')
    expect(
      parseLocateProofRequest({ nonce: base64urlFromBytes(new Uint8Array(31)) }),
    ).toHaveProperty('error')
    expect(
      parseLocateProofRequest({ nonce: base64urlFromBytes(new Uint8Array(33)) }),
    ).toHaveProperty('error')
    expect(parseLocateProofRequest({})).toHaveProperty('error')
    expect(parseLocateProofRequest(null)).toHaveProperty('error')
    expect(parseLocateProofRequest([nonce])).toHaveProperty('error')
    expect(parseLocateProofRequest({ nonce: 42 })).toHaveProperty('error')
  })

  it('accepts a well-formed response and refuses anything else', () => {
    const good = vectors.cases[0]!.response
    expect(parseLocateProofResponse(good)).toEqual(good)
    expect(parseLocateProofResponse({ ...good, installationId: 'pdm_short' })).toBeUndefined()
    expect(parseLocateProofResponse({ ...good, publicUrl: 'ftp://a.example' })).toBeUndefined()
    expect(parseLocateProofResponse({ ...good, publicUrl: 'not a url' })).toBeUndefined()
    expect(
      parseLocateProofResponse({ ...good, signature: good.signature.slice(1) }),
    ).toBeUndefined()
    expect(parseLocateProofResponse({ ...good, signature: undefined })).toBeUndefined()
    expect(parseLocateProofResponse('nope')).toBeUndefined()
  })

  it('recognises a stored identity only when both halves are well-formed', () => {
    const identity = vectors.cases[0]!.stored
    expect(isServerIdentity(identity)).toBe(true)
    expect(isServerIdentity({ installationId: identity.installationId })).toBe(false)
    expect(isServerIdentity({ ...identity, installationPublicKey: 'ed25519:short' })).toBe(false)
    expect(isServerIdentity(undefined)).toBe(false)
  })

  it('normalises origins and refuses non-http schemes', () => {
    expect(locateOrigin('https://a.example/')).toBe('https://a.example')
    expect(locateOrigin('https://a.example:443/path?q')).toBe('https://a.example')
    expect(locateOrigin('wss://a.example')).toBeUndefined()
    expect(locateOrigin('https://user:pw@a.example')).toBeUndefined()
  })

  it('round-trips base64url and rejects non-canonical input', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253])
    expect(hex(bytesFromBase64url(base64urlFromBytes(bytes))!)).toBe(hex(bytes))
    expect(base64urlFromBytes(bytes)).toBe('AAEC-vv8_Q')
    expect(bytesFromBase64url('AB')).toBeUndefined()
    expect(bytesFromBase64url('A=')).toBeUndefined()
  })
})

describe('the shared vectors', () => {
  it('raw public keys decode to 32 bytes', () => {
    expect(rawPublicKeyFromWire(vectors.server.installationPublicKey)?.length).toBe(32)
    expect(rawPublicKeyFromWire('ed25519:nope')).toBeUndefined()
  })

  for (const vector of vectors.cases) {
    it(`${vector.name}: the signed message is prefix || nonce || normalised publicUrl`, () => {
      const signedNonce = bytesFromBase64url(vector.signedNonce)!
      expect(signedNonce.length).toBe(32)
      expect(hex(locateProofMessage(signedNonce, vector.response.publicUrl))).toBe(
        vector.messageHex,
      )
      expect(vector.response.publicUrl).toBe(locateOrigin(vector.configuredPublicUrl))
      expect(parseLocateProofResponse(vector.response)).toEqual(vector.response)
      expect(isServerIdentity(vector.stored)).toBe(true)
      // The id and origin checks need no signature library; the signature itself
      // is checked by the runtime verifier test against the same file.
      const idMatches = vector.response.installationId === vector.stored.installationId
      const originMatches =
        locateOrigin(vector.response.publicUrl) === locateOrigin(vector.candidate)
      if (vector.verdict === 'wrong-id') expect(idMatches).toBe(false)
      else if (vector.verdict === 'origin-mismatch')
        expect([idMatches, originMatches]).toEqual([true, false])
      else expect([idMatches, originMatches]).toEqual([true, true])
    })
  }
})
