import { nativeDesktopBridge } from '@/lib/nativeDesktop'

/**
 * WHICH SURFACE THIS PAGE IS — the first fact every other update line depends on.
 *
 * Structurally `UpdateSurface` from `features/updates/operation-view.ts`, which
 * is where the panel's copy is decided from it. It lives HERE because the boot
 * record needs it and `lib/` may not import a feature (features/README.md), and
 * because the answer is a property of the page rather than of the panel: it is
 * true before the update chunk has even been fetched.
 *
 * Five of six operations on the reference fleet ran on `desktop-remote`, and no
 * client log said so — which mattered because every service-worker explanation
 * for "Reload does nothing" turns on which surface was looking.
 *
 * NOT "the webview has no service worker". That claim is false and was believed
 * for a while: `~/.podium/logs/clients/desktop-*.ndjson` shows the macOS webview
 * ATTEMPTING a registration and failing it — 24 `Script …/sw.js load failed`
 * rejections across three Macs. So the API is present, the registration fails,
 * and no active worker is ever observed; why the script will not load is not
 * settled by any log that exists today, and `web:sw`'s registration line is what
 * will settle it. Recorded here because a comment asserting the stronger claim
 * is how it survived four review passes.
 */
export type PageSurface = 'web' | 'desktop-all-in-one' | 'desktop-remote' | 'mobile'

export function pageSurface(): PageSurface {
  const bridge = nativeDesktopBridge()
  if (!bridge) return window.location.pathname.startsWith('/mobile') ? 'mobile' : 'web'
  // launchMode is authoritative. Served-local all-in-one loads http://127.0.0.1
  // from the sidecar — that page origin must NOT be classified as desktop-remote.
  if (bridge.launchMode === 'all-in-one' || bridge.launchMode === 'server') {
    return 'desktop-all-in-one'
  }
  if (bridge.launchMode === 'daemon' || bridge.launchMode === 'client') {
    return 'desktop-remote'
  }
  // Older shells omit launchMode. Fall back to page origin: baked tauri:// is
  // local; any http(s) page on those shells was remote-only (pre-served-local).
  return window.location.protocol === 'tauri:' || window.location.hostname === 'tauri.localhost'
    ? 'desktop-all-in-one'
    : 'desktop-remote'
}
