import { reloadLog } from '@/lib/logging/update-logs'

/**
 * EVERY NAVIGATION THIS APP TRIGGERS ITSELF GOES THROUGH HERE (POD-3224).
 *
 * There are seven places in this bundle that can replace the document under the
 * user, and until now a reload was indistinguishable from the user pressing
 * ⌘R — the page simply ended. So "it reloaded and came straight back asking me
 * to reload" had no trace at all: nobody could say which of the seven fired, or
 * why, or whether a second one fired a moment later. The audit that produced
 * this issue had to reason about that from source rather than from evidence,
 * and got a different answer on each of its four passes.
 *
 * This is a LOGGING SEAM, not a policy one. It decides nothing: same call, same
 * `location.reload()`, same moment. What it adds is one forwarded line naming
 * the site and the reason immediately before the document goes away — and,
 * because the forwarding sink batches, that line is on its way out before the
 * navigation can cut it (the batch flush is armed at 5 s, but the next page's
 * boot record lands in the same file seconds later, so a lost line shows up as a
 * gap between a reason and a boot rather than as silence).
 *
 * The one behaviour it adds is the `catch`: `location.reload()` can throw in a
 * sandboxed or cross-origin-embedded frame, and a navigation that did NOT happen
 * used to look exactly like one that did.
 */
export type NavigationSite =
  /** `reload-handshake.ts` — a takeover was observed and the page follows it. */
  | 'handshake'
  /** `force-reload.ts` — caches and registrations evicted first. */
  | 'force-reload'
  /** `AppErrorPage.reloadApp` — the crash screen's own button, and the library's
   *  `onNeedReload`. */
  | 'app-error'
  /** `WireSkewBanner` — the server speaks a different wire version. */
  | 'wire-skew'
  /** `preload-error-recovery.ts` — a lazy chunk 404'd; the assets moved. */
  | 'preload-recovery'
  /** `restart-shell.ts` — the shell asked for its page back after a restart. */
  | 'restart-shell'
  /** `SetupView` — the setup flow's retry buttons. */
  | 'setup'
  /** `main.tsx` — the boot-failure notice's action. */
  | 'boot-notice'
  /** vite-plugin-pwa's own `controlling` listener, which reloads a tab whose
   *  worker was replaced from somewhere else. The app owns the call now only so
   *  that it can be SEEN; the navigation is the one the library always made. */
  | 'workbox-controlling'

interface ReloadWindow {
  location: { reload(): void }
}

/**
 * Reload the document, saying which site did it and why.
 *
 * `reason` is a short machine-readable phrase, not a sentence: it is grouped on
 * (`reason=no-replacement`), so it must be stable across builds. Anything that
 * varies per occurrence belongs in `fields`.
 */
export function navigateReload(
  site: NavigationSite,
  reason: string,
  fields: Record<string, unknown> = {},
  win: ReloadWindow = globalThis as unknown as ReloadWindow,
): void {
  reloadLog.info('reloading the page', { site, reason, ...fields })
  try {
    win.location.reload()
  } catch (err) {
    // A reload that could not happen is the failure most easily mistaken for a
    // reload that did: the page stays exactly as it was either way.
    reloadLog.error('the page could not be reloaded', { site, reason, ...fields, err })
  }
}
