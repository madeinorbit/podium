/**
 * THE FAMILIES ON THE SYNC WRITE ENTRY POINT (POD-6412, plan Task 16).
 *
 * The writes that are not queued by the apps, moved onto `sync.submit` one family
 * at a time through the sync family builder (`family.ts`). This file only composes
 * them, and names the set so a test can hold the composed registry equal to it.
 * The queued commands are `outbox-commands.ts`.
 */

import { AGENT_PROFILE_SYNC_FAMILY } from '../agent-profiles/sync-write'
import { CONVERSATION_SYNC_FAMILY } from '../conversations/sync-write'
import { READ_POSITION_SYNC_FAMILY } from '../read-position/sync-write'
import { registerSessionFamilyCommands } from '../sessions/sync-write'
import { registerSettingsWrite } from '../settings/sync-write'
import { registerSyncFamily, type SyncFamilyDeps } from './family'
import type { SyncWriteRegistry } from './registry'

/** Every command registered here, by wire name. */
export const FAMILY_COMMAND_NAMES = [
  'agentProfiles.create',
  'agentProfiles.update',
  'agentProfiles.delete',
  'agentProfiles.import',
  'conversations.setMeta',
  'readPosition.advance',
  'settings.updateInstance',
  // The session command plane's immediate writes (POD-6416).
  'sessions.setIssueId',
  'sessions.continue',
] as const

export function registerFamilyCommands(registry: SyncWriteRegistry, deps: SyncFamilyDeps): void {
  registerSyncFamily(registry, AGENT_PROFILE_SYNC_FAMILY, deps)
  registerSyncFamily(registry, CONVERSATION_SYNC_FAMILY, deps)
  registerSyncFamily(registry, READ_POSITION_SYNC_FAMILY, deps)
  // The settings family keeps its own registration: its gate and its trail.
  registerSettingsWrite(
    registry,
    { settings: () => deps.modules().settings, roleOf: deps.roleOf },
    'settings.updateInstance',
  )
  registerSessionFamilyCommands(registry, deps)
}
