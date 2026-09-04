import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')
const app = JSON.parse(readFileSync(resolve(projectRoot, 'app.json'), 'utf8'))
const hostSource = readFileSync(resolve(import.meta.dirname, 'ServerProfileGate.tsx'), 'utf8')

describe('native Podium link registration and delivery', () => {
  it('registers the podium scheme with Expo for the iOS application bundle', () => {
    expect(app.expo.scheme).toBe('podium')
  })

  it('keeps cold and warm native URLs on the same mobile host path', () => {
    expect(hostSource).toContain('Linking.getInitialURL()')
    expect(hostSource).toContain("Linking.addEventListener('url', ({ url }) => handleLink(url))")
    const navigation = hostSource.indexOf('captureMobileHandoffUrl(raw)')
    const pairing = hostSource.indexOf('parsePairingLink(raw)', navigation)
    expect(navigation).toBeGreaterThan(-1)
    expect(pairing).toBeGreaterThan(navigation)
  })
})
