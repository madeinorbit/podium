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
 *     (`httpOrigin`) plus the page origin, which in the macOS shell is a
 *     different string (`tauri://localhost`) for the same Podium.
 *   - WHAT OPENING ONE MEANS. Issues and sessions are routes; artifacts and
 *     files are store actions, not routes. The app installs one activator that
 *     knows how to do all four; markdown click handlers and the offer renderer
 *     — neither of which can reach React state — call through it.
 */

import {
  type PodiumLink,
  type PodiumLinkOptions,
  type PodiumTarget,
  parsePodiumLink,
} from '@podium/protocol'

export const PODIUM_NATIVE_OPEN_EVENT = 'podium:native-open'

// --- Known origins ---------------------------------------------------------

let serverOrigins: readonly string[] = []

/**
 * Record the Podium server(s) this tab talks to. Called from the app root when
 * the client config resolves. Until it runs, only the page origin counts as
 * ours — the conservative direction: an unrecognised link opens externally,
 * which is what happens today, rather than being swallowed by an app that
 * cannot route it.
 */
export function setKnownPodiumOrigins(origins: Iterable<string>): void {
  serverOrigins = [...origins].filter(Boolean)
}

/** Every origin that is this Podium, page origin included. */
export function knownPodiumOrigins(): readonly string[] {
  const page = typeof window === 'undefined' ? [] : [window.location.origin]
  return [...serverOrigins, ...page]
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
  const link = classifyPodiumLink(href)
  return link?.kind === 'internal' ? link.target : null
}

/**
 * Capture a canonical target before the ordinary web router sees startup URL.
 * The router has no route for sessions, artifacts or files, and issue refs need
 * replica resolution before they can become the opaque id its route expects.
 * The host activates the base target and retains any query or fragment on the
 * routed URL.
 */
export function startupPodiumHref(location: {
  pathname: string
  search: string
  hash?: string
}): string | null {
  const href = `${location.pathname}${location.search}${location.hash ?? ''}`
  const link = parsePodiumLink(href)
  if (link?.kind !== 'internal' || link.target.kind === 'view') return null
  return href
}

/** Add typed-target detail to the route an activator just produced. The
 * router's own query stays first, so duplicate `wt` or `pane` keys cannot
 * replace the workspace it selected. */
export function appendPodiumAddressDetail(
  current: { pathname: string; search: string },
  detail: { search?: string; hash?: string },
): string | null {
  const extra = detail.search?.replace(/^\?/, '') ?? ''
  const hash = detail.hash ?? ''
  if (!extra && !hash) return null
  const separator = extra ? (current.search ? '&' : '?') : ''
  return `${current.pathname}${current.search}${separator}${extra}${hash}`
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
