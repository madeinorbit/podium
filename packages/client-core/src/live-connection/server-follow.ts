/**
 * EVERY CLIENT FOLLOWS ITS SERVER THE SAME WAY (POD-5921).
 *
 * `followHub` wires one {@link SocketHub} to one {@link ServerFollower}:
 *
 *  - the link LOST (a failed dial — the first one included — or a socket that
 *    closed on its own) → `disconnected()`: locate through Connect on the
 *    shared schedule, adopt only a candidate that proves the stored key;
 *  - the link WELCOMED (the server accepted this client) → `connected()`, and
 *    the identity of the server just authenticated to is read from its
 *    `/version` and saved — logging in is the trust event (spec rule 1), so a
 *    server reinstalled at the same address is re-learned on the next login;
 *  - a TRANSFER frame over the live socket → `pushed()`: adopted at once, no
 *    proof, because the authenticated server itself announced it (§7.0).
 *
 * Platforms differ only in their {@link FollowPorts}: where the identity is
 * kept, and what moving means (a page navigation in a browser, a profile move
 * on a phone, a bridge command on the desktop).
 *
 * Its own subpath (`@podium/client-core/server-follow`), not part of the
 * live-connection barrel: the web app loads it lazily, so the follower, the
 * Connect read and the proof never weigh on the startup bundle.
 */
import {
  type FollowEvent,
  fetchAdvertisedIdentity,
  httpOriginOf,
  locateServer,
  proveServer,
  ServerFollower,
  type ServerIdentity,
  type ServerMove,
} from '@podium/runtime/server-follow'
import type { HubEvents } from '../socket-transport/socket-hub'

export type { FollowEvent, ServerIdentity, ServerMove }
/** Re-exported for a client's ask at a failed cold start, where no hub runs yet (spec rule 4). */
export { locateServer, proveServer, ServerFollower }
export { browserFollowAdopt, type BrowserFollowOptions } from './relocation'

export interface FollowPorts {
  loadIdentity(): ServerIdentity | undefined
  saveIdentity(identity: ServerIdentity): void
  /** The ONE way this client moves. Throwing means "not moved": the follower keeps looking. */
  adopt(move: ServerMove): Promise<void>
}

/** The slice of {@link SocketHub} following needs; a fake in tests. */
export interface FollowableHub {
  readonly url: string
  on(kind: 'link', handler: (...payload: HubEvents['link']) => void): () => void
  on(
    kind: 'serverRelocation',
    handler: (...payload: HubEvents['serverRelocation']) => void,
  ): () => void
}

export interface FollowHubOptions {
  /** Read per locate, so a configuration change lands without a reload. */
  connectBaseUrl: () => string
  fetch?: typeof fetch
  log?: (event: FollowEvent) => void
  /** Injectable for tests. */
  locate?: typeof locateServer
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  random?: () => number
}

/** Starts following; returns the stop function. */
export function followHub(
  hub: FollowableHub,
  ports: FollowPorts,
  opts: FollowHubOptions,
): () => void {
  const currentOrigin = () => httpOriginOf(hub.url) ?? hub.url
  const follower = new ServerFollower({
    identity: () => ports.loadIdentity(),
    currentOrigin,
    connectBaseUrl: opts.connectBaseUrl,
    adopt: (move) => ports.adopt(move),
    ...(opts.locate ? { locate: opts.locate } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.setTimeout ? { setTimeout: opts.setTimeout } : {}),
    ...(opts.clearTimeout ? { clearTimeout: opts.clearTimeout } : {}),
    ...(opts.random ? { random: opts.random } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  })
  let stopped = false
  /** One capture per welcome; a later welcome supersedes an earlier read. */
  let capture = 0

  const learnIdentity = (): void => {
    const origin = currentOrigin()
    const mine = ++capture
    void fetchAdvertisedIdentity({
      serverUrl: origin,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    })
      .then((identity) => {
        if (stopped || mine !== capture || identity === undefined) return
        // The socket may have moved while /version was in flight.
        if (currentOrigin() !== origin) return
        ports.saveIdentity(identity)
      })
      .catch(() => {
        // Learning is best-effort: no identity simply means no following yet.
      })
  }

  const offLink = hub.on('link', (state) => {
    if (stopped) return
    if (state === 'welcomed') {
      follower.connected()
      learnIdentity()
    } else {
      follower.disconnected()
    }
  })
  const offRelocation = hub.on('serverRelocation', (move) => {
    if (stopped) return
    follower.pushed({
      via: 'transfer',
      origin: move.publicUrl,
      transferId: move.transferId,
      ...(move.claimToken ? { claimToken: move.claimToken } : {}),
    })
  })

  return () => {
    stopped = true
    offLink()
    offRelocation()
    follower.dispose()
  }
}
