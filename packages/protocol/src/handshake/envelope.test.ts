import { describe, expect, it } from 'vitest'
import { DELIVERY_CAPS, PeerHello, PeerIdentityClaims } from './envelope'

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

  it('lets a newer daemon reach an older acceptor that strips the additive field', () => {
    // This models the pre-build schema: PeerHello is a plain z.object, so the
    // unknown additive key is ignored instead of rejecting the hello.
    const oldPeerHello = PeerHello.omit({ build: true })
    const parsed = oldPeerHello.parse({
      ...baseHello,
      build: { appVersion: '0.4.2', installKind: 'installed' },
    })
    expect(parsed).not.toHaveProperty('build')
    expect(parsed).toMatchObject(baseHello)
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

  /**
   * POD-1361 swept every machine-id field onto `MachineIdField` and upheld THIS
   * one as the single exception: a peer's claim about which machine it is, which
   * ADR 3 D7.1 / D14.3 forbids anything from treating as a principal. The brand
   * adds no validation, so the two spellings PARSE identically — the difference
   * is only ever a type error at the assignment the exception exists to stop, and
   * that is what this pins.
   */
  it('leaves the claimed machineId UNBRANDED — a claim is not an identity', () => {
    const claims = PeerIdentityClaims.parse({ machineId: 'not-a-verified-id' })
    // An ARBITRARY string is assignable to this field only while it is unbranded.
    // Branding it makes this line a type error — which is the whole signal, in the
    // direction that matters: it would equally stop
    // `redeemPairCode({ machineId: hello.claims.machineId })` from reading as a
    // verified id, and that assignment is the one this exception exists to keep
    // visible rather than to make.
    const claimed: typeof claims.machineId = 'any-string-a-peer-cares-to-send'
    expect(claimed).toBe('any-string-a-peer-cares-to-send')
    expect(claims.machineId).toBe('not-a-verified-id')
    // Verify the instrument: the schema must actually carry the field, or the
    // assignment above proves nothing about a field that is not there.
    expect(Object.keys(PeerIdentityClaims.shape)).toContain('machineId')
  })

  it('names the three delivery capability tokens', () => {
    expect(DELIVERY_CAPS).toEqual([
      'update.delivery.feed',
      'update.delivery.bundle',
      'update.delivery.git',
    ])
  })
})
