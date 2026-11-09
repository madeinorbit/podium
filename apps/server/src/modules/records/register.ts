/**
 * EVERY GENERIC RECORD KIND ON THE SYNC WRITE ENTRY POINT (ADR 12 D3, POD-6391).
 *
 * One line per kind `@podium/commands` declares in `SYNCED_KINDS`;
 * `records.test.ts` holds the composed registry equal to the declared commands,
 * so a declared kind without an adapter fails there rather than as a client
 * write that `sync.submit` calls unknown.
 */

import { asSessionId, asUserId } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { SessionStore } from '../../store'
import { registerAgentProfileRecord } from '../agent-profiles/records'
import { registerSubscriptionRecord } from '../issues/subscription-record'
import { sessionStatePrincipalFor } from '../sessions/session-state/registry'
import { registerInstancePreferencesRecord } from '../settings/instance-record'
import { registerSuperagentThreadRecords } from '../superagent/thread-records'
import type { SyncWriteRegistry } from '../sync-write/registry'
import { registerUserRecords } from '../user-records/records'
import { registerWorkflowBindingRecord } from '../workflows/binding-record'
import { registerEffectRecord } from './effect-record'
import { registerIssueRecord } from './issue-record'
import { registerIssueUserStateRecord } from './issue-user-state-record'
import { registerSessionLifecycleRecord } from './session-lifecycle-record'
import { registerSessionUserStateRecord } from './session-user-state-record'

export interface RecordCommandDeps {
  /** The composed modules, read per call (composed after the entry point). */
  modules(): RegistryModules
  /** The store, read per call: pins and tab orders are its rows (POD-6673). */
  store(): Pick<SessionStore, 'sessions' | 'users' | 'superagent'>
}

export function registerRecordCommands(registry: SyncWriteRegistry, deps: RecordCommandDeps): void {
  registerIssueRecord(registry, deps)
  registerSessionUserStateRecord(registry, deps)
  registerIssueUserStateRecord(registry, deps)
  registerSessionLifecycleRecord(registry, deps)
  registerUserRecords(registry, {
    sessions: () => deps.store().sessions,
    settings: () => deps.modules().settings,
    readPositions: () => deps.modules().readPosition,
    roleOf: async (user) => await deps.store().users.roleOf(user),
    issueExists: async (issueId) => await deps.modules().issues.reports.has(issueId),
    issuePinChanged: async (userId, issueId, pinned) =>
      await deps.modules().issues.attention.recordIssuePin(issueId, userId, pinned),
    canReadSession: async (principal: CommandPrincipal, sessionId: string) =>
      principal.kind !== 'system' &&
      (await deps
        .modules()
        .sessions.state.canReadSession(
          sessionStatePrincipalFor(principal),
          asSessionId(sessionId),
        )),
  })
  registerEffectRecord(registry, deps)
  // Superagent threads (POD-6675): the owner's title, archive, model and effort.
  registerSuperagentThreadRecords(registry, {
    threads: () => deps.store().superagent,
    roleOf: async (user) => await deps.store().users.roleOf(user),
  })
  // Agent profiles, trigger subscriptions and workflow bindings (POD-6676).
  registerAgentProfileRecord(registry, deps)
  registerSubscriptionRecord(registry, {
    modules: deps.modules,
    sessionOwner: async (sessionId) =>
      (await deps.store().sessions.getSessions([sessionId])).get(sessionId)?.ownerUserId,
    issueOwner: async (issueId) =>
      (
        await deps
          .modules()
          .issues.reports.getMeta(issueId)
          .catch(() => null)
      )?.ownerUserId,
  })
  registerWorkflowBindingRecord(registry, {
    modules: deps.modules,
    roleOf: async (user) => await deps.store().users.roleOf(asUserId(user)),
  })
  // The instance settings (POD-6677): an admin's edits, leaf by leaf.
  registerInstancePreferencesRecord(registry, {
    settings: () => deps.modules().settings,
    roleOf: async (user) => await deps.store().users.roleOf(user),
  })
}
