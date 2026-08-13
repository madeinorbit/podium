import { describe, expect, it } from 'vitest'
import {
  decodePairingEnvelope,
  encodePairingEnvelope,
  mobilePairingPhraseFromDigest,
  mobilePairingUrl,
  parseMobilePairingUrl,
  type MobilePairEnvelope,
} from './pairing'

const pair: MobilePairEnvelope = {
  v: 2,
  kind: 'mobile-client',
  mode: 'pair',
  serverUrl: 'https://podium.example',
  pairCode: 'abcdefghijklmnopqrstuvwxyz012345',
  expiresAt: '2026-08-13T12:02:00.000Z',
  instanceId: 'instance-one',
}

describe('pairing envelope codec', () => {
  it('round-trips v1 without Buffer and preserves the legacy encoding', () => {
    const envelope = {
      v: 1 as const,
      serverUrl: 'wss://box.example',
      pairCode: 'AB12-CD34',
    }
    expect(encodePairingEnvelope(envelope)).toBe(
      'eyJ2IjoxLCJzZXJ2ZXJVcmwiOiJ3c3M6Ly9ib3guZXhhbXBsZSIsInBhaXJDb2RlIjoiQUIxMi1DRDM0In0',
    )
    expect(decodePairingEnvelope(encodePairingEnvelope(envelope))).toEqual(envelope)
  })

  it('round-trips v2 and enforces outer/envelope origin equality', () => {
    const url = mobilePairingUrl(pair)
    expect(parseMobilePairingUrl(url, Date.parse('2026-08-13T12:00:00.000Z'))).toEqual(pair)
    expect(() =>
      parseMobilePairingUrl(
        url.replace('podium.example/mobile', 'evil.example/mobile'),
        Date.parse('2026-08-13T12:00:00.000Z'),
      ),
    ).toThrow(/origin/)
  })

  it('keeps a v2 open envelope credential-free', () => {
    const open = {
      v: 2 as const,
      kind: 'mobile-client' as const,
      mode: 'open' as const,
      serverUrl: 'http://podium.lan:18787',
      instanceId: 'open-one',
    }
    const decoded = decodePairingEnvelope(encodePairingEnvelope(open))
    expect(decoded).toEqual(open)
    expect(decoded).not.toHaveProperty('pairCode')
  })

  it('rejects expired, credentialed non-canonical, and oversized payloads', () => {
    expect(() => parseMobilePairingUrl(mobilePairingUrl(pair), Date.parse(pair.expiresAt))).toThrow(
      /expired/,
    )
    expect(() =>
      encodePairingEnvelope({
        ...pair,
        serverUrl: 'https://podium.example/path',
      }),
    ).toThrow()
    expect(() => decodePairingEnvelope('A'.repeat(4097))).toThrow(/size/)
  })
})

it('maps the first 33 digest bits to a stable three-word phrase', () => {
  expect(mobilePairingPhraseFromDigest(Uint8Array.from([0, 0, 0, 0, 0]))).toEqual([
    'amberanchor',
    'amberanchor',
    'amberanchor',
  ])
  expect(mobilePairingPhraseFromDigest(Uint8Array.from([255, 255, 255, 255, 128]))).toEqual([
    'violetstone',
    'violetstone',
    'violetstone',
  ])
})
