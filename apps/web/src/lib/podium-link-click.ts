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
import { activatePodiumTarget, internalPodiumTarget } from './podium-link'

interface PodiumLinkClickEvent {
  target: EventTarget | null
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  preventDefault(): void
}

/**
 * Answer a click if it landed on a link into this Podium. Returns whether the
 * click was claimed; false means leave the anchor exactly as it was, which is a
 * real navigation and therefore still correct.
 */
export function handlePodiumLinkClick(e: PodiumLinkClickEvent): boolean {
  const anchor = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  const href = anchor?.getAttribute('href')
  if (!href) return false
  // CLASSIFIED AT CLICK TIME, not read off the render-time marking: the html may
  // have been produced before the client knew its own server origin, and the
  // string is memoized per message, so a body rendered during boot would keep
  // whatever verdict it got then.
  const target = internalPodiumTarget(href)
  if (!target) return false

  if (e.metaKey || e.ctrlKey || e.shiftKey) {
    const handoff = openInSystemBrowser(anchor?.href ?? href)
    if (!handoff) return false // a browser tab: the anchor already opens one
    e.preventDefault()
    handoff.catch(() => {})
    return true
  }

  if (!activatePodiumTarget(target, e)) return false
  e.preventDefault()
  return true
}
