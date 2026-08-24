import { describe, expect, it } from 'vitest'
import { classifyAssets, classifySkew, parseServerVersion, type ServerVersion } from './server-version'

const full = {
  appVersion: '0.4.2',
  sourceDigest: '47a01e3',
  installKind: 'installed',
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
  it('drops an unfamiliar install kind without dropping the version payload', () => {
    const parsed = parseServerVersion({ ...full, installKind: 'something-new' })
    expect(parsed.installKind).toBeUndefined()
    expect(parsed.appVersion).toBe(full.appVersion)
  })
})

it('parses a payload carrying a target descriptor', () => {
  const v = parseServerVersion({
    ...full,
    target: {
      version: '0.4.2',
      critical: false,
      artifacts: {
        headless: {
          delivery: 'feed',
          platforms: {
            'linux-x86_64': { url: 'https://x.test/a.tgz', digest: 'd', signature: 's' },
          },
        },
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

/**
 * THE FACT THAT MOVED IN POD-2721, in the numbers the sandbox actually reported.
 *
 * Two builds of the SAME commit `a55ec3d` were served in turn — the packaged
 * `0.1.1-edge.2` (`bundle+Bw5YMffE`) and the dev release `0.1.1-dev.1+a55ec3d`
 * (`bundle+CFyX4Q_p`). A source-digest comparison sees one commit and says
 * "fine"; the wire schema is byte-identical in both, so `classifySkew` says
 * "fine" too. The only field that moved is the one that decides whether a
 * loaded page's chunk URLs still resolve.
 */
describe('classifyAssets', () => {
  const served = (bundle: string): ServerVersion =>
    parseServerVersion({
      ...full,
      appVersion: '0.1.1-dev.1+a55ec3d',
      sourceDigest: 'a55ec3d',
      web: { present: true, appVersion: '0.1.1-dev.1+a55ec3d', digest: 'a55ec3d', bundle },
    })

  it('calls the page replaced when the served entry chunk is a different build', () => {
    expect(classifyAssets(served('bundle+CFyX4Q_p').web, { bundle: 'bundle+Bw5YMffE' })).toBe('replaced')
  })

  it('is symmetric, because a rollback replaces the page just as an update does', () => {
    expect(classifyAssets(served('bundle+Bw5YMffE').web, { bundle: 'bundle+CFyX4Q_p' })).toBe('replaced')
  })

  it('says ok when the page is running the bundle the server serves', () => {
    expect(classifyAssets(served('bundle+Bw5YMffE').web, { bundle: 'bundle+Bw5YMffE' })).toBe('ok')
  })

  it('would have missed the incident on source digest alone', () => {
    const server = served('bundle+CFyX4Q_p')
    // Same commit on both ends — the reason nothing fired.
    expect(server.sourceDigest).toBe('a55ec3d')
    expect(server.web?.digest).toBe('a55ec3d')
    expect(classifySkew(server, { wire: 2, digest: 'abc123' })).toBe('ok')
    // And yet the page's assets are gone.
    expect(classifyAssets(server.web, { bundle: 'bundle+Bw5YMffE' })).toBe('replaced')
  })

  /**
   * NEVER MANUFACTURE A RELOAD. Each of these is a build we cannot identify, and
   * an unidentifiable build must not be reported as replaced — that is how a
   * reload offer becomes a reload offer nobody can clear (POD-2608).
   */
  it('is unknown when the page cannot name its own bundle', () => {
    expect(classifyAssets(served('bundle+CFyX4Q_p').web, { bundle: undefined })).toBe('unknown')
  })

  it('is unknown when the server does not report a served bundle', () => {
    expect(classifyAssets(parseServerVersion(full).web, { bundle: 'bundle+Bw5YMffE' })).toBe('unknown')
  })

  it('is unknown when the server serves no website at all', () => {
    const apiOnly = parseServerVersion({ ...full, web: { present: false } })
    expect(classifyAssets(apiOnly.web, { bundle: 'bundle+Bw5YMffE' })).toBe('unknown')
  })

  it('is unknown when the served website is present but unstamped', () => {
    const unstamped = parseServerVersion({ ...full, web: { present: true } })
    expect(classifyAssets(unstamped.web, { bundle: 'bundle+Bw5YMffE' })).toBe('unknown')
  })

  it('survives a served-web payload it cannot parse rather than losing the version', () => {
    const parsed = parseServerVersion({ ...full, web: { present: 'yes please' } })
    expect(parsed.appVersion).toBe(full.appVersion)
    expect(classifyAssets(parsed.web, { bundle: 'bundle+Bw5YMffE' })).toBe('unknown')
  })
})

/**
 * A page belongs to exactly ONE of a server's websites, and the desktop dist and
 * the phone export are built by different toolchains — Vite's base64url-8 and
 * Metro's hex-32. Handed the wrong one, this would answer `replaced` forever and
 * offer a reload that cannot clear it, which is POD-2608 by another road. The
 * function is therefore given the pair, never asked to guess it.
 */
it('classifies a phone page against the phone export, not the desktop dist', () => {
  const server = parseServerVersion({
    ...full,
    web: { present: true, bundle: 'bundle+CFyX4Q_p' },
    mobileWeb: { present: true, bundle: 'bundle+a833d1a61f7a6d85a8c7fe49922500f0' },
  })
  const phonePage = { bundle: 'bundle+a833d1a61f7a6d85a8c7fe49922500f0' }
  expect(classifyAssets(server.mobileWeb, phonePage)).toBe('ok')
  // The same page against the desktop dist would be permanently, wrongly stale.
  expect(classifyAssets(server.web, phonePage)).toBe('replaced')
})

it('says unknown when handed no served website at all', () => {
  expect(classifyAssets(undefined, { bundle: 'bundle+Bw5YMffE' })).toBe('unknown')
})
