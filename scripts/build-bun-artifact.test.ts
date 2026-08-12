import { describe, expect, it } from 'vitest'
import { updateArtifactPath } from './build-bun'

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
