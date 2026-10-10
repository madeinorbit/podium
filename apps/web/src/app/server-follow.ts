/**
 * HOW THE WEB APP FOLLOWS A MOVED SERVER (POD-5921).
 *
 * One {@link followHub} per runtime; this file only chooses the ports.
 *
 *  - A BROWSER TAB keeps the installation identity in memory — the page came
 *    from the server, so storing it would buy nothing — and moves by
 *    navigating to the same path at the new origin. Its session cookie is
 *    host-only and HttpOnly and does not follow: the person signs in there.
 *  - A DESKTOP WINDOW (the native bridge) does not navigate itself. A shell
 *    that can `moveServer` keeps the identity in its config and moves the
 *    window, carrying its session; an older shell only takes a transfer
 *    frame, exactly as before, and never asks Connect.
 */
import {
  browserFollowAdopt,
  type FollowPorts,
  type ServerIdentity,
} from '@podium/client-core/live-connection'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'

export interface WebFollowContext {
  bridge: NativeDesktopBridge | undefined
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'replace'>
  notify: (message: string) => void
}

export function webFollowPorts(context: WebFollowContext): FollowPorts {
  const adoptInBrowser = browserFollowAdopt({ location: context.location, notify: context.notify })
  if (context.bridge) {
    // An older shell: a transfer frame still navigates the window to the claim
    // page, as it always did. No identity, so no Connect lookup.
    return {
      loadIdentity: () => undefined,
      saveIdentity: () => {},
      adopt: async (move) => {
        if (move.via !== 'transfer') throw new Error('this desktop shell cannot follow its server')
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
