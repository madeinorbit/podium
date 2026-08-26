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

// --- Activator registry ----------------------------------------------------

/** How a click modifier was held when a Podium link was activated. */
export interface PodiumLinkModifiers {
  /** Cmd (mac) or Ctrl — the reader asked for a new place, not this one. */
  direct: boolean
}

export type PodiumTargetActivator = (target: PodiumTarget, mods: PodiumLinkModifiers) => void

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

export function activatePodiumTarget(
  target: PodiumTarget,
  e: { metaKey?: boolean; ctrlKey?: boolean } = {},
): boolean {
  if (!activator) return false
  activator(target, { direct: Boolean(e.metaKey || e.ctrlKey) })
  return true
}
