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
  it('the service worker falls back to the shell but never shadows the live API/WS routes', () => {
    const cfg = readWeb('vite.config.ts')
    expect(cfg).toContain("navigateFallback: '/index.html'")
    expect(cfg).toContain('navigateFallbackDenylist')
    expect(cfg).toContain('/^\\/mobile/')
    expect(cfg).toContain('/^\\/trpc/')
    expect(cfg).toContain('/^\\/daemon/')
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
    const src = readWeb('src/features/chat/ChatView.tsx')
    const matches = [...src.matchAll(/safe-area-inset-bottom/g)]
    expect(matches.length).toBe(1)
  })
})

describe('update prompt', () => {
  it('UpdatePrompt uses the SW registration to detect and apply new builds', () => {
    const src = readWeb('src/app/UpdatePrompt.tsx')
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

  it('the top-center Toaster offsets toasts below the iOS safe area so the prompt is tappable in standalone PWA mode', () => {
    const src = readWeb('src/app/AppShell.tsx')
    // Both desktop and mobile (<=600px) offsets must add the top inset; the
    // mobileOffset is the one that matters on the iPhone Dynamic Island.
    expect(src).toContain("offset={{ top: 'calc(env(safe-area-inset-top, 0px) + 24px)' }}")
    expect(src).toContain("mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}")
  })
})
