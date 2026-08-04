import { describe, expect, it } from 'vitest'
import { classifySkew, parseServerVersion } from './server-version'

const full = {
  appVersion: '0.4.2',
  wireVersion: 2,
  minSupportedVersion: 1,
  wireSchemaDigest: 'abc123',
  instanceId: 'inst-1',
}

describe('parseServerVersion is a frozen contract', () => {
  it('ignores unknown fields instead of failing', () => {
    const v = parseServerVersion({ ...full, aFieldAddedNextYear: { nested: true } })
    expect(v.wireVersion).toBe(2)
  })

  for (const key of Object.keys(full)) {
    it(`parses a payload with '${key}' absent`, () => {
      const partial = { ...full } as Record<string, unknown>
      delete partial[key]
      expect(() => parseServerVersion(partial)).not.toThrow()
    })
  }

  it('parses a completely empty payload', () => {
    expect(() => parseServerVersion({})).not.toThrow()
  })
})

it('parses a payload carrying a target descriptor', () => {
  const v = parseServerVersion({
    ...full,
    target: {
      version: '0.4.2',
      artifacts: {
        headless: { delivery: 'feed', url: 'https://x.test/a.tgz', digest: 'd', signature: 's' },
      },
    },
  })
  expect(v.target?.version).toBe('0.4.2')
})

it('drops a malformed target rather than failing the whole payload', () => {
  const v = parseServerVersion({ ...full, target: { nonsense: true } })
  expect(v.wireVersion).toBe(2)
  expect(v.target).toBeUndefined()
})

describe('classifySkew', () => {
  const local = { wire: 2, digest: 'abc123' }

  it('is ok on an exact match', () => {
    expect(classifySkew(parseServerVersion(full), local)).toBe('ok')
  })

  it('is ok when the server advertises no digest (an older server)', () => {
    const v = parseServerVersion({ ...full, wireSchemaDigest: undefined })
    expect(classifySkew(v, local)).toBe('ok')
  })

  it('is ok when the server advertises nothing at all', () => {
    expect(classifySkew(parseServerVersion({}), local)).toBe('ok')
  })

  it('reports client-too-old below the server minimum', () => {
    const v = parseServerVersion({ ...full, wireVersion: 3, minSupportedVersion: 3 })
    expect(classifySkew(v, local)).toBe('client-too-old')
  })

  it('reports client-too-new when this client is ahead of its server', () => {
    const v = parseServerVersion({ ...full, wireVersion: 1, minSupportedVersion: 1 })
    expect(classifySkew(v, local)).toBe('client-too-new')
  })

  it('reports schema-skew when the wire versions agree but the digests do not', () => {
    const v = parseServerVersion({ ...full, wireSchemaDigest: 'different' })
    expect(classifySkew(v, local)).toBe('schema-skew')
  })

  it('prefers the version verdict over the digest verdict', () => {
    const v = parseServerVersion({ ...full, wireVersion: 1, wireSchemaDigest: 'different' })
    expect(classifySkew(v, local)).toBe('client-too-new')
  })
})
