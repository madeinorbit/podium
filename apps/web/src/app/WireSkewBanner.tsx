import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import {
  hasUpdatePanel,
  openUpdatePanel,
  subscribeUpdatePanel,
} from '@/features/updates/open-panel'
import { forceReload } from '@/lib/force-reload'
import { currentSkew, type SkewNotice, subscribeSkew } from './skew-notice'

/**
 * The height the app must keep clear, published for CSS to consume.
 *
 * The banner stays `position: fixed` — see the note below, it must not depend on
 * the shell laying out — so nothing reserves its space automatically and it
 * covered the command bar, the densest strip in the window. `#root` pads by this
 * and the viewport-height roots subtract it (`index.css`, `styles.css`), which
 * moves every root-level screen down rather than just the one that happens to be
 * mounted.
 *
 * MEASURED, not a constant: the message and its Reload button wrap to a second
 * line on a narrow window, and a hardcoded height would then clear too little
 * (still covering the bar) or too much (a stripe of dead space).
 */
export const SKEW_BANNER_HEIGHT_VAR = '--wire-skew-banner-h'

/** Exported for the test: what the app is told to keep clear, in `px`. */
export function skewBannerHeightValue(height: number): string {
  return `${Math.ceil(height)}px`
}

/**
 * THE VISIBLE SIGNAL (POD-1610).
 *
 * ---------------------------------------------------------------------------
 * WHY A BANNER AND NOT A TOAST
 * ---------------------------------------------------------------------------
 *
 * The repo already has a sonner toast for "new version available", and this was
 * nearly one too. It is not, for two reasons. A toast is dismissible and
 * transient, and this condition is neither: the build does not become able to
 * read the server by waiting. And a toast renders through the shared `<Toaster/>`
 * inside the shell — the same shell that, in the failure this exists for, was
 * rendering an empty board while the replica never arrived. A fixed element with
 * its own markup depends on nothing but React being mounted.
 *
 * This is the ONE compatibility banner. The server still grades the bundle for
 * its operator log, but does not turn that coarser build comparison into UI. The
 * HTML fallback has a different, narrower job: it says only that no app mounted.
 *
 * MOUNTED AT THE ROOT, outside the login and setup gates: the boot check raises
 * its notice before either resolves, and a banner mounted inside the shell shows
 * only on the screens the skew has not already prevented.
 *
 * NOT DISMISSIBLE, and that is a considered choice rather than an oversight. The
 * only honest actions are reload and rebuild; both are offered. A dismiss button
 * would let someone spend an afternoon debugging an app they have been told is
 * lying to them — which is precisely the afternoon POD-1608 spent.
 */
export function WireSkewBanner(): JSX.Element | null {
  const [notice, setNotice] = useState<SkewNotice | null>(() => currentSkew())
  useEffect(() => subscribeSkew(setNotice), [])

  // Label the button for what it will actually do. The panel mounts after this
  // banner in the failure this exists for, so the answer can change under it.
  const [panelAvailable, setPanelAvailable] = useState(() => hasUpdatePanel())
  useEffect(() => subscribeUpdatePanel(() => setPanelAvailable(hasUpdatePanel())), [])

  /**
   * Publish the height while mounted; take it back when the banner goes.
   *
   * A callback ref rather than an effect on `notice`, because the element only
   * exists on the render that shows it — and the space has to be reserved by the
   * time the browser paints, or the app visibly jumps.
   */
  const measure = useCallback((element: HTMLDivElement | null) => {
    const root = document.documentElement
    if (!element) {
      root.style.removeProperty(SKEW_BANNER_HEIGHT_VAR)
      return
    }
    const publish = () => {
      root.style.setProperty(
        SKEW_BANNER_HEIGHT_VAR,
        skewBannerHeightValue(element.getBoundingClientRect().height),
      )
    }
    publish()
    // The banner wraps as the window narrows, so its height is not fixed for the
    // life of the notice.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty(SKEW_BANNER_HEIGHT_VAR)
    }
  }, [])

  if (!notice) return null

  // `assets-replaced` means this page is controlled by a service worker/cache
  // for bytes the server has already replaced. A panel opener may still be
  // registered while its state is empty, so opening it is not a reliable
  // recovery path. This branch owns the one action that can guarantee the next
  // navigation fetches the server's current bundle.
  const staleAssets = notice.source === 'assets-replaced'

  return (
    <div
      ref={measure}
      role="alert"
      data-testid="wire-skew-banner"
      style={{
        position: 'fixed',
        insetInline: 0,
        top: 0,
        zIndex: 2147483647,
        display: 'flex',
        gap: '12px',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        background: notice.severe ? '#f5c518' : '#3a3a2a',
        color: notice.severe ? '#1a1a1a' : '#f5c518',
        padding: '10px 16px',
        font: '600 13px/1.5 ui-sans-serif, system-ui, sans-serif',
        boxShadow: '0 2px 8px rgba(0,0,0,.35)',
      }}
    >
      <span>{notice.message}</span>
      <button
        type="button"
        // The app's global pressable contract (index.css) — a button here is a
        // button anywhere, even in a banner that styles itself.
        data-pressable
        onClick={() => {
          if (staleAssets) {
            void forceReload()
            return
          }
          /**
           * For wire skew, the banner delegates to the panel's remedy (POD-2102,
           * spec §6.1). This button used to prescribe its own fix — a plain reload —
           * while the update panel, a few hundred pixels away, was recommending a
           * different one. The
           * banner stays as the last-resort backstop it was built to be, but
           * the remedy it points at is now the panel's, because the panel is
           * the thing that knows what state the update is actually in.
           *
           * If nothing is listening (the update panel has not mounted), fall
           * back to the reload it always did.
           */
          const opened = openUpdatePanel()
          if (!opened) window.location.reload()
        }}
        style={{
          border: '1px solid currentColor',
          borderRadius: '6px',
          padding: '2px 10px',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
        }}
      >
        {staleAssets ? 'Reload' : panelAvailable ? 'Show update' : 'Reload'}
      </button>
    </div>
  )
}
