/**
 * Podium addresses on the phone (POD-1606) — the counterpart of
 * apps/web/src/lib/podium-link.ts, over the same resolver in @podium/protocol.
 *
 * WHY THE PHONE NEEDS THIS AT ALL. A link in an offer or a transcript used to
 * pass one test — is the scheme http(s)/mailto/tel — and then went to
 * `Linking.openURL`, which hands it to Safari. So a link to the server this
 * phone is PAIRED WITH left the app for a browser that would then ask it to pair
 * again. The paired profiles are exactly the known-origins list the resolver
 * wants, which is why they are registered here.
 *
 * WHAT THE PHONE CAN OPEN. Issues and sessions on the active profile have
 * screens (app/issue/[issueId], app/session/[sessionId]); artifacts and files
 * do not. A target on a different paired profile is classified without losing
 * its matched origin, but POD-1837 owns switching profiles and retrying it.
 * Until then it falls back to that exact origin in the browser, never to the
 * active replica. An address the phone cannot show also falls back externally.
 */

import {
  canonicalPodiumOrigin,
  formatExternalHttpLink,
  formatPodiumLinkFallback,
  type PodiumLink,
  type PodiumTarget,
  parsePodiumLink,
} from '@podium/protocol'
import { Linking } from 'react-native'

export {
  findLinkedIssue,
  findLinkedSession,
  type LinkIssueLike,
  type LinkSessionLike,
  mobilePodiumRoute,
} from './podium-route'

/**
 * TWO SLOTS, NOT ONE LIST. The paired profiles and the active server are
 * written by two different components whose effects run in an order neither
 * controls — <PodiumLinkHost> is a descendant of <ServerProfileGate>, so the
 * child's write lands first and a single shared array would be flattened by the
 * parent's next write. That is not a rare race: the gate rewrites on every
 * pair, rename and purge, and the active server can come from
 * EXPO_PUBLIC_PODIUM_SERVER with no profile row at all — in which case the list
 * would be emptied for good and every link home would go to Safari, which is
 * the exact bug this module exists to fix. Keeping the sources apart and
 * unioning them at READ time makes the write order irrelevant.
 */
let pairedOrigins: readonly string[] = []
let activeOrigin: string | null = null

/** Record every paired server's origin. Called from the profile gate. */
export function setKnownPodiumOrigins(origins: Iterable<string>): void {
  pairedOrigins = [...origins].filter(Boolean)
}

/** Record the server this app is talking to right now. Owned by the link host. */
export function setActivePodiumOrigin(origin: string | null): void {
  activeOrigin = origin || null
}

export function knownPodiumOrigins(): readonly string[] {
  if (!activeOrigin) return pairedOrigins
  if (pairedOrigins.includes(activeOrigin)) return pairedOrigins
  return [...pairedOrigins, activeOrigin]
}

export function classifyPodiumLink(href: string): PodiumLink | null {
  return parsePodiumLink(href, { knownOrigins: knownPodiumOrigins() })
}

/** The target `href` names on a paired server, or null when it names elsewhere. */
export function internalPodiumTarget(href: string): PodiumTarget | null {
  const link = classifyPodiumLink(href)
  return link?.kind === 'internal' ? link.target : null
}

// --- Following a link ------------------------------------------------------

/**
 * Open a target. Installed once by <PodiumLinkHost> at the app root, which is
 * the only place that has both the router and the store; returns false when it
 * could not (a row this phone has not received, an address with no screen).
 *
 * A REGISTRY, NOT AN IMPORT. A transcript link and an offer link are rendered by
 * leaf components, and having those import the router — or the store hooks —
 * would drag expo-router and a composition root into the graph of anything that
 * renders them, which is exactly the shape the mobile unit lane warns about
 * (apps/mobile/vitest.config.ts). The web draws the same seam in
 * apps/web/src/lib/podium-link.ts.
 */
export type PodiumTargetActivator = (target: PodiumTarget) => boolean | Promise<boolean>

let activator: PodiumTargetActivator | null = null

export function setPodiumTargetActivator(fn: PodiumTargetActivator | null): void {
  activator = fn
}

/**
 * Follow one link the way the phone should: a Podium address on the ACTIVE
 * server opens a screen; everything else goes to the OS.
 *
 * A target this app cannot show — an artifact, a file, an issue that has not
 * arrived — falls back to the browser. A host-less address (`podium://…`, a
 * relative href) uses the active server for that fallback. An address on a
 * different paired server must never be resolved against the active replica:
 * refs are server-local and two servers can both have `POD-10`.
 */
export function followPodiumLink(href: string): void {
  const link = classifyPodiumLink(href)
  if (!link) return
  if (link.kind === 'internal') {
    const active = activeOrigin ? canonicalPodiumOrigin(activeOrigin) : null
    const addressesActiveServer =
      link.origin === null || (active !== null && link.origin === active)
    const fallbackOrigin = link.origin ?? activeOrigin
    const fallback = () => {
      if (fallbackOrigin)
        void Linking.openURL(formatPodiumLinkFallback(fallbackOrigin, href, link)).catch(() => {})
    }
    if (addressesActiveServer) {
      const answer = activator?.(link.target)
      if (answer === true) return
      if (answer instanceof Promise) {
        void answer.then((opened) => {
          if (!opened) fallback()
        }, fallback)
        return
      }
    }
    fallback()
    return
  }
  const externalHref = formatExternalHttpLink(link.href, activeOrigin) ?? link.href
  void Linking.openURL(externalHref).catch(() => {})
}
