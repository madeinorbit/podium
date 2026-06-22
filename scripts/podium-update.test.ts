import { describe, expect, it } from 'vitest'
import { isNewer, parseManifest } from './podium-update'

describe('podium update helpers', () => {
  it('isNewer compares semver-ish versions', () => {
    expect(isNewer('0.1.1', '0.1.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.2.0', '0.10.0')).toBe(false)
  })
  it('parseManifest extracts version + linux url', () => {
    const m = parseManifest(
      JSON.stringify({
        version: '0.1.1',
        platforms: { 'linux-x86_64': { url: 'http://h/a.tar.gz', signature: 'x' } },
      }),
    )
    expect(m).toEqual({ version: '0.1.1', url: 'http://h/a.tar.gz' })
  })
})
