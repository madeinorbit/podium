import { describe, expect, it } from 'vitest'
import { DELIVERY_CAPS, PeerHello } from './envelope'

const baseHello = {
  type: 'peerHello' as const,
  v: 2,
  caps: [],
  credential: { kind: 'daemonSecret' as const, secret: 's' },
}

describe('PeerHello build report', () => {
  it('parses a hello with no build report (an older peer)', () => {
    const parsed = PeerHello.parse(baseHello)
    expect(parsed.build).toBeUndefined()
  })

  it('parses a full build report', () => {
    const parsed = PeerHello.parse({
      ...baseHello,
      build: { appVersion: '0.4.2', wireSchemaDigest: 'abc123', installKind: 'installed' },
    })
    expect(parsed.build).toEqual({
      appVersion: '0.4.2',
      wireSchemaDigest: 'abc123',
      installKind: 'installed',
    })
  })

  it('accepts a development identity, which is not a semver', () => {
    const parsed = PeerHello.parse({ ...baseHello, build: { appVersion: 'dev+9f3a1c2' } })
    expect(parsed.build?.appVersion).toBe('dev+9f3a1c2')
  })

  it('keeps unknown build fields instead of rejecting them (forward compatible)', () => {
    const parsed = PeerHello.parse({
      ...baseHello,
      build: { appVersion: '0.4.2', somethingNewerPeersSend: true },
    })
    expect(parsed.build?.appVersion).toBe('0.4.2')
  })

  it('rejects an installKind outside the closed set', () => {
    expect(() => PeerHello.parse({ ...baseHello, build: { installKind: 'wat' } })).toThrow()
  })

  it('names the three delivery capability tokens', () => {
    expect(DELIVERY_CAPS).toEqual([
      'update.delivery.feed',
      'update.delivery.bundle',
      'update.delivery.git',
    ])
  })
})
