import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { encodePairingEnvelope, type MobilePairingEnvelope } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))
vi.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA-256' } }))

import { redirectSystemPath } from '../../app/+native-intent'
import { parsePairingLink } from './pairing'

const envelope: MobilePairingEnvelope = {
  v: 2,
  kind: 'mobile-client',
  mode: 'pair',
  serverUrl: 'https://team.podium.test',
  pairCode: '0123456789abcdef0123456789abcdef',
  expiresAt: '2099-01-01T00:00:00.000Z',
  instanceId: 'instance-a',
}
const https = `https://team.podium.test/mobile#pair=${encodePairingEnvelope(envelope)}`

/** Every form the pairing parser accepts (POD-844), as the OS delivers them. */
const pairingLinks = [
  ['the custom-scheme bridge', `podium://pair?url=${encodeURIComponent(https)}`],
  ['the custom-scheme envelope', `podium://pair/${encodePairingEnvelope(envelope)}`],
  ['the HTTPS fragment URL', https],
] as const

describe('OS pairing links and the router (POD-6913)', () => {
  it.each(
    pairingLinks,
  )('starts a cold app at the root and moves a running one nowhere for %s', (_, link) => {
    // The gate still parses the same raw URL from Linking.
    expect(parsePairingLink(link).envelope).toEqual(envelope)
    expect(redirectSystemPath({ path: link, initial: true })).toBe('/')
    expect(redirectSystemPath({ path: link, initial: false })).toBeNull()
  })

  // The gate refuses these spellings with an error, but they still carry the
  // secret, so the router must not hold them either.
  it.each([
    `podium:///pair/${encodePairingEnvelope(envelope)}`,
    `PODIUM://Pair?url=${encodeURIComponent(https)}`,
  ])('keeps the variant spelling %s out of the router as well', (link) => {
    expect(redirectSystemPath({ path: link, initial: true })).toBe('/')
    expect(redirectSystemPath({ path: link, initial: false })).toBeNull()
  })

  it.each([
    'podium://issues/POD-1606',
    'podium://session/abc?origin=https%3A%2F%2Fteam.podium.test&instance=x',
    'podium://signed-in?code=hoff_x&challenge=y',
    'podium://pairs/elsewhere',
    'https://team.podium.test/issues/POD-1606',
  ])('leaves %s to the router', (link) => {
    expect(redirectSystemPath({ path: link, initial: true })).toBe(link)
    expect(redirectSystemPath({ path: link, initial: false })).toBe(link)
  })

  it('is the file expo-router loads for native intents', () => {
    const app = readdirSync(resolve(import.meta.dirname, '../../app'))
    expect(app).toContain('+native-intent.ts')
    // No route claims /pair: the secret must never become router state.
    expect(app.filter((name) => /^pair\b/i.test(name))).toEqual([])
  })
})
