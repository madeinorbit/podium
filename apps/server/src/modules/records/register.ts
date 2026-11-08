/**
 * EVERY GENERIC RECORD KIND ON THE SYNC WRITE ENTRY POINT (ADR 12 D3, POD-6391).
 *
 * One line per kind `@podium/commands` declares in `SYNCED_KINDS`;
 * `records.test.ts` holds the composed registry equal to the declared commands,
 * so a declared kind without an adapter fails there rather than as a client
 * write that `sync.submit` calls unknown.
 */

import type { RegistryModules } from '../../relay'
import type { SyncWriteRegistry } from '../sync-write/registry'
import { registerIssueRecord } from './issue-record'
import { registerIssueUserStateRecord } from './issue-user-state-record'
import { registerSessionLifecycleRecord } from './session-lifecycle-record'
import { registerSessionUserStateRecord } from './session-user-state-record'

export interface RecordCommandDeps {
  /** The composed modules, read per call (composed after the entry point). */
  modules(): RegistryModules
}

export function registerRecordCommands(registry: SyncWriteRegistry, deps: RecordCommandDeps): void {
  registerIssueRecord(registry, deps)
  registerSessionUserStateRecord(registry, deps)
  registerIssueUserStateRecord(registry, deps)
  registerSessionLifecycleRecord(registry, deps)
}
