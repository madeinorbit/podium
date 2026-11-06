/**
 * THE FAMILIES ON THE SYNC WRITE ENTRY POINT (POD-6412, plan Task 16).
 *
 * The writes that are not queued by the apps, moved onto `sync.submit` one family
 * at a time through the sync family builder (`family.ts`). This file only composes
 * them, and names the set so a test can hold the composed registry equal to it.
 * The queued commands are `outbox-commands.ts`.
 */

import { AGENT_PROFILE_SYNC_FAMILY } from '../agent-profiles/sync-write'
import { APPROVAL_SYNC_FAMILY } from '../approvals/sync-write'
import { AUTOMATION_SYNC_FAMILY } from '../automations/sync-write'
import { CONVERSATION_SYNC_FAMILY } from '../conversations/sync-write'
import { FLEET_SYNC_COMMANDS, type FleetSyncDeps, registerFleetCommands } from '../fleet/sync-write'
import {
  MAIL_AWAIT_OBSERVED,
  MAIL_SYNC_COMMANDS,
  MAIL_SYNC_FAMILY,
  registerMailAwaitObserved,
} from '../messages/sync-write'
import { READ_POSITION_SYNC_FAMILY } from '../read-position/sync-write'
import { OFFER_SYNC_COMMANDS, registerOfferCommands } from '../sessions/offer-sync-write'
import { registerSessionFamilyCommands } from '../sessions/sync-write'
import { registerSettingsWrite } from '../settings/sync-write'
import { registerShellCommands, SHELL_SYNC_COMMANDS } from '../shells/sync-write'
import { SUPERAGENT_SYNC_FAMILY } from '../superagent/sync-write'
import { WORKFLOW_SYNC_FAMILY } from '../workflows/sync-write'
import { registerSyncFamily, type SyncFamilyDeps } from './family'
import type { SyncWriteRegistry } from './registry'

/** Every command registered here, by wire name. */
export const FAMILY_COMMAND_NAMES = [
  'agentProfiles.create',
  'agentProfiles.update',
  'agentProfiles.delete',
  'agentProfiles.import',
  // The approval decisions (POD-6415).
  'approvals.approve',
  'approvals.deny',
  'automations.create',
  'automations.update',
  'automations.setEnabled',
  'automations.remove',
  'conversations.setMeta',
  'readPosition.advance',
  'settings.updateInstance',
  // The session command plane's immediate writes (POD-6416).
  'sessions.setIssueId',
  'sessions.continue',
  'workflows.create',
  'workflows.revise',
  'workflows.fork',
  'workflows.publish',
  'workflows.assign',
  'workflows.checkpoint',
  'workflows.assignStep',
  'workflows.skip',
  'workflows.retry',
  'workflows.adopt',
  // The machine and repository writes (POD-6417).
  ...FLEET_SYNC_COMMANDS,
  // The superagent's thread writes (POD-6419).
  'superagent.sendTurn',
  'superagent.interruptTurn',
  'superagent.openInTerminal',
  'superagent.clear',
  'superagent.restart',
  'superagent.ensureSession',
  'superagent.startBtw',
  'superagent.concierge',
  // An agent's action offer, on its own session (POD-6419).
  ...OFFER_SYNC_COMMANDS,
  // The dock shell for a worktree; its start is an effect record (POD-6419).
  ...SHELL_SYNC_COMMANDS,
  // Agent mail, and the claim an agent's await retires (POD-6525).
  ...MAIL_SYNC_COMMANDS,
  MAIL_AWAIT_OBSERVED,
] as const

/** What the families need beyond the shared deps. */
export interface FamilyCommandDeps extends SyncFamilyDeps {
  readonly fleet: Omit<FleetSyncDeps, 'modules' | 'roleOf'>
}

export function registerFamilyCommands(registry: SyncWriteRegistry, deps: FamilyCommandDeps): void {
  registerSyncFamily(registry, AGENT_PROFILE_SYNC_FAMILY, deps)
  registerSyncFamily(registry, APPROVAL_SYNC_FAMILY, deps)
  registerSyncFamily(registry, AUTOMATION_SYNC_FAMILY, deps)
  registerSyncFamily(registry, WORKFLOW_SYNC_FAMILY, deps)
  registerSyncFamily(registry, CONVERSATION_SYNC_FAMILY, deps)
  registerSyncFamily(registry, READ_POSITION_SYNC_FAMILY, deps)
  registerSyncFamily(registry, SUPERAGENT_SYNC_FAMILY, deps)
  registerSyncFamily(registry, MAIL_SYNC_FAMILY, deps)
  registerMailAwaitObserved(registry, deps)
  // The settings family keeps its own registration: its gate and its trail.
  registerSettingsWrite(
    registry,
    { settings: () => deps.modules().settings, roleOf: deps.roleOf },
    'settings.updateInstance',
  )
  registerSessionFamilyCommands(registry, deps)
  registerOfferCommands(registry, deps)
  registerShellCommands(registry, deps)
  registerFleetCommands(registry, { ...deps.fleet, modules: deps.modules, roleOf: deps.roleOf })
}
