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

  it('index.html carries the iOS standalone meta + matching theme-color', () => {
    const html = readWeb('index.html')
    expect(html).toContain('name="theme-color" content="#0e0e12"')
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"')
    expect(html).toContain('apple-mobile-web-app-status-bar-style')
    expect(html).toContain('name="apple-mobile-web-app-title" content="Podium"')
  })
})

describe('update prompt', () => {
  it('UpdatePrompt uses the SW registration to detect and apply new builds', () => {
    const src = readWeb('src/UpdatePrompt.tsx')
    expect(src).toContain("from 'virtual:pwa-register/react'")
    expect(src).toContain('useRegisterSW')
    expect(src).toContain('onRegisteredSW')
    expect(src).toContain('registration.update()')
    expect(src).toContain('visibilitychange')
    expect(src).toContain('updateServiceWorker(true)')
    // Reload must be driven by controllerchange, not the library's isUpdate-gated
    // auto-reload (which no-ops on uncontrolled normal-browser tabs).
    expect(src).toContain('controllerchange')
  })

  it('AppShell always mounts the update prompt', () => {
    const src = readWeb('src/AppShell.tsx')
    expect(src).toContain('UpdatePrompt')
    expect(src).toContain('<UpdatePrompt')
  })
})
