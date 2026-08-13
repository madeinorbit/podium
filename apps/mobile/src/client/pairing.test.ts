import { encodePairingEnvelope, type MobilePairingEnvelope } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

const cryptoMock = vi.hoisted(() => ({
  digest: vi.fn(),
  getRandomBytes: vi.fn(),
}))
const runtimePlatform = vi.hoisted(() => ({ OS: 'ios' }))

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: cryptoMock.digest,
  getRandomBytes: cryptoMock.getRandomBytes,
}))
vi.mock('react-native', () => ({ Platform: runtimePlatform }))

import {
  claimMobilePairing,
  normalizeManualServer,
  PairingLinkError,
  parsePairingLink,
  preflightServer,
} from './pairing'

const pairEnvelope: MobilePairingEnvelope = {
  v: 2,
  kind: 'mobile-client',
  mode: 'pair',
  serverUrl: 'https://podium.example',
  pairCode: '0123456789abcdef0123456789abcdef',
  expiresAt: '2099-01-01T00:00:00.000Z',
  instanceId: 'instance-a',
}

const link = (origin: string, envelope: MobilePairingEnvelope = pairEnvelope) =>
  `${origin}/mobile#pair=${encodePairingEnvelope(envelope)}`

/** Encode an attacker-controlled envelope without the trusted producer schema. */
const uncheckedLink = (origin: string, envelope: Record<string, unknown>) =>
  `${origin}/mobile#pair=${btoa(JSON.stringify(envelope))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')}`

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  cryptoMock.digest.mockReset()
  cryptoMock.getRandomBytes.mockReset()
  runtimePlatform.OS = 'ios'
})

describe('mobile pairing links', () => {
  it('consumes only a strict origin-bound HTTPS fragment envelope', () => {
    expect(parsePairingLink(link('https://podium.example')).envelope).toEqual(pairEnvelope)
  })

  it('rejects an outer origin that differs from the envelope', () => {
    expect(() => parsePairingLink(link('https://evil.example'))).toThrow(PairingLinkError)
  })

  it('accepts the custom scheme only as a bridge around the same HTTPS URL', () => {
    const parsed = parsePairingLink(
      `podium://pair?url=${encodeURIComponent(link('https://podium.example'))}`,
    )
    expect(parsed.source).toBe('custom-scheme')
    expect(parsed.envelope).toEqual(pairEnvelope)
    expect(
      parsePairingLink(`podium://pair/${encodePairingEnvelope(pairEnvelope)}`).envelope,
    ).toEqual(pairEnvelope)
  })

  it('rejects protected HTTP, pathful manual URLs, userinfo and expired grants', () => {
    expect(() =>
      parsePairingLink(
        uncheckedLink('http://podium.example', {
          ...pairEnvelope,
          serverUrl: 'http://podium.example',
        }),
      ),
    ).toThrow(PairingLinkError)
    expect(() => normalizeManualServer('https://user:pass@podium.example')).toThrow('origin only')
    expect(() => normalizeManualServer('https://podium.example/not-an-origin')).toThrow(
      'origin only',
    )
    expect(() =>
      parsePairingLink(
        link('https://podium.example', { ...pairEnvelope, expiresAt: '2020-01-01T00:00:00Z' }),
      ),
    ).toThrow('expired')
  })
})

describe('server preflight', () => {
  it('fails closed on native LAN HTTP before making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(preflightServer('http://192.168.1.8:18787')).resolves.toMatchObject({
      ok: false,
      kind: 'cleartext-blocked',
      transport: 'insecure-lan',
      title: 'LAN HTTP is unavailable',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows an open HTTP origin only when web-mobile is already in the browser policy', async () => {
    runtimePlatform.OS = 'web'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            wireVersion: 2,
            minSupportedVersion: 1,
            instanceId: 'lan',
            appVersion: 'dev',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ needsAuth: false, authed: true, userId: 'user:admin' }), {
          status: 200,
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    await expect(preflightServer('http://192.168.1.8:18787')).resolves.toMatchObject({
      ok: true,
      mode: 'open',
      transport: 'insecure-lan',
    })
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit).credentials)).toEqual([
      'omit',
      'omit',
    ])
  })

  it('blocks LAN, Tailscale 100.x HTTP, and public HTTP natively', async () => {
    await expect(preflightServer('http://10.0.0.8')).resolves.toMatchObject({
      ok: false,
      kind: 'cleartext-blocked',
    })
    await expect(preflightServer('http://100.100.10.20')).resolves.toMatchObject({
      ok: false,
      kind: 'cleartext-blocked',
      transport: 'tailscale-http',
    })
    await expect(preflightServer('http://podium.example')).resolves.toMatchObject({
      ok: false,
      kind: 'cleartext-blocked',
      transport: 'insecure-http',
    })
  })

  it('names version skew instead of falling through to reachability', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ wireVersion: 9, minSupportedVersion: 9, instanceId: 'future' }),
            { status: 200 },
          ),
        ),
    )
    await expect(preflightServer('https://podium.example')).resolves.toMatchObject({
      ok: false,
      kind: 'version-mismatch',
      title: 'Update this app',
    })

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ wireVersion: 1, minSupportedVersion: 1, instanceId: 'old' }),
            { status: 200 },
          ),
        ),
    )
    await expect(preflightServer('https://old.example')).resolves.toMatchObject({
      ok: false,
      kind: 'version-mismatch',
      title: 'Update the server',
    })
  })

  it('rejects a malformed successful auth-status response instead of assuming open mode', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ wireVersion: 2, minSupportedVersion: 1, instanceId: 'podium' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(preflightServer('https://podium.example')).resolves.toMatchObject({
      ok: false,
      kind: 'not-podium',
    })
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit).credentials)).toEqual([
      'omit',
      'omit',
    ])
  })
})

describe('claim hashing interop', () => {
  it('uses the finalized raw-byte vector and sends a schema-valid lowercase digest', async () => {
    const raw = Uint8Array.from({ length: 32 }, (_, index) => index)
    const digestHex = '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8ab c1b8581bd710dd'.replace(
      ' ',
      '',
    )
    const digest = Uint8Array.from(digestHex.match(/../g) ?? [], (pair) =>
      Number.parseInt(pair, 16),
    )
    cryptoMock.getRandomBytes.mockReturnValue(raw)
    cryptoMock.digest.mockResolvedValue(digest.buffer)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          claimId: 'claim-1',
          phrase: ['amber', 'quiet', 'river'],
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const claim = await claimMobilePairing(
      pairEnvelope as Extract<MobilePairingEnvelope, { mode: 'pair' }>,
      'device-1',
      'Phone',
      'ios',
    )

    expect(cryptoMock.digest).toHaveBeenCalledWith('SHA-256', raw)
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(request.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      claimHash: digestHex,
      deviceId: 'device-1',
      platform: 'ios',
    })
    expect(body.claimSecret).toBeUndefined()
    expect(body.delivery).toBeUndefined()
    expect(request.credentials).toBe('omit')
    expect(claim.claimSecret).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8')
  })
})
