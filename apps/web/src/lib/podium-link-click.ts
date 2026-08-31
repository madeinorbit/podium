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

import { nativeDesktopBridge, openInSystemBrowser } from './nativeDesktop'
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

interface PodiumLinkAuxClickEvent {
  target: EventTarget | null
  button?: number
  preventDefault(): void
}

interface PodiumLinkContextMenuEvent {
  target: EventTarget | null
  preventDefault(): void
}

function closestAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  return (target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
}

function isPodiumLinkCandidate(anchor: HTMLAnchorElement): boolean {
  return (
    anchor.hasAttribute('data-podium-link-candidate') || anchor.hasAttribute('data-podium-link')
  )
}

/** The authored address survives canonicalization so hostless intent and raw
 * query bytes remain available when the app must fall back to a browser. */
function sourceHref(anchor: HTMLAnchorElement): string | null {
  return anchor.getAttribute('data-podium-link-source') ?? anchor.getAttribute('href')
}

/**
 * Answer a click if it landed on a link into this Podium. Returns whether the
 * click was claimed. Before returning false for a hostless Podium link, rewrite
 * the anchor to the active server so browser-default navigation stays on the
 * same replica as the app.
 */
export function handlePodiumLinkClick(e: PodiumLinkClickEvent): boolean {
  const anchor = closestAnchor(e.target)
  if (!anchor) return false
  // Late-mounted HTML may have been classified before httpOrigin existed. Fix
  // its href and stale target=_blank before either the app or browser answers.
  canonicalizePodiumAnchor(anchor)
  const href = sourceHref(anchor)
  if (!href) return false
  // CLASSIFIED AT CLICK TIME, not read off the render-time marking: the html may
  // have been produced before the client knew its own server origin, and the
  // string is memoized per message, so a body rendered during boot would keep
  // whatever verdict it got then.
  const target = internalPodiumTarget(href)
  const browserHref = systemBrowserPodiumHref(href)
  if (!target) {
    if (browserHref) anchor.setAttribute('href', browserHref)
    return false
  }

  if (e.metaKey || e.ctrlKey || e.shiftKey) {
    if (!browserHref) return false
    const handoff = openInSystemBrowser(browserHref)
    if (!handoff) {
      // A browser tab will perform the navigation itself. Give it the active
      // server's absolute address first: a relative href belongs to this
      // Podium, not necessarily to the origin that happened to serve the page.
      anchor.setAttribute('href', browserHref)
      return false
    }
    e.preventDefault()
    handoff.catch(() => {})
    return true
  }

  if (!activatePodiumTarget(target, e)) {
    if (browserHref) anchor.setAttribute('href', browserHref)
    return false
  }
  e.preventDefault()
  return true
}

/**
 * WKWebView does not turn a middle click into the ordinary `click` event above.
 * Hand that deliberate new-window gesture to the OS browser explicitly. A
 * normal browser gets null from `openInSystemBrowser` and keeps its default.
 */
export function handlePodiumLinkAuxClick(e: PodiumLinkAuxClickEvent): boolean {
  if (e.button !== 1) return false
  const anchor = closestAnchor(e.target)
  if (!anchor || !isPodiumLinkCandidate(anchor)) return false
  canonicalizePodiumAnchor(anchor)
  const href = sourceHref(anchor)
  if (!href) return false
  const browserHref = systemBrowserPodiumHref(href)
  if (!browserHref) return false
  const handoff = openInSystemBrowser(browserHref)
  if (!handoff) return false
  e.preventDefault()
  handoff.catch(() => {})
  return true
}

/**
 * WebKit exposes context-menu display, but not which native menu item the user
 * later chose. In a browser, canonicalizing here makes Open/Copy use the active
 * server. In the packaged shell, suppress the menu only for links the shared
 * resolver owns: otherwise its unobservable Open in New Tab action can be
 * swallowed by WKWebView. Ordinary and middle clicks remain supported.
 */
export function handlePodiumLinkContextMenu(e: PodiumLinkContextMenuEvent): boolean {
  const anchor = closestAnchor(e.target)
  if (!anchor || !isPodiumLinkCandidate(anchor)) return false
  canonicalizePodiumAnchor(anchor)
  const href = sourceHref(anchor)
  if (!href || !nativeDesktopBridge() || !systemBrowserPodiumHref(href)) return false
  e.preventDefault()
  return true
}
