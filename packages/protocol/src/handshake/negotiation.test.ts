import { describe, expect, it } from 'vitest'
import { MIN_DAEMON_WIRE_VERSION, DAEMON_WIRE_VERSION } from '../version'
import {
  isReservedCap,
  negotiateCapabilities,
  negotiateVersion,
  RESERVED_CAPS,
} from './negotiation'

describe('version negotiation (ADR 5 D3.1)', () => {
  it('agrees on a supported version', () => {
    expect(negotiateVersion(DAEMON_WIRE_VERSION)).toEqual({ ok: true, agreed: DAEMON_WIRE_VERSION })
  })

  it('fails closed on a too-old peer and says what it supports', () => {
    const outcome = negotiateVersion(MIN_DAEMON_WIRE_VERSION - 1)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.rejection).toMatchObject({
      reason: 'unsupported-version',
      support: { wire: DAEMON_WIRE_VERSION, min: MIN_DAEMON_WIRE_VERSION },
    })
  })

  it('fails closed on a too-new peer rather than guessing', () => {
    expect(negotiateVersion(DAEMON_WIRE_VERSION + 1).ok).toBe(false)
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


describe('range negotiation', () => {
  it.each([
    [{ min: 1, max: 4 }, { min: 1, wire: 2 }, 2],
    [{ min: 1, max: 2 }, { min: 1, wire: 4 }, 2],
    [2, { min: 1, wire: 4 }, 2],
  ])('selects the highest overlap for %j against %j', (offer, support, agreed) => {
    expect(negotiateVersion(offer, support)).toEqual({ ok: true, agreed })
  })
  it('refuses disjoint windows in both directions', () => {
    expect(negotiateVersion({ min: 3, max: 4 }, { min: 1, wire: 2 }).ok).toBe(false)
    expect(negotiateVersion({ min: 1, max: 2 }, { min: 3, wire: 4 }).ok).toBe(false)
  })
})
