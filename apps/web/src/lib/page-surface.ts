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
 * Five of six operations on the reference fleet ran on `desktop-remote`, and a
 * webview has no service worker — so four of the ten findings in the audit that
 * produced POD-3224 could not apply to them, and nobody could tell, because no
 * client log said which surface it was written from.
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
