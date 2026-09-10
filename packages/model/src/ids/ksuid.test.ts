import { describe, expect, it, vi } from 'vitest'
import {
  isKsuid,
  KSUID_LENGTH,
  ksuid,
  ksuidInstant,
  MAX_KSUID_INSTANT,
  MIN_KSUID_INSTANT,
} from './ksuid'

const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? [])

/** Every random byte the same, so a mint is a pure function of its instant. */
const fixed = (fill: number) => (length: number) => new Uint8Array(length).fill(fill)

/**
 * WHY THIS FILE EXISTS: `packages/model` may depend on nothing but zod, so the
 * KSUID here is ours rather than a library's — which means the encoding has to
 * be pinned against the reference implementation rather than assumed, and the
 * two properties the id scheme is CHOSEN for (a fixed width, and a lexicographic
 * order that is creation order) have to be pinned against the ways a hand-rolled
 * base62 gets them wrong.
 */

describe('the encoding matches the reference implementation', () => {
  it('reproduces the canonical KSUID from segmentio/ksuid', () => {
    // The example in that project's README, whole:
    //   Raw  0669F7EF B5A1CD34B5F99D1154FB6853345C9735
    //   Time 2017-10-09 21:00:47 -0700  (epoch second 1507608047)
    //   Str  0ujtsYcgvSTl8PAuAdqWYSMnLOv
    // A different alphabet, a little-endian timestamp, or a different epoch
    // offset all still produce 27 plausible characters — only this vector says
    // the bytes we emit are the bytes everyone else calls a KSUID.
    const payload = bytes('B5A1CD34B5F99D1154FB6853345C9735')
    expect(ksuid(1_507_608_047_000, () => payload)).toBe('0ujtsYcgvSTl8PAuAdqWYSMnLOv')
  })

  it('left-pads to the fixed width rather than emitting the shorter number', () => {
    // The canonical vector above is the padding case: its natural base62
    // spelling is 26 characters and the leading '0' is padding. An encoder that
    // returns the number's own length round-trips fine and sorts WRONG, because
    // a short id sorts above a long one whatever their timestamps say.
    const natural = ksuid(1_507_608_047_000, () => bytes('B5A1CD34B5F99D1154FB6853345C9735'))
    expect(natural).toHaveLength(KSUID_LENGTH)
    expect(natural.startsWith('0')).toBe(true)
  })
})

describe('the width is fixed', () => {
  it('is 27 characters at the bottom, at the top, and across a thousand mints', () => {
    expect(ksuid(MIN_KSUID_INSTANT, fixed(0x00))).toHaveLength(KSUID_LENGTH)
    expect(ksuid(MAX_KSUID_INSTANT, fixed(0xff))).toHaveLength(KSUID_LENGTH)
    for (let i = 0; i < 1000; i++) expect(ksuid()).toHaveLength(KSUID_LENGTH)
  })

  it('uses only the base62 alphabet', () => {
    for (let i = 0; i < 200; i++) expect(ksuid()).toMatch(/^[0-9A-Za-z]{27}$/)
  })
})

describe('ids sort by creation time', () => {
  it('orders a decade of mints lexicographically, in creation order', () => {
    // The whole reason for a timestamp prefix: `ORDER BY id` is `ORDER BY
    // created_at`, and an index on the id keeps rows minted together together.
    const day = 86_400_000
    const minted = Array.from({ length: 500 }, (_, i) => ksuid(1_600_000_000_000 + i * 7 * day))
    expect([...minted].sort()).toEqual(minted)
  })

  it('orders across the second boundary that random payloads would otherwise decide', () => {
    // The adversarial case for "sorts by time": the LATER id gets the smallest
    // possible payload and the earlier one the largest, so anything but a
    // leading big-endian timestamp puts them the wrong way round.
    const earlier = ksuid(1_600_000_000_000, fixed(0xff))
    const later = ksuid(1_600_000_001_000, fixed(0x00))
    expect(earlier < later).toBe(true)
  })
})

describe('the instant round-trips through the first four bytes', () => {
  it('returns the minting instant, truncated to the second', () => {
    expect(ksuidInstant(ksuid(1_507_608_047_842))).toBe(1_507_608_047_000)
  })

  it('reads the reference vector back as its documented time', () => {
    expect(ksuidInstant('0ujtsYcgvSTl8PAuAdqWYSMnLOv')).toBe(1_507_608_047_000)
  })

  it('refuses a value that is not a KSUID rather than inventing a time', () => {
    expect(() => ksuidInstant('nope')).toThrow(/not a KSUID/)
  })
})

describe('validation', () => {
  it('accepts a minted id', () => {
    expect(isKsuid(ksuid())).toBe(true)
  })

  it('rejects the wrong width', () => {
    const minted = ksuid()
    expect(isKsuid(minted.slice(1))).toBe(false)
    expect(isKsuid(`${minted}0`)).toBe(false)
    expect(isKsuid('')).toBe(false)
  })

  it('rejects a character outside the alphabet', () => {
    expect(isKsuid(`${ksuid().slice(1)}-`)).toBe(false)
    expect(isKsuid(`${ksuid().slice(1)}_`)).toBe(false)
  })

  it('rejects 27 legal characters that overflow twenty bytes', () => {
    // 62^27 is bigger than 2^160, so the width alone does not make a string a
    // KSUID: 'zzz…' decodes to a number no twenty bytes can hold. A regex-only
    // check accepts it and then `ksuidInstant` reads a timestamp off a value
    // that was never minted.
    expect(isKsuid('z'.repeat(27))).toBe(false)
    expect(() => ksuidInstant('z'.repeat(27))).toThrow(/not a KSUID/)
  })
})

describe('the four-byte timestamp bounds the mintable range', () => {
  it('refuses an instant before the KSUID epoch', () => {
    expect(() => ksuid(1_399_999_999_000)).toThrow(/outside the KSUID range/)
  })

  it('refuses an instant past the last second four bytes can hold', () => {
    expect(ksuid(MAX_KSUID_INSTANT)).toHaveLength(KSUID_LENGTH)
    expect(() => ksuid(MAX_KSUID_INSTANT + 1000)).toThrow(/outside the KSUID range/)
  })
})

describe('the random payload', () => {
  it('makes ids minted in the same second distinct', () => {
    const at = 1_600_000_000_000
    const minted = new Set(Array.from({ length: 1000 }, () => ksuid(at)))
    expect(minted.size).toBe(1000)
  })

  it('refuses to mint when the platform has no randomness, rather than degrading', () => {
    // An identity mint that silently falls back to Math.random is a mint whose
    // collision odds nobody can state. Callers on such a platform pass their own
    // source; they do not get a quietly weaker id.
    vi.stubGlobal('crypto', undefined)
    try {
      expect(() => ksuid()).toThrow(/no source of randomness/)
      expect(ksuid(1_600_000_000_000, fixed(0x01))).toHaveLength(KSUID_LENGTH)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
