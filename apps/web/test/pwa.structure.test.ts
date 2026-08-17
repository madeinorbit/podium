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
    expect(cfg).toContain('\x27/version\x27: { target: BACKEND')
    expect(cfg).toContain('\x27/podium-build.json\x27: { target: BACKEND')
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
    // `calc()` around it is allowed — the shell subtracts the height the
    // wire-skew banner reserves — but the viewport unit itself must stay dvh.
    expect(css).toMatch(/\.desktop-shell\s*\{[^}]*height:\s*(?:calc\([^;]*)?100dvh/)
    // Must NOT fall back to the 100% chain for desktop-shell height.
    expect(css).not.toMatch(/\.desktop-shell\s*\{[^}]*height:\s*(?:calc\([^;]*)?100%/)
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
  /**
   * The service-worker plumbing moved from `UpdatePrompt` into the update
   * surface's provider (POD-2102) — same wiring, one owner. What it asserts is
   * unchanged, because every line of it is still load-bearing: the library's
   * isUpdate-gated auto-reload no-ops on an uncontrolled normal-browser tab.
   *
   * IT MOVED AGAIN AND THIS GATE DID NOT (POD-2253). POD-2190 split the engine
   * out of `updates-context.tsx` so 99 KB would arrive after first paint, and
   * the plumbing went with it — leaving this case reading a file that no longer
   * contains a line of what it names. It has been failing ever since, which is
   * to say the ONE gate over the service-worker wiring could not have said no
   * about the wiring while the update it guards was stranding browsers. It reads
   * the engine now.
   */
  it('the update engine uses the SW registration to detect and apply new builds', () => {
    const src = readWeb('src/features/updates/UpdatesEngine.tsx')
    expect(src).toContain("from '@/app/pwa-register'")
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

  /**
   * The two switches that decide whether a new worker waits, and what it does
   * once it stops waiting (POD-2253). They are asserted as a PAIR because each
   * is only correct given the other: claiming without waiting would purge the
   * precache under a running tab, and waiting without claiming leaves the
   * authorised swap needing a second navigation to take effect.
   */
  it('the new worker waits to activate, then claims the clients it activates over', () => {
    const cfg = readWeb('vite.config.ts')
    expect(cfg).toContain('clientsClaim: true')
    expect(cfg).toContain("registerType: 'prompt'")
    expect(cfg).not.toContain('skipWaiting: true')
  })

  /**
   * A REFUSED FRAME IS EVIDENCE, NOT JUST NEWS (POD-2253).
   *
   * The transport telling the shell that this build could not read what the
   * server sent is the same tab losing the ability to be clicked. The banner is
   * the report; this is the remedy, and it must stay wired — an unwired guard is
   * how a tab came to sit dead until a service worker was cleared by hand.
   */
  it('runtime wire skew re-runs the version handshake, not only the banner', () => {
    const src = readWeb('src/app/AppShell.tsx')
    expect(src).toContain('recoverFromWireSkew')
    expect(src).toContain('onWireSkew')
  })

  it('the top-center Toaster offsets toasts below the iOS safe area so the prompt is tappable in standalone PWA mode', () => {
    const src = readWeb('src/app/AppShell.tsx')
    // Both desktop and mobile (<=600px) offsets must add the top inset; the
    // mobileOffset is the one that matters on the iPhone Dynamic Island. Both
    // also clear the command bar (POD-1159) — at the old flat 24px a two-line
    // toast was drawn straight across the bar's own controls.
    expect(src).toContain(
      "offset={{ top: 'calc(env(safe-area-inset-top, 0px) + var(--topbar-h) + 10px)' }}",
    )
    expect(src).toContain(
      "mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + var(--topbar-h) + 8px)' }}",
    )
  })
})
