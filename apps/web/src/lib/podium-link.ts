/**
 * Runtime glue for Podium addresses on the web (POD-1606) — the sibling of
 * ./ref-activation, and deliberately the same shape.
 *
 * Two things live here, both of which the pure resolver in @podium/protocol
 * cannot know:
 *
 *   - WHICH ORIGINS ARE US. The resolver takes them as an argument precisely so
 *     that no layer has to guess from `window.location`. This module holds the
 *     answer for this tab: the server the client is actually talking to
 *     (`httpOrigin`). The page origin is deliberately irrelevant: a browser
 *     tab can be served by A while `?server=` connects it to B, and refs are
 *     server-local.
 *   - WHAT OPENING ONE MEANS. Issues and sessions are routes; artifacts and
 *     files are store actions, not routes. The app installs one activator that
 *     knows how to do all four; markdown click handlers and the offer renderer
 *     — neither of which can reach React state — call through it.
 */

import {
  type PodiumLink,
  type PodiumLinkOptions,
  type PodiumTarget,
  formatExternalHttpLink,
  formatPodiumLinkFallback,
  parsePodiumLink,
  podiumTargetPath,
} from '@podium/protocol'

export const PODIUM_NATIVE_OPEN_EVENT = 'podium:native-open'

// --- Known origins ---------------------------------------------------------

let serverOrigins: readonly string[] = []

/**
 * Record the Podium server(s) this tab talks to. Called from the app root when
 * the client config resolves. Until it runs, no absolute origin counts as ours
 * — the conservative direction: an unrecognised link opens externally rather
 * than being swallowed by an app that cannot route it.
 */
export function setKnownPodiumOrigins(origins: Iterable<string>): void {
  serverOrigins = [...origins].filter(Boolean)
}

/** Every server origin this tab may resolve against. */
export function knownPodiumOrigins(): readonly string[] {
  return serverOrigins
}

export function podiumLinkOptions(): PodiumLinkOptions {
  return { knownOrigins: knownPodiumOrigins() }
}

/** Classify one href against the origins this tab knows. */
export function classifyPodiumLink(href: string): PodiumLink | null {
  return parsePodiumLink(href, podiumLinkOptions())
}

/** The target `href` names inside this Podium, or null when it names someone else's. */
export function internalPodiumTarget(href: string): PodiumTarget | null {
  if (hasServerSelector(href)) return null
  const link = classifyPodiumLink(href)
  return link?.kind === 'internal' ? link.target : null
}

/**
 * Capture a canonical target before the ordinary web router sees startup URL.
 * The router has no route for sessions, artifacts or files, and issue refs need
 * replica resolution before they can become the opaque id its route expects.
 * The host activates only targets it can represent losslessly. `server` is
 * boot configuration rather than target detail: capture strips it from the
 * pending address after the startup route preserves it for transport setup.
 */
export function startupPodiumHref(location: {
  pathname: string
  search: string
  hash?: string
}): string | null {
  const href = `${location.pathname}${location.search}${location.hash ?? ''}`
  const link = parsePodiumLink(href)
  if (link?.kind !== 'internal' || link.target.kind === 'view') return null
  const target = withoutStartupServer(link.target)
  if (hasUnsupportedTypedDetail(target)) return null
  return podiumTargetPath(target)
}

/** The router destination used while a typed startup URL waits for replica
 * rows. Keep the server override that selects the replica, but never leak file
 * address fields or unsupported target detail into the workspace route. */
export function startupPodiumRouteHref(location: { search: string }): string {
  const server = new URLSearchParams(location.search).get('server')
  if (!server) return '/workspace'
  const params = new URLSearchParams({ server })
  return `/workspace?${params.toString()}`
}

/** Query/fragment semantics belong to the opened target. This client has no
 * such consumers yet, so live activation must decline all of them. */
export function hasUnsupportedTypedDetail(target: PodiumTarget): boolean {
  if (target.kind === 'view') return Boolean(target.search || target.hash)
  if ('hash' in target && target.hash) return true
  return 'search' in target && Boolean(target.search)
}

/** Whether an href asks boot to connect to a different server. This is never
 * live target detail: resolving its ref against the current replica would open
 * the same-looking row on the wrong server. */
export function hasServerSelector(href: string): boolean {
  const query = href.indexOf('?')
  const fragment = href.indexOf('#')
  if (query === -1 || (fragment !== -1 && query > fragment)) return false
  const search = href.slice(query, fragment === -1 ? href.length : fragment)
  return new URLSearchParams(search).has('server')
}

function withoutStartupServer(target: PodiumTarget): PodiumTarget {
  if (!('search' in target) || !target.search) return target
  const params = new URLSearchParams(target.search)
  params.delete('server')
  const query = params.toString()
  return { ...target, search: query ? `?${query}` : '' }
}

/** Resolve a host-less internal address to the active HTTP server for an OS
 * browser handoff. Never derive it from the Tauri page origin. */
export function systemBrowserPodiumHref(href: string): string | null {
  const link = classifyPodiumLink(href)
  if (link?.kind !== 'internal') return null
  const serverOrigin = link.origin ?? serverOrigins[0]
  return serverOrigin ? formatPodiumLinkFallback(serverOrigin, href, link) : null
}

/** A safe external HTTP address for native middle/context actions. Protocol-
 * relative forms take only the active server's scheme, never its authority. */
export function systemBrowserExternalHref(href: string): string | null {
  const link = classifyPodiumLink(href)
  if (link?.kind !== 'external') return null
  return formatExternalHttpLink(link.href, serverOrigins[0])
}

/**
 * Rebase already-rendered Podium anchors after the active server becomes known.
 * Markdown can render during boot, before PodiumLinkHost registers httpOrigin,
 * and settled transcript HTML deliberately does not rerender afterward. A real
 * absolute href is required because browser middle-click, context-menu Open,
 * and Copy Link Address do not pass through the ordinary click resolver.
 */
export function canonicalizePodiumAnchors(root: ParentNode): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>(
    'a[data-podium-link-candidate][href], a[data-podium-link][href]',
  )) {
    canonicalizePodiumAnchor(anchor)
  }
}

/** Prepare the one anchor targeted by a browser action. */
export function canonicalizePodiumAnchor(target: EventTarget | null): void {
  const anchor = (target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  const isLinkRendererCandidate =
    anchor?.hasAttribute('data-podium-link-candidate') || anchor?.hasAttribute('data-podium-link')
  if (!isLinkRendererCandidate) return
  const href = anchor?.getAttribute('href')
  if (!anchor || !href) return
  const sourceHref = anchor.getAttribute('data-podium-link-source') ?? href
  const link = classifyPodiumLink(sourceHref)
  if (link?.kind !== 'internal') {
    const externalHref = systemBrowserExternalHref(sourceHref)
    if (externalHref) anchor.setAttribute('href', externalHref)
    // This candidate belonged to the previous active server. Restore the
    // renderer's external-link contract instead of navigating the current
    // tab or WebView away from the newly active replica.
    if (anchor.hasAttribute('data-podium-link')) {
      anchor.removeAttribute('data-podium-link')
      anchor.setAttribute('href', externalHref ?? sourceHref)
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noopener noreferrer')
    }
    return
  }
  const wasMarkedInternal = anchor.hasAttribute('data-podium-link')
  const browserHref = systemBrowserPodiumHref(sourceHref)
  if (browserHref) anchor.setAttribute('href', browserHref)
  anchor.setAttribute('data-podium-link', '')
  // An anchor rendered before httpOrigin was registered looked external and
  // therefore received target=_blank. Once its origin is known to be ours,
  // leaving that target in place makes WKWebView drop an activator fallback.
  if (!wasMarkedInternal && internalPodiumTarget(sourceHref)) {
    anchor.removeAttribute('target')
    anchor.removeAttribute('rel')
  }
}

// --- Activator registry ----------------------------------------------------

/** How a click modifier was held when a Podium link was activated. */
export interface PodiumLinkModifiers {
  /** Cmd (mac) or Ctrl — the reader asked for a new place, not this one. */
  direct: boolean
}

/**
 * Open a target. RETURNS WHETHER IT DID — not whether it was asked.
 *
 * The resolver deliberately answers null for a target this client cannot open:
 * an issue the replica has not received, an artifact id that is not on the
 * issue, a page this build does not route. A caller that cancels the anchor on
 * "an activator exists" turns every one of those into a click that does
 * nothing, which is strictly worse than the plain navigation it replaced.
 */
export type PodiumTargetActivator = (target: PodiumTarget, mods: PodiumLinkModifiers) => boolean

/** Inert until the app installs one: a link nobody can route stays a no-op
 *  rather than a navigation to a page that does not exist. */
let activator: PodiumTargetActivator | null = null

export function setPodiumTargetActivator(fn: PodiumTargetActivator | null): void {
  activator = fn
}

/** Whether anything is listening — the renderers ask before they claim a click. */
export function canActivatePodiumTargets(): boolean {
  return activator !== null
}

/** Whether the target was actually opened. False means: leave the anchor alone. */
export function activatePodiumTarget(
  target: PodiumTarget,
  e: { metaKey?: boolean; ctrlKey?: boolean } = {},
): boolean {
  if (!activator) return false
  return activator(target, { direct: Boolean(e.metaKey || e.ctrlKey) })
}

/** Classify and activate one raw address through the installed app resolver. */
export function activatePodiumHref(href: string): boolean {
  const target = internalPodiumTarget(href)
  return target ? activatePodiumTarget(target) : false
}
