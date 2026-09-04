import { describe, expect, it } from 'vitest'
import {
  decodePairingEnvelope,
  encodePairingEnvelope,
  mobilePairingPhraseFromDigest,
  mobilePairingUrl,
  MobilePairClaimRequest,
  NativeClientLoginRequest,
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

  it('accepts the installed-app bridge without treating its null origin as HTTP', () => {
    const encoded = encodePairingEnvelope(pair)
    const now = Date.parse('2026-08-13T12:00:00.000Z')
    expect(parseMobilePairingUrl(`podium://pair/${encoded}`, now)).toEqual(pair)
    expect(parseMobilePairingUrl(`podium://pair/mobile#pair=${encoded}`, now)).toEqual(pair)
    expect(
      parseMobilePairingUrl(
        `podium://pair?url=${encodeURIComponent(mobilePairingUrl(pair))}`,
        now,
      ),
    ).toEqual(pair)
    expect(() => parseMobilePairingUrl(`podium://other/${encoded}`, now)).toThrow()
  })

  it('accepts the empty-authority forms iOS link delivery produces', () => {
    // Opening podium://pair/… through iOS (simctl, Safari, another app) can
    // arrive as podium:///pair/… — the authority collapsed into the path.
    // Observed on-device 2026-08-27; without this the app 404s on every
    // pairing deep link while QR scanning (which never touches URL routing)
    // keeps working, masking the break.
    const encoded = encodePairingEnvelope(pair)
    const now = Date.parse('2026-08-13T12:00:00.000Z')
    expect(parseMobilePairingUrl(`podium:///pair/${encoded}`, now)).toEqual(pair)
    expect(
      parseMobilePairingUrl(
        `podium:///pair?url=${encodeURIComponent(mobilePairingUrl(pair))}`,
        now,
      ),
    ).toEqual(pair)
    expect(() => parseMobilePairingUrl(`podium:///other/${encoded}`, now)).toThrow()
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

describe('mobile device metadata', () => {
  const safe = {
    pairCode: 'abcdefghijklmnopqrstuvwxyz012345',
    claimHash: 'a'.repeat(64),
    deviceId: 'phone-1',
    deviceName: "Sam's iPhone",
    platform: 'ios' as const,
  }

  it('removes caller-selected delivery from the claim contract', () => {
    expect(MobilePairClaimRequest.parse({ ...safe, delivery: 'native' })).toEqual(safe)
  })

  it.each([
    'Phone\nverified',
    'Phone\n',
    'Phone\u0007',
    'Phone\u0085',
    'Phone\u2028line',
    'Phone\u202eadmin',
    'Phone\u2066safe',
  ])(
    'rejects control or bidi text in a device name: %s',
    (deviceName) => {
      expect(MobilePairClaimRequest.safeParse({ ...safe, deviceName }).success).toBe(false)
      expect(
        NativeClientLoginRequest.safeParse({
          delivery: 'native',
          password: 'secret',
          deviceId: safe.deviceId,
          deviceName,
          platform: safe.platform,
        }).success,
      ).toBe(false)
    },
  )

  it('rejects the same unsafe characters in opaque device ids', () => {
    expect(MobilePairClaimRequest.safeParse({ ...safe, deviceId: 'phone\u200fadmin' }).success).toBe(
      false,
    )
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
