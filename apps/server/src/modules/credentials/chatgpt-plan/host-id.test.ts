import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CHATGPT_HOST_ID_PREFIX, chatgptHostId, jwkThumbprintEd25519 } from './host-id'

describe('the ChatGPT host id (§11 "Host id")', () => {
  it('is the RFC 7638 thumbprint of the Ed25519 JWK: RFC 8037 appendix A.3', () => {
    expect(jwkThumbprintEd25519('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo')).toBe(
      'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
    )
  })

  it('is the RFC 9278 URI of the installation public key, stable across calls', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const x = publicKey.export({ format: 'jwk' }).x as string
    const id = chatgptHostId({ publicKey: spki })
    expect(id).toBe(`${CHATGPT_HOST_ID_PREFIX}${jwkThumbprintEd25519(x)}`)
    expect(id).toMatch(/^urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}$/)
    expect(chatgptHostId({ publicKey: spki })).toBe(id)
  })

  it('refuses a key that is not Ed25519', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    expect(() => chatgptHostId({ publicKey: spki })).toThrow(/Ed25519/)
  })
})
