// @vitest-environment node
// Reads source files off disk via import.meta.url — needs the real file URL,
// which happy-dom (this package's default test env) mangles. The repo-root
// config runs these in node; this matches it for the worktree-local config.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NAVIGATION_FALLBACK_DENYLIST } from '../mobile-routing'

const readWeb = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

describe('installable PWA wiring', () => {
  it('the service worker falls back to the shell but never shadows the live API/WS routes', () => {
    const cfg = readWeb('vite.config.ts')
    expect(cfg).toContain("navigateFallback: '/index.html'")
    expect(cfg).toContain('navigateFallbackDenylist: NAVIGATION_FALLBACK_DENYLIST')
    expect(cfg).toContain("'/mobile': { target: BACKEND")
    expect(cfg).toContain('mobileEntryRedirectPlugin()')
  })

  // Workbox tests the denylist against `pathname + search`, so these are the
  // exact strings the generated worker sees.
  const denied = (url: string) => NAVIGATION_FALLBACK_DENYLIST.some((re) => re.test(url))

  it('lets the root reach the server so the phone redirect can run [POD-359]', () => {
    // The regression: with `/` served from the precache, a phone that had ever
    // opened the desktop app never got the 302 to /mobile again.
    expect(denied('/')).toBe(true)
    expect(denied('/?server=wss://x')).toBe(true)
    expect(denied('/?desktop=1')).toBe(true)
    // /desktop is a server redirect too — the Expo app's escape hatch.
    expect(denied('/desktop')).toBe(true)
    expect(denied('/desktop?e2e=1')).toBe(true)
  })

  it('never shadows the backend routes or the Expo SPA', () => {
    for (const url of ['/trpc/x', '/health', '/mobile', '/mobile/session/s1', '/daemon', '/auth']) {
      expect(denied(url)).toBe(true)
    }
  })

  it('still falls back to the cached shell for SPA deep links', () => {
    for (const url of ['/workspace', '/session/s1', '/settings/machines', '/desktops']) {
      expect(denied(url)).toBe(false)
    }
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
    // (ChatView composer / SuperagentView composer), not on the shell wrapper.
    // If the shell added it too the inset would be double-counted.
    const desktopBlock = css.match(/\.desktop-shell\s*\{[^}]*\}/)?.[0] ?? ''
    expect(desktopBlock).not.toContain('safe-area-inset-bottom')
  })

  it('the chat composer applies safe-area-inset-bottom exactly once', () => {
    // The composer is its own component since POD-405; the inset lives with the
    // bottommost UI element, which is what this rule is actually about.
    const src = readWeb('src/features/chat/ChatComposer.tsx')
    const matches = [...src.matchAll(/safe-area-inset-bottom/g)]
    expect(matches.length).toBe(1)
  })
})

describe('update prompt', () => {
  it('UpdatePrompt uses the SW registration to detect and apply new builds', () => {
    const src = readWeb('src/app/UpdatePrompt.tsx')
    expect(src).toContain("from './pwa-register'")
    expect(readWeb('src/app/pwa-register.ts')).toContain("from 'virtual:pwa-register/react'")
    expect(src).toContain('useRegisterSW')
    expect(src).toContain('onRegisteredSW')
    expect(src).toContain('registration.update()')
    expect(src).toContain('visibilitychange')
    expect(src).toContain('updateServiceWorker(true)')
    // Reload must be driven by controllerchange, not the library's isUpdate-gated
    // auto-reload (which no-ops on uncontrolled normal-browser tabs).
    expect(src).toContain('controllerchange')
  })

  it('the top-center Toaster offsets toasts below the iOS safe area so the prompt is tappable in standalone PWA mode', () => {
    const src = readWeb('src/app/AppShell.tsx')
    // Both desktop and mobile (<=600px) offsets must add the top inset; the
    // mobileOffset is the one that matters on the iPhone Dynamic Island.
    expect(src).toContain("offset={{ top: 'calc(env(safe-area-inset-top, 0px) + 24px)' }}")
    expect(src).toContain("mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}")
  })
})
