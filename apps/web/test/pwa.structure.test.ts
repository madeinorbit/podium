// @vitest-environment node
// Reads source files off disk via import.meta.url — needs the real file URL,
// which happy-dom (this package's default test env) mangles. The repo-root
// config runs these in node; this matches it for the worktree-local config.
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

describe('PWA shell height + safe-area inset', () => {
  it('desktop-shell uses dvh (not the 100% chain) to fill the viewport in standalone', () => {
    const css = readWeb('src/styles.css')
    // The desktop shell must use dvh so it fills the dynamic viewport in
    // standalone PWA mode. A plain 100% height chains off html/body/#root and
    // can leave dead space below the composer on iOS home-indicator screens.
    expect(css).toMatch(/\.desktop-shell\s*\{[^}]*height:\s*100dvh/)
    // Must NOT fall back to the 100% chain for desktop-shell height.
    expect(css).not.toMatch(/\.desktop-shell\s*\{[^}]*height:\s*100%/)
  })

  it('safe-area-inset-bottom is NOT applied to the shell root (composer owns it once)', () => {
    const css = readWeb('src/styles.css')
    // The global safe-area padding belongs in the bottommost UI component
    // (ChatView composer / SuperagentView composer / mobile toolbar), not on the
    // shell wrapper. If the shell added it too the inset would be double-counted.
    // Guard: no padding-bottom referencing safe-area-inset-bottom on .desktop-shell
    // or .mobile-shell directly (the toolbar rule inside .mobile-shell is fine).
    const desktopBlock = css.match(/\.desktop-shell\s*\{[^}]*\}/)?.[0] ?? ''
    expect(desktopBlock).not.toContain('safe-area-inset-bottom')
  })

  it('mobile-shell uses dvh (via --viewport-h fallback) not a fixed 100vh', () => {
    const css = readWeb('src/styles.css')
    // mobile-shell must NOT use the old fixed 100vh (layout viewport), which
    // doesn't shrink when the soft keyboard opens.
    const mobileBlock = css.match(/\.mobile-shell\s*\{[^}]*\}/)?.[0] ?? ''
    expect(mobileBlock).not.toContain('100vh')
    expect(mobileBlock).toMatch(/100dvh/)
  })

  it('ChatView composer applies safe-area-inset-bottom exactly once', () => {
    const src = readWeb('src/ChatView.tsx')
    const matches = [...src.matchAll(/safe-area-inset-bottom/g)]
    expect(matches.length).toBe(1)
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
    // Applying the update must EVICT the SW + caches and hard-reload (forceReload),
    // NOT drive the workbox skipWaiting/controllerchange dance. That dance leaves an
    // uncontrolled tab — and iOS-standalone PWAs where controllerchange is unreliable —
    // on the stale precached shell, so it re-detects the "new version" and spins the
    // prompt on every reload. See UpdatePrompt.reload / version-guard.forceReload.
    expect(src).toContain('forceReload')
    expect(src).not.toContain('updateServiceWorker(true)')
  })

  it('AppShell always mounts the update prompt', () => {
    const src = readWeb('src/AppShell.tsx')
    expect(src).toContain('UpdatePrompt')
    expect(src).toContain('<UpdatePrompt')
  })

  it('the top-center Toaster offsets toasts below the iOS safe area so the prompt is tappable in standalone PWA mode', () => {
    const src = readWeb('src/AppShell.tsx')
    // Both desktop and mobile (<=600px) offsets must add the top inset; the
    // mobileOffset is the one that matters on the iPhone Dynamic Island.
    expect(src).toContain("offset={{ top: 'calc(env(safe-area-inset-top, 0px) + 24px)' }}")
    expect(src).toContain("mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}")
  })
})
