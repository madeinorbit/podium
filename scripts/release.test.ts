import { describe, expect, it } from 'vitest'
import { buildHeadlessManifest, buildHeadlessManifestForPlatforms } from './release'

describe('buildHeadlessManifest', () => {
  it('produces the Tauri-shaped headless manifest', () => {
    const json = buildHeadlessManifest({
      version: '0.2.0',
      url: 'https://github.com/madeinorbit/podium/releases/download/v0.2.0/podium-headless-linux-x64.tar.gz',
      signature: 'BASE64SIG',
    })
    const m = JSON.parse(json)
    expect(m.version).toBe('0.2.0')
    expect(m.platforms['linux-x86_64'].url).toMatch(/podium-headless-linux-x64\.tar\.gz$/)
    expect(m.platforms['linux-x86_64'].signature).toBe('BASE64SIG')
  })
  it('keys the platform entry by an explicit target when given', () => {
    const json = buildHeadlessManifest({
      version: '0.2.0',
      url: 'https://example.com/podium-headless-darwin-arm64.tar.gz',
      signature: 'SIG',
      target: 'darwin-aarch64',
    })
    const m = JSON.parse(json)
    expect(m.platforms['darwin-aarch64'].url).toMatch(/darwin-arm64\.tar\.gz$/)
    expect(m.platforms['linux-x86_64']).toBeUndefined()
  })

  it('publishes x64 and arm64 in one updater manifest', () => {
    const json = buildHeadlessManifestForPlatforms({
      version: '0.2.0',
      platforms: [
        {
          target: 'linux-x86_64',
          url: 'https://example.com/podium-headless-linux-x64.tar.gz',
          signature: 'SIG-X64',
        },
        {
          target: 'linux-aarch64',
          url: 'https://example.com/podium-headless-linux-arm64.tar.gz',
          signature: 'SIG-ARM64',
        },
      ],
    })
    const m = JSON.parse(json)
    expect(m.platforms['linux-x86_64'].signature).toBe('SIG-X64')
    expect(m.platforms['linux-aarch64']).toEqual({
      url: 'https://example.com/podium-headless-linux-arm64.tar.gz',
      signature: 'SIG-ARM64',
    })
  })
})
