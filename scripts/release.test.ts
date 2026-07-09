import { describe, expect, it } from 'vitest'
import { buildHeadlessManifest } from './release'

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
})
