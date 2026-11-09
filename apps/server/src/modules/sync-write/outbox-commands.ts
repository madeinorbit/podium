/**
 * THE OUTBOX COMMANDS ON THE SYNC WRITE ENTRY POINT (POD-6350, plan Task 10).
 *
 * Every command the apps' outbox queues (`OUTBOX_COMMANDS` in client-core's
 * `runtime-root/outbox/wiring.ts`) is registered on `sync.submit` here, by its family. The
 * families own their target resolvers and handlers; this file only composes
 * them, and names the set so a test can hold it equal to the client's table.
 */

import type { UserId, UserRole } from '@podium/model'
import type { RegistryModules } from '../../relay'
import { registerIssueCommands } from '../issues/sync-write'
import { registerLayoutCommands } from '../layout/sync-write'
import { registerSessionCommands } from '../sessions/sync-write'
import type { SyncWriteRegistry } from './registry'

/**
 * The 24 queued commands, by wire name. The client's table is the source; this
 * copy exists because the server does not depend on client-core, and
 * `outbox-commands.test.ts` holds the registry equal to it.
 */
export const OUTBOX_COMMAND_NAMES = [
  'layout.set',
  'layout.clear',
  'sessions.sendText',
  'sessions.resumeAndSend',
  'sessions.rename',
  'sessions.setArchived',
  'sessions.setWorkState',
  'snoozes.set',
  'snoozes.clear',
  'sessions.markRead',
  'sessions.markUnread',
  'sessions.dismissOffer',
  'issues.markRead',
  'issues.markUnread',
  'issues.setTucked',
  'issues.update',
  'issues.archive',
  'issues.delete',
  'issues.close',
  'issues.defer',
  'issues.undefer',
  'issues.setLabels',
  'issues.setPlacement',
  'issues.restore',
] as const

export interface OutboxCommandDeps {
  /** The composed modules, read per call: the handlers reach services that are
   *  composed after the entry point. */
  modules(): RegistryModules
  /** The account's role NOW (ADR 3 D16), for the role-floor families. */
  roleOf(user: UserId): Promise<UserRole | undefined>
}

export function registerOutboxCommands(registry: SyncWriteRegistry, deps: OutboxCommandDeps): void {
  registerLayoutCommands(registry, {
    layout: {
      set: async (...args) => await deps.modules().layout.set(...args),
      clear: async (...args) => await deps.modules().layout.clear(...args),
    },
    roleOf: deps.roleOf,
  })
  registerSessionCommands(registry, deps)
  registerIssueCommands(registry, deps)
}
