import { describe, expect, it } from 'vitest'
import {
  blobKey,
  decodeKeySegment,
  InvalidBlobKey,
  isBlobKey,
  isKeySegment,
  joinKey,
  keySegment,
  MAX_ENCODED_ID_BYTES,
  MAX_KEY_BYTES,
  MAX_SEGMENT_BYTES,
  padNumber,
  parsePadded,
} from './key'

describe('blobKey', () => {
  it('accepts relative paths of [A-Za-z0-9._-] segments and encoded segments', () => {
    for (const key of [
      'a',
      'artifacts/POD-12/art_1/index.html',
      'transcripts/m1/~nzqxi2lwmuqgsza/000001/000000',
      'x/.hidden/..dots/a.b-c_d',
      'x/...',
    ]) {
      expect(blobKey(key)).toBe(key)
      expect(isBlobKey(key)).toBe(true)
    }
  })

  it('refuses empty, absolute, dot, odd-character and reserved keys', () => {
    for (const key of [
      '',
      '/a',
      'a/',
      'a//b',
      '.',
      '..',
      'a/./b',
      'a/../b',
      'a b',
      'a\\b',
      'a/é',
      'a:b',
      '~',
      '~a+b',
      '~a=',
      '~MZXQ',
      '~a1',
      'a/.tmp-0c0a7e4e-1a2b-4c3d-8e9f-001122334455',
      '.tmp-anything',
    ]) {
      expect(isBlobKey(key), key).toBe(false)
      expect(() => blobKey(key), key).toThrow(InvalidBlobKey)
    }
  })

  it('bounds segment and key length', () => {
    expect(isBlobKey('a'.repeat(255))).toBe(true)
    expect(isBlobKey('a'.repeat(256))).toBe(false)
    const long = Array.from({ length: 250 }, () => 'abcd').join('/')
    expect(long.length).toBeGreaterThan(MAX_KEY_BYTES)
    expect(isBlobKey(long)).toBe(false)
  })

  it('joins validated segments', () => {
    expect(joinKey('artifacts', 'i1', 'a1')).toBe('artifacts/i1/a1')
    expect(joinKey(blobKey('artifacts/i1'), 'a1')).toBe('artifacts/i1/a1')
    expect(() => joinKey('artifacts', '..')).toThrow(InvalidBlobKey)
    expect(() => joinKey('artifacts', 'a/')).toThrow(InvalidBlobKey)
  })
})

describe('keySegment', () => {
  it('keeps a plain segment as it is', () => {
    for (const id of ['abc', 'POD-12', 'a.b_c-d', '0001']) expect(keySegment(id)).toBe(id)
  })

  it("encodes any other id as '~' + lower-case base32 and decodes it back", () => {
    for (const id of [
      'native id',
      'a/b',
      '..',
      '.',
      '~already',
      '.tmp-x',
      'é',
      '日本語',
      'a+b=c',
      'x '.repeat(50),
    ]) {
      const segment = keySegment(id)
      expect(segment.startsWith('~'), id).toBe(true)
      expect(isKeySegment(segment), id).toBe(true)
      expect(segment).toMatch(/^~[a-z2-7]+$/)
      expect(decodeKeySegment(segment)).toBe(id)
      expect(isBlobKey(`transcripts/${segment}/1`)).toBe(true)
    }
    expect(decodeKeySegment('plain')).toBe('plain')
  })

  it('uses the RFC 4648 base32 alphabet in lower case without padding', () => {
    // RFC 4648 section 10 test vectors, lower-cased and unpadded.
    const vectors: Array<[string, string]> = [
      ['f', 'my'],
      ['fo', 'mzxq'],
      ['foo', 'mzxw6'],
      ['foob', 'mzxw6yq'],
      ['fooba', 'mzxw6ytb'],
      ['foobar', 'mzxw6ytboi'],
    ]
    for (const [id, encoded] of vectors) expect(decodeKeySegment(`~${encoded}`)).toBe(id)
    expect(keySegment('foo bar')).toBe('~mzxw6idcmfza')
  })

  it('encodes two ids that differ only in case to segments that differ case-insensitively', () => {
    for (const [a, b] of [
      ['Native Id', 'native id'],
      ['A b', 'a b'],
      ['ÄÖ x', 'äö x'],
      ['X/Y', 'x/y'],
    ] as const) {
      const sa = keySegment(a)
      const sb = keySegment(b)
      expect(sa.startsWith('~') && sb.startsWith('~')).toBe(true)
      expect(sa.toLowerCase()).not.toBe(sb.toLowerCase())
      expect(sa).toBe(sa.toLowerCase())
    }
  })

  it('refuses a non-canonical or non-UTF-8 encoding', () => {
    // 'mz' carries one byte with non-zero trailing bits; 'my' is the canonical form of 'f'.
    expect(() => decodeKeySegment('~mz')).toThrow(InvalidBlobKey)
    // A length no byte string encodes to.
    expect(() => decodeKeySegment('~abc')).toThrow(InvalidBlobKey)
    // 0xff is not UTF-8.
    expect(() => decodeKeySegment('~74')).toThrow(InvalidBlobKey)
  })

  it('never maps two ids to one segment', () => {
    const ids = ['a', '~a', '~YQ', 'YQ', 'a b', 'a+b', '.', '..', '...', '']
    const segments = new Set<string>()
    for (const id of ids.filter((i) => i !== '')) segments.add(keySegment(id))
    expect(segments.size).toBe(ids.length - 1)
  })

  it('refuses an empty id and an id too long to encode', () => {
    expect(MAX_ENCODED_ID_BYTES).toBe(158)
    expect(() => keySegment('')).toThrow(InvalidBlobKey)
    const longest = `${'x'.repeat(MAX_ENCODED_ID_BYTES - 1)} `
    expect(keySegment(longest).length).toBeLessThanOrEqual(MAX_SEGMENT_BYTES)
    expect(decodeKeySegment(keySegment(longest))).toBe(longest)
    expect(() => keySegment(`${longest}x`)).toThrow(InvalidBlobKey)
    expect(() => keySegment('é'.repeat(80))).toThrow(InvalidBlobKey)
  })

  it('refuses to decode something that is not a segment', () => {
    expect(() => decodeKeySegment('a/b')).toThrow(InvalidBlobKey)
    expect(() => decodeKeySegment('~a=')).toThrow(InvalidBlobKey)
  })
})

describe('padNumber', () => {
  it('zero-pads so string order is numeric order', () => {
    expect(padNumber(0, 6)).toBe('000000')
    expect(padNumber(42, 6)).toBe('000042')
    expect(padNumber(999999, 6)).toBe('999999')
    const values = [10, 9, 100, 1, 0, 55]
    const sorted = values.map((v) => padNumber(v, 4)).sort()
    expect(sorted.map((s) => parsePadded(s, 4))).toEqual([...values].sort((a, b) => a - b))
  })

  it('refuses values that do not fit and bad inputs', () => {
    expect(() => padNumber(1_000_000, 6)).toThrow(RangeError)
    expect(() => padNumber(-1, 6)).toThrow(RangeError)
    expect(() => padNumber(1.5, 6)).toThrow(RangeError)
    expect(() => padNumber(1, 0)).toThrow(RangeError)
  })

  it('parses only segments of the exact width', () => {
    expect(parsePadded('000042', 6)).toBe(42)
    expect(() => parsePadded('42', 6)).toThrow(RangeError)
    expect(() => parsePadded('00004a', 6)).toThrow(RangeError)
    expect(() => parsePadded('-00001', 6)).toThrow(RangeError)
  })
})
