import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const readWeb = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

describe('installable PWA wiring', () => {
  it('vite config registers vite-plugin-pwa with a prompt update flow', () => {
    const cfg = readWeb('vite.config.ts')
    expect(cfg).toContain('VitePWA')
    expect(cfg).toContain("registerType: 'prompt'")
    expect(cfg).toContain('devOptions: { enabled: false }')
    expect(cfg).toContain('pwaAssets')
  })

  it('the service worker falls back to the shell but never shadows the live API/WS routes', () => {
    const cfg = readWeb('vite.config.ts')
    expect(cfg).toContain("navigateFallback: '/index.html'")
    expect(cfg).toContain('navigateFallbackDenylist')
    expect(cfg).toContain('/^\\/trpc/')
    expect(cfg).toContain('/^\\/daemon/')
  })

  it('manifest declares a standalone dark app', () => {
    const cfg = readWeb('vite.config.ts')
    expect(cfg).toContain("name: 'Podium'")
    expect(cfg).toContain("display: 'standalone'")
    expect(cfg).toContain("theme_color: '#0e0e12'")
    expect(cfg).toContain("background_color: '#0e0e12'")
  })
})
