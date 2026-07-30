import { describe, expect, it } from 'vitest'
import { MIN_SUPPORTED_VERSION, WIRE_VERSION } from '../version'
import {
  isReservedCap,
  negotiateCapabilities,
  negotiateVersion,
  RESERVED_CAPS,
} from './negotiation'

describe('version negotiation (ADR 5 D3.1)', () => {
  it('agrees on a supported version', () => {
    expect(negotiateVersion(WIRE_VERSION)).toEqual({ ok: true, agreed: WIRE_VERSION })
  })

  it('fails closed on a too-old peer and says what it supports', () => {
    const outcome = negotiateVersion(MIN_SUPPORTED_VERSION - 1)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.rejection).toMatchObject({
      reason: 'unsupported-version',
      support: { wire: WIRE_VERSION, min: MIN_SUPPORTED_VERSION },
    })
  })

  it('fails closed on a too-new peer rather than guessing', () => {
    expect(negotiateVersion(WIRE_VERSION + 1).ok).toBe(false)
  })

  it('fails closed on a non-integer version', () => {
    expect(negotiateVersion(Number.NaN).ok).toBe(false)
    expect(negotiateVersion(1.5).ok).toBe(false)
  })
})

describe('capability negotiation (ADR 5 D3.3)', () => {
  it('returns the intersection, never the offer echoed back', () => {
    const result = negotiateCapabilities(['metadataDelta', 'somethingElse'], ['metadataDelta'])
    expect(result.accepted).toEqual(['metadataDelta'])
    expect(result.ignored).toEqual(['somethingElse'])
  })

  it('a peer cannot grant itself a capability by naming it', () => {
    expect(negotiateCapabilities(['metadataDelta'], []).accepted).toEqual([])
  })

  it('absence means legacy defaults, not an error', () => {
    expect(negotiateCapabilities([], ['metadataDelta'])).toEqual({
      accepted: [],
      ignored: [],
      reserved: [],
    })
  })
})

describe('reserved node-peer capability surface (ADR 5 D4)', () => {
  it('every reserved token is recognised as reserved', () => {
    for (const token of RESERVED_CAPS) expect(isReservedCap(token)).toBe(true)
    // …and the feed family is reserved by prefix.
    expect(isReservedCap('feed.abc123')).toBe(true)
    expect(isReservedCap('metadataDelta')).toBe(false)
  })

  it('reserved tokens are SEEN and still never accepted', () => {
    const result = negotiateCapabilities(
      ['peerRole:node', 'feed.f1', 'upstream.push', 'metadataDelta'],
      ['metadataDelta'],
    )
    expect(result.accepted).toEqual(['metadataDelta'])
    expect(result.reserved).toEqual(['peerRole:node', 'feed.f1', 'upstream.push'])
  })

  it('a reserved token is not granted even if this build lists it as supported', () => {
    // Defence against a future implementer wiring a reserved token into the
    // supported list without deleting its RESERVED entry.
    const result = negotiateCapabilities(['upstream.sync'], ['upstream.sync'])
    expect(result.accepted).toEqual([])
    expect(result.reserved).toEqual(['upstream.sync'])
  })
})
