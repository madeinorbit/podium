/**
 * THE SOCKET WORKSPACE BINDING FOR TESTS (POD-7558). `attachWebSockets` requires
 * `bindWorkspace`: every upgrade is bound to one workspace, and a daemon's
 * relayed commands are stamped with it. These are the two bindings a test
 * means.
 */

import type { WorkspaceId } from '@podium/model'
import type { WsWorkspaceBinding } from '../gateway/ws-server'

/** Every upgrade bound to the registry's own workspace, as the edge binds it. */
export const bindToRegistry =
  (registry: { readonly sessionStore: { readonly workspaceId: WorkspaceId } }) =>
  async (): Promise<WsWorkspaceBinding> => ({ workspaceId: registry.sessionStore.workspaceId })

/** For a handler that is never asked to upgrade (timers, frame parsing). */
export const noUpgradeExpected = async (): Promise<WsWorkspaceBinding> => {
  throw new Error('this test does not upgrade a socket')
}
