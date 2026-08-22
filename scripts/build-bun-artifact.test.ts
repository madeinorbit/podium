import { describe, expect, it } from 'vitest'
import {
  assertDevClientDistMatchesVersion,
  assertDevWebDistMatchesVersion,
  updateArtifactPath,
} from './build-bun'

describe('assertDevWebDistMatchesVersion', () => {
  it('lets a release version pack without a source SHA', () => {
    expect(() => assertDevWebDistMatchesVersion('0.4.2', null)).not.toThrow()
  })

  it('refuses a development tarball whose web stamp is a different commit', () => {
    expect(() => assertDevWebDistMatchesVersion('dev+47a01e3', { sourceSha: 'aaaaaaa' })).toThrow(
      /not built from dev\+47a01e3/,
    )
  })

  it('refuses a development tarball with no web stamp SHA', () => {
    expect(() => assertDevWebDistMatchesVersion('dev+47a01e3', null)).toThrow(/sourceSha=missing/)
  })

  it('accepts a development tarball whose web stamp is that commit', () => {
    expect(() =>
      assertDevWebDistMatchesVersion('dev+47a01e3', { sourceSha: '47a01e3' }),
    ).not.toThrow()
  })

  it('names the stale client site when the Expo export is from another commit', () => {
    expect(() =>
      assertDevClientDistMatchesVersion('dev+47a01e3', 'apps/mobile/dist', {
        sourceSha: 'aaaaaaa',
      }),
    ).toThrow(/apps\/mobile\/dist was not built from dev\+47a01e3/)
  })

  it('still guards publisher-minted versions (not only the legacy det+ form)', () => {
    expect(() =>
      assertDevWebDistMatchesVersion('0.1.0-dev.5+47a01e3', {
        sourceSha: 'aaaaaaa',
      }),
    ).toThrow(/not built from 0\.1\.0-dev\.5\+47a01e3/)
    expect(() =>
      assertDevWebDistMatchesVersion('0.1.0-dev.5+47a01e3', {
        sourceSha: '47a01e3',
      }),
    ).not.toThrow()
  })
})

describe('updateArtifactPath', () => {
  it('defaults to the versioned name a release reads', () => {
    // scripts/release.ts looks for exactly this path.
    expect(updateArtifactPath('/repo/dist-bun', '0.2.0', {})).toBe(
      '/repo/dist-bun/podium-headless-0.2.0.tar.gz',
    )
  })

  it('writes where a caller that owns the artifact tells it to', () => {
    // The development publisher stamps the build time into the name so its
    // retention sweep can order bundles; this is the process boundary that
    // carries it. The shape is pinned on the other side by
    // `parseDevBundleName` in apps/server/src/modules/updates/dev-bundle.ts.
    const requested = '/repo/dist-bun/podium-headless-dev+abc1234-20260812T182015Z.tar.gz'
    expect(
      updateArtifactPath('/repo/dist-bun', 'dev+abc1234', {
        PODIUM_BUNDLE_ARTIFACT: requested,
      }),
    ).toBe(requested)
  })

  it('treats a blank request as no request, never as a path', () => {
    for (const value of ['', '   ', undefined]) {
      expect(updateArtifactPath('/repo/dist-bun', '0.2.0', { PODIUM_BUNDLE_ARTIFACT: value })).toBe(
        '/repo/dist-bun/podium-headless-0.2.0.tar.gz',
      )
    }
  })
})
