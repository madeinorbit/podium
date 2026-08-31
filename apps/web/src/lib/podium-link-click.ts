/**
 * The one place a click on a Podium address is answered (POD-1606).
 *
 * Rendered markdown reaches the DOM in two pipelines — the transcript's
 * (lib/markdown.ts) and the file/artifact preview's (features/files/
 * markdown-blocks.ts) — and both mark internal anchors the same way. Only the
 * transcript used to intercept them, so the same link that opened in place in
 * chat did a full-page navigation out of a preview. One helper, called from
 * both, is what keeps that from happening again.
 *
 * A HELD MODIFIER MEANS "SOMEWHERE ELSE". In a browser tab the anchor already
 * does that, so this declines. In the desktop shell it does NOT: an internal
 * anchor carries no `target="_blank"` — that is the point — and the injected
 * shim now deliberately leaves our own origins alone, so a Cmd-click would
 * reach WKWebView as a new-window request and be silently dropped. There the
 * OS browser is the honest answer, and the same one the reader used to get.
 */

import { openInSystemBrowser } from './nativeDesktop'
import {
  activatePodiumTarget,
  canonicalizePodiumAnchor,
  internalPodiumTarget,
  systemBrowserPodiumHref,
} from './podium-link'

interface PodiumLinkClickEvent {
  target: EventTarget | null
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  preventDefault(): void
}

/**
 * Answer a click if it landed on a link into this Podium. Returns whether the
 * click was claimed. Before returning false for a hostless Podium link, rewrite
 * the anchor to the active server so browser-default navigation stays on the
 * same replica as the app.
 */
export function handlePodiumLinkClick(e: PodiumLinkClickEvent): boolean {
  const anchor = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchor) return false
  // Late-mounted HTML may have been classified before httpOrigin existed. Fix
  // its href and stale target=_blank before either the app or browser answers.
  canonicalizePodiumAnchor(anchor)
  const href = anchor.getAttribute('href')
  if (!href) return false
  // CLASSIFIED AT CLICK TIME, not read off the render-time marking: the html may
  // have been produced before the client knew its own server origin, and the
  // string is memoized per message, so a body rendered during boot would keep
  // whatever verdict it got then.
  const target = internalPodiumTarget(href)
  const browserHref = systemBrowserPodiumHref(href)
  if (!target) {
    if (browserHref) anchor.href = browserHref
    return false
  }

  if (e.metaKey || e.ctrlKey || e.shiftKey) {
    if (!browserHref) return false
    const handoff = openInSystemBrowser(browserHref)
    if (!handoff) {
      // A browser tab will perform the navigation itself. Give it the active
      // server's absolute address first: a relative href belongs to this
      // Podium, not necessarily to the origin that happened to serve the page.
      anchor.href = browserHref
      return false
    }
    e.preventDefault()
    handoff.catch(() => {})
    return true
  }

  if (!activatePodiumTarget(target, e)) {
    if (browserHref) anchor.href = browserHref
    return false
  }
  e.preventDefault()
  return true
}
