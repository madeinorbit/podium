import { describe, expect, it } from 'vitest'
import { requireInstant, toInstant, toIso } from './clock'

describe('toInstant — wire → model', () => {
  it('reads a full ISO instant', () => {
    expect(toInstant('2026-07-13T12:00:00.000Z')).toBe(Date.parse('2026-07-13T12:00:00.000Z'))
  })

  it('reads a bare YYYY-MM-DD date as UTC midnight (the defer presets)', () => {
    expect(toInstant('2026-07-13')).toBe(Date.parse('2026-07-13T00:00:00.000Z'))
  })

  it('passes an epoch number through', () => {
    expect(toInstant(1_783_944_000_000)).toBe(1_783_944_000_000)
  })

  it('is null for absent or unparseable input — never a silent epoch 0', () => {
    expect(toInstant(null)).toBeNull()
    expect(toInstant(undefined)).toBeNull()
    expect(toInstant('')).toBeNull()
    expect(toInstant('next-message')).toBeNull()
    expect(toInstant('whenever')).toBeNull()
    expect(toInstant(Number.NaN)).toBeNull()
    expect(toInstant(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('requireInstant — the server-edge adapter', () => {
  it('converts an ISO now', () => {
    expect(requireInstant('2026-07-13T12:00:00.000Z')).toBe(Date.parse('2026-07-13T12:00:00.000Z'))
  })

  it('throws rather than inventing a fallback for a broken clock', () => {
    expect(() => requireInstant('not a time')).toThrow(/not a timestamp/)
  })
})

describe('toIso — model → wire', () => {
  it('round-trips byte-identically with what the server writes itself', () => {
    const iso = '2026-07-13T12:00:00.000Z'
    expect(toIso(requireInstant(iso))).toBe(iso)
    // Bare dates normalize to the instant's full spelling, which is what the
    // server would have written for the same moment.
    expect(toIso(requireInstant('2026-07-13'))).toBe('2026-07-13T00:00:00.000Z')
  })
})
