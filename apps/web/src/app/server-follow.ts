/**
 * HOW THE WEB APP FOLLOWS A MOVED SERVER (POD-5921).
 *
 * One {@link followHub} per runtime; this file only chooses the ports.
 *
 *  - A BROWSER TAB keeps the installation identity in memory — the page came
 *    from the server, so storing it would buy nothing — and moves by
 *    navigating to the same path at the new origin. Its session cookie is
 *    host-only and HttpOnly and does not follow: the person signs in there.
 *  - A DESKTOP WINDOW on a remote server keeps the identity in the shell's
 *    config.json and moves through the shell (`moveServer`), which carries the
 *    session. A shell too old to move only takes a transfer frame, exactly as
 *    before, and never asks Connect.
 *  - A DESKTOP WINDOW WHOSE SERVER DID NOT ANSWER AT COLD START opens the
 *    bundled app with nothing to boot; {@link startBundledServerSearch} looks
 *    for the server — the stored address first, then Connect — and moves the
 *    window to whichever proves it holds the installation key.
 */
import {
  browserFollowAdopt,
  type FollowEvent,
  type FollowPorts,
  locateServer,
  proveServer,
  type ServerIdentity,
  ServerFollower,
  type ServerMove,
} from '@podium/client-core/live-connection'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'

export interface WebFollowContext {
  bridge: NativeDesktopBridge | undefined
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'replace'>
  notify: (message: string) => void
}

function desktopAdopt(
  moveServer: NonNullable<NativeDesktopBridge['moveServer']>,
  notify: (message: string) => void,
): (move: ServerMove) => Promise<void> {
  return async (move) => {
    notify(`Podium moved to ${new URL(move.origin).host}`)
    if (move.via === 'transfer') await moveServer(move.origin, move.transferId, move.claimToken)
    else await moveServer(move.origin)
  }
}

export function webFollowPorts(context: WebFollowContext): FollowPorts {
  const adoptInBrowser = browserFollowAdopt({ location: context.location, notify: context.notify })
  const bridge = context.bridge
  if (bridge?.moveServer) {
    let identity: ServerIdentity | undefined = bridge.serverIdentity ?? undefined
    return {
      loadIdentity: () => identity,
      saveIdentity: (next) => {
        if (
          identity?.installationId === next.installationId &&
          identity.installationPublicKey === next.installationPublicKey
        ) {
          return
        }
        identity = next
        void bridge.saveServerIdentity?.(next).catch(() => {
          // Kept in memory for this window; the next authenticated connect tries again.
        })
      },
      adopt: desktopAdopt(bridge.moveServer, context.notify),
    }
  }
  if (bridge) {
    // An older shell, or a local window: a transfer frame still navigates the window to
    // the claim page, as it always did. No identity, so no Connect lookup.
    return {
      loadIdentity: () => undefined,
      saveIdentity: () => {},
      adopt: async (move) => {
        if (move.via !== 'transfer') throw new Error('this desktop window cannot follow its server')
        await adoptInBrowser(move)
      },
    }
  }
  let identity: ServerIdentity | undefined
  return {
    loadIdentity: () => identity,
    saveIdentity: (next) => {
      identity = next
    },
    adopt: adoptInBrowser,
  }
}

/**
 * THE BUNDLED WINDOW'S SEARCH (POD-5921). Runs on the follower's schedule
 * until it finds the server: first the address the shell has stored (it may
 * simply have come back), then wherever Connect says it went — either only if
 * it proves it holds the stored installation key. Then the shell moves the
 * window there. Returns the stop function.
 */
export function startBundledServerSearch(opts: {
  serverUrl: string
  identity: ServerIdentity
  moveServer: NonNullable<NativeDesktopBridge['moveServer']>
  connectBaseUrl: string
  log?: (event: FollowEvent) => void
  locate?: typeof locateServer
  prove?: typeof proveServer
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  random?: () => number
}): () => void {
  const stored = new URL(opts.serverUrl)
  stored.protocol = stored.protocol === 'ws:' ? 'http:' : stored.protocol === 'wss:' ? 'https:' : stored.protocol
  const storedOrigin = stored.origin
  const locate = opts.locate ?? locateServer
  const prove = opts.prove ?? proveServer
  const follower = new ServerFollower({
    identity: () => opts.identity,
    // The bundled document is not on any server, so the stored address is a
    // candidate like the rest — never "the origin we are already on".
    currentOrigin: () => 'tauri://localhost',
    connectBaseUrl: () => opts.connectBaseUrl,
    adopt: async (move) => {
      await opts.moveServer(move.origin)
    },
    locate: async (args) => {
      if (args.identity && (await prove({ origin: storedOrigin, identity: args.identity })).ok) {
        return storedOrigin
      }
      return locate({ ...args, currentOrigin: storedOrigin })
    },
    ...(opts.setTimeout ? { setTimeout: opts.setTimeout } : {}),
    ...(opts.clearTimeout ? { clearTimeout: opts.clearTimeout } : {}),
    ...(opts.random ? { random: opts.random } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  })
  follower.disconnected()
  return () => follower.dispose()
}
